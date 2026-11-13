import { randomUUID } from 'node:crypto'
import { HostHookError } from './host-errors.js'
import type { SessionSnapshot } from './sessions.js'
import { SESSION_SNAPSHOT_VERSION, sessionSnapshot, snapshotCopy, snapshotID, snapshotObject } from './session-snapshot.js'

const MAX_SESSIONS = 1024
const MAX_TURNS = 10000
const MAX_BYTES = 8 * 1024 * 1024
const MAX_YEAR = 9999
const SNAPSHOT_KIND = 'model-context'
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
export interface ModelDate { readonly id: string; readonly date: string; readonly created: number }
export interface ModelContextSnapshot { readonly kind: typeof SNAPSHOT_KIND; readonly version: typeof SESSION_SNAPSHOT_VERSION; readonly sessionID: string; readonly date: string | null; readonly lastTurnID: string | null; readonly turns: readonly { readonly turnID: string; readonly date: ModelDate | null }[] }
interface Receipt { readonly date: ModelDate | null; readonly bytes: number }
interface State { readonly signal: AbortSignal; readonly turns: Map<string, Receipt>; readonly cleanup: () => void; date?: string; lastTurnID?: string }
function fail(code: string): never { throw new HostHookError(code, code === 'TRANSCRIPT_MODEL_CANCELLED' ? 'cancelled' : 'unsupported') }

export class ModelContext {
  private readonly states = new Map<string, State>()
  private turns = 0
  private dates = 0
  private bytes = 0
  private disposed = false

  constructor(private readonly now: () => number = Date.now) {}

  observe(session: SessionSnapshot): void {
    if (this.disposed || session.signal.aborted || session.turnSignal.aborted) fail('TRANSCRIPT_MODEL_CANCELLED')
    if (!session.turnID) fail('TRANSCRIPT_MODEL_CONTEXT_UNAVAILABLE')
    let state = this.states.get(session.sessionID)
    if (state && state.signal !== session.signal) fail('TRANSCRIPT_SESSION_MISMATCH')
    let created: number
    try { created = this.now() } catch { return fail('TRANSCRIPT_MODEL_CLOCK_UNAVAILABLE') }
    if (this.disposed || session.signal.aborted || session.turnSignal.aborted) fail('TRANSCRIPT_MODEL_CANCELLED')
    const time = new Date(created)
    if (!Number.isFinite(created) || Number.isNaN(time.getTime()) || time.getFullYear() < 0 || time.getFullYear() > MAX_YEAR) fail('TRANSCRIPT_MODEL_CLOCK_UNAVAILABLE')
    const date = [String(time.getFullYear()).padStart(4, '0'), String(time.getMonth() + 1).padStart(2, '0'), String(time.getDate()).padStart(2, '0')].join('-')
    if (state?.turns.has(session.turnID)) {
      if (state.lastTurnID !== session.turnID) fail('TRANSCRIPT_MODEL_TURN_REUSED')
      if (state.date !== date) fail('TRANSCRIPT_DATE_BOUNDARY_UNVERIFIED')
      return
    }
    const attachment = state?.date === date ? null : Object.freeze({ id: randomUUID(), date, created })
    const bytes = Buffer.byteLength(JSON.stringify([session.sessionID, session.turnID, attachment]))
    if (this.turns >= MAX_TURNS || this.bytes + bytes > MAX_BYTES || !state && this.states.size >= MAX_SESSIONS) fail('TRANSCRIPT_MODEL_LIMIT')
    state ??= this.createState(session)
    state.turns.set(session.turnID, { date: attachment, bytes })
    state.lastTurnID = session.turnID
    state.date = date
    this.turns++
    this.bytes += bytes
    if (attachment) this.dates++
  }

  read(sessionID: string, turnID: string, required: boolean): ModelDate | undefined {
    const receipt = this.states.get(sessionID)?.turns.get(turnID)
    if (!receipt && required) fail('TRANSCRIPT_MODEL_CONTEXT_UNAVAILABLE')
    return receipt?.date ?? undefined
  }
  hasTurn(sessionID: string, turnID: string): boolean { return this.states.get(sessionID)?.turns.has(turnID) === true }

  snapshot(sessionID: string): ModelContextSnapshot {
    const state = this.states.get(sessionID)
    return snapshotCopy({ kind: SNAPSHOT_KIND, version: SESSION_SNAPSHOT_VERSION, sessionID, date: state?.date ?? null, lastTurnID: state?.lastTurnID ?? null, turns: [...(state?.turns ?? [])].map(([turnID, receipt]) => ({ turnID, date: receipt.date })) })
  }

  restore(session: SessionSnapshot, value: unknown): () => void {
    const input = sessionSnapshot(SNAPSHOT_KIND, value, session, ['date', 'lastTurnID', 'turns'])
    if (this.disposed) fail('TRANSCRIPT_MODEL_CANCELLED')
    if (this.states.has(session.sessionID)) throw new HostHookError('SESSION_SNAPSHOT_STATE_CONFLICT', 'unsupported')
    if (!Array.isArray(input.turns)) throw new HostHookError('SESSION_SNAPSHOT_SCHEMA_INVALID', 'unsupported')
    if (this.turns + input.turns.length > MAX_TURNS || input.turns.length && this.states.size >= MAX_SESSIONS) fail('TRANSCRIPT_MODEL_LIMIT')
    const restored = new Map<string, Receipt>(), identities = new Set<string>()
    let bytes = 0, dates = 0, date: string | undefined, lastTurnID: string | undefined
    for (const raw of input.turns) {
      const row = snapshotObject(raw, ['turnID', 'date'])
      if (!snapshotID(row.turnID) || restored.has(row.turnID)) throw new HostHookError('SESSION_SNAPSHOT_SCHEMA_INVALID', 'unsupported')
      let attachment: ModelDate | null = null
      if (row.date !== null) {
        const value = snapshotObject(row.date, ['id', 'date', 'created'])
        if (typeof value.id !== 'string' || !UUID.test(value.id) || identities.has(value.id) || typeof value.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.date) || !Number.isFinite(Date.parse(value.date + 'T00:00:00Z')) || new Date(value.date + 'T00:00:00Z').toISOString().slice(0, 10) !== value.date || typeof value.created !== 'number' || !Number.isFinite(value.created) || Number.isNaN(new Date(value.created).getTime())) throw new HostHookError('SESSION_SNAPSHOT_SCHEMA_INVALID', 'unsupported')
        attachment = Object.freeze({ id: value.id, date: value.date, created: value.created }); identities.add(attachment.id); date = attachment.date; dates++
      } else if (date === undefined) throw new HostHookError('SESSION_SNAPSHOT_SCHEMA_INVALID', 'unsupported')
      const charge = Buffer.byteLength(JSON.stringify([session.sessionID, row.turnID, attachment]))
      restored.set(row.turnID, { date: attachment, bytes: charge }); bytes += charge; lastTurnID = row.turnID
    }
    if (input.date !== (date ?? null) || input.lastTurnID !== (lastTurnID ?? null)) throw new HostHookError('SESSION_SNAPSHOT_SCHEMA_INVALID', 'unsupported')
    if (this.turns + restored.size > MAX_TURNS || this.bytes + bytes > MAX_BYTES || restored.size && this.states.size >= MAX_SESSIONS) fail('TRANSCRIPT_MODEL_LIMIT')
    if (session.signal.aborted) throw new HostHookError('SESSION_SNAPSHOT_CANCELLED', 'cancelled')
    if (!restored.size) return () => {}
    const state = this.createState(session)
    for (const [turnID, receipt] of restored) state.turns.set(turnID, receipt)
    state.date = date!; state.lastTurnID = lastTurnID!
    this.turns += restored.size; this.dates += dates; this.bytes += bytes
    return () => { if (this.states.get(session.sessionID) === state) state.cleanup() }
  }

  private createState(session: SessionSnapshot): State {
    const cleanup = () => {
      const previous = this.states.get(session.sessionID)
      if (!previous) return
      for (const receipt of previous.turns.values()) { this.turns--; this.bytes -= receipt.bytes; if (receipt.date) this.dates-- }
      this.states.delete(session.sessionID)
      session.signal.removeEventListener('abort', cleanup)
    }
    const state: State = { signal: session.signal, turns: new Map(), cleanup }
    this.states.set(session.sessionID, state)
    session.signal.addEventListener('abort', cleanup, { once: true })
    return state
  }

  dispose(): void { this.disposed = true; for (const state of this.states.values()) state.cleanup() }
  inspect() { return Object.freeze({ modelSessions: this.states.size, modelTurns: this.turns, modelDates: this.dates, modelBytes: this.bytes }) }
}
