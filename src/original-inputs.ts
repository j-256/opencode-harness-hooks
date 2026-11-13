import { HostHookError } from './host-errors.js'
import { SESSION_SNAPSHOT_VERSION, sessionSnapshot, snapshotCopy, snapshotID, snapshotObject } from './session-snapshot.js'
import type { SessionSnapshot } from './sessions.js'
import type { JsonValue } from './types.js'

const SNAPSHOT_KIND = 'original-inputs'
export interface OriginalInput { readonly tool: string; readonly input: Readonly<Record<string, JsonValue>> }
interface Call extends OriginalInput { readonly turnID: string; readonly callID: string; readonly bytes: number }
interface State { readonly signal: AbortSignal; readonly calls: Map<string, Call>; readonly cleanup: () => void }
interface Options { readonly maxCalls: number; readonly maxBytes: number; readonly limitCode: string; readonly bytesCode: string; readonly reusedCode: string }
const key = (turnID: string, callID: string) => JSON.stringify([turnID, callID])
function fail(code: string): never { throw new HostHookError(code, 'unsupported') }

export class OriginalInputs {
  private readonly sessions = new Map<string, State>()
  private calls = 0
  private bytes = 0
  private disposed = false
  constructor(private readonly options: Options) { this.options = { ...options } }

  remember(session: SessionSnapshot, callID: string, tool: string, input: Readonly<Record<string, JsonValue>>): void {
    if (this.disposed || session.signal.aborted || session.turnSignal.aborted) throw new HostHookError('SESSION_SNAPSHOT_CANCELLED', 'cancelled')
    if (!snapshotID(session.turnID) || !snapshotID(callID) || !snapshotID(tool)) fail('SESSION_SNAPSHOT_OWNER_MISMATCH')
    const value = snapshotCopy({ tool, input }), previous = this.get(session.sessionID, session.turnID, callID)
    if (!value.input || typeof value.input !== 'object' || Array.isArray(value.input)) fail('SESSION_SNAPSHOT_SCHEMA_INVALID')
    const state = this.sessions.get(session.sessionID)
    if (state && state.signal !== session.signal) fail('SESSION_SNAPSHOT_OWNER_MISMATCH')
    if (previous) { if (JSON.stringify(previous) !== JSON.stringify(value)) fail(this.options.reusedCode); return }
    const bytes = this.charge(session.sessionID, session.turnID, callID, value)
    if (this.calls >= this.options.maxCalls) fail(this.options.limitCode)
    if (this.bytes + bytes > this.options.maxBytes) fail(this.options.bytesCode)
    const owner = state ?? this.create(session)
    owner.calls.set(key(session.turnID, callID), { ...value, turnID: session.turnID, callID, bytes }); this.calls++; this.bytes += bytes
  }

  get(sessionID: string, turnID: string, callID: string): OriginalInput | undefined {
    const call = this.sessions.get(sessionID)?.calls.get(key(turnID, callID))
    return call ? { tool: call.tool, input: call.input } : undefined
  }

  snapshot(sessionID: string) {
    return snapshotCopy({ kind: SNAPSHOT_KIND, version: SESSION_SNAPSHOT_VERSION, sessionID, calls: [...(this.sessions.get(sessionID)?.calls.values() ?? [])].map(({ turnID, callID, tool, input }) => ({ turnID, callID, tool, input })) })
  }

  restore(session: SessionSnapshot, value: unknown): () => void {
    const input = sessionSnapshot(SNAPSHOT_KIND, value, session, ['calls'])
    if (this.disposed) throw new HostHookError('SESSION_SNAPSHOT_CANCELLED', 'cancelled')
    if (this.sessions.has(session.sessionID)) fail('SESSION_SNAPSHOT_STATE_CONFLICT')
    if (!Array.isArray(input.calls)) fail('SESSION_SNAPSHOT_SCHEMA_INVALID')
    const calls = new Map<string, Call>(); let bytes = 0
    for (const raw of input.calls) {
      const row = snapshotObject(raw, ['turnID', 'callID', 'tool', 'input'])
      if (!snapshotID(row.turnID) || !snapshotID(row.callID) || !snapshotID(row.tool) || !row.input || typeof row.input !== 'object' || Array.isArray(row.input) || calls.has(key(row.turnID, row.callID))) fail('SESSION_SNAPSHOT_SCHEMA_INVALID')
      const original: OriginalInput = { tool: row.tool, input: row.input as Readonly<Record<string, JsonValue>> }, charge = this.charge(session.sessionID, row.turnID, row.callID, original)
      calls.set(key(row.turnID, row.callID), { ...original, turnID: row.turnID, callID: row.callID, bytes: charge }); bytes += charge
    }
    if (this.calls + calls.size > this.options.maxCalls) fail(this.options.limitCode)
    if (this.bytes + bytes > this.options.maxBytes) fail(this.options.bytesCode)
    if (!calls.size) return () => {}
    const state = this.create(session)
    for (const [id, call] of calls) state.calls.set(id, call)
    this.calls += calls.size; this.bytes += bytes
    return () => { if (this.sessions.get(session.sessionID) === state) state.cleanup() }
  }

  dispose(): void { this.disposed = true; for (const state of this.sessions.values()) state.cleanup() }
  inspect() { return { calls: this.calls, bytes: this.bytes } }
  private charge(sessionID: string, turnID: string, callID: string, value: OriginalInput): number { return Buffer.byteLength(JSON.stringify([sessionID, turnID, callID])) + Buffer.byteLength(JSON.stringify(value)) }
  private create(session: SessionSnapshot): State {
    const cleanup = () => {
      const state = this.sessions.get(session.sessionID)
      if (!state) return
      for (const call of state.calls.values()) { this.calls--; this.bytes -= call.bytes }
      this.sessions.delete(session.sessionID); session.signal.removeEventListener('abort', cleanup)
    }
    const state: State = { signal: session.signal, calls: new Map(), cleanup }
    this.sessions.set(session.sessionID, state); session.signal.addEventListener('abort', cleanup, { once: true })
    return state
  }
}
