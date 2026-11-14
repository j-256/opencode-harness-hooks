import { createHash } from 'node:crypto'
import type { DispatchResult } from './engine.js'
import { resolveEffects } from './effects.js'
import { HostHookError } from './host-errors.js'
import type { HostPromptEvent } from './prompt-types.js'
import type { SessionSnapshot } from './sessions.js'
import { snapshotCopy, snapshotID, snapshotObject } from './session-snapshot.js'

const MAX_RECORDS = 10000
const MAX_BYTES = 32 * 1024 * 1024
const HASH = /^[a-f0-9]{64}$/
export interface CodexPromptContext { readonly messageID: string; readonly promptHash: string; readonly contexts: readonly string[]; readonly created: number }
type Entry = CodexPromptContext
interface State { readonly owner: AbortSignal; readonly entries: Map<string, Entry>; readonly cleanup: () => void; bytes: number }
function fail(code: string): never { throw new HostHookError(code, 'unsupported') }
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const charge = (entry: Entry) => Buffer.byteLength(JSON.stringify(entry))

export class CodexPromptContexts {
  private readonly states = new Map<string, State>()
  private records = 0
  private bytes = 0
  private disposed = false

  admit(event: HostPromptEvent, session: SessionSnapshot, dispatch: DispatchResult): void {
    if (this.disposed || session.signal.aborted || session.turnSignal.aborted || event.signal.aborted || event.sessionID !== session.sessionID || event.messageID !== session.turnID || !snapshotID(event.messageID) || typeof event.prompt !== 'string') fail('CODEX_PROMPT_OWNER_MISMATCH')
    const effects = resolveEffects(dispatch)
    if (dispatch.cancelled || dispatch.diagnostic.cancelled || dispatch.diagnostic.sessionID !== event.sessionID || dispatch.diagnostic.event !== event.event || dispatch.entries.some(entry => entry.result.status === 'unsupported') || effects.control !== 'default' || effects.permission || effects.input || effects.continuations.length || effects.resultReplacements.length || effects.unresolved.length || effects.context.some(row => row.action.placement !== 'model')) fail('CODEX_PROMPT_NOT_ACCEPTED')
    const contexts = effects.context.filter(row => row.dialect === 'codex').map(row => row.action.text)
    const state = this.state(session), prior = state?.entries.get(event.messageID), promptHash = hash(event.prompt)
    if (prior) {
      if (prior.promptHash !== promptHash || JSON.stringify(prior.contexts) !== JSON.stringify(contexts)) fail('CODEX_PROMPT_HISTORY_MISMATCH')
      return
    }
    if (!contexts.length) return
    const entry = snapshotCopy({ messageID: event.messageID, promptHash, contexts, created: Date.now() }), bytes = charge(entry)
    this.limit(1, bytes)
    const owner = state ?? this.create(session)
    owner.entries.set(entry.messageID, entry); owner.bytes += bytes; this.records++; this.bytes += bytes
  }

  read(session: SessionSnapshot, messageID: string, prompt: string): Entry | undefined {
    const entry = this.state(session)?.entries.get(messageID)
    if (entry && entry.promptHash !== hash(prompt)) fail('CODEX_PROMPT_HISTORY_MISMATCH')
    return entry
  }

  discard(session: SessionSnapshot, messageID: string): void {
    const state = this.state(session), entry = state?.entries.get(messageID)
    if (!state || !entry) return
    const bytes = charge(entry)
    state.entries.delete(messageID); state.bytes -= bytes; this.bytes -= bytes; this.records--
    if (!state.entries.size) state.cleanup()
  }

  snapshot(sessionID: string): readonly Entry[] { return snapshotCopy([...(this.states.get(sessionID)?.entries.values() ?? [])]) }
  remove(sessionID: string): void { this.states.get(sessionID)?.cleanup() }

  restore(session: SessionSnapshot, input: unknown): () => void {
    if (this.disposed || session.signal.aborted) fail('CODEX_PROMPT_OWNER_MISMATCH')
    if (this.states.has(session.sessionID)) fail('SESSION_SNAPSHOT_STATE_CONFLICT')
    if (!Array.isArray(input)) fail('SESSION_SNAPSHOT_SCHEMA_INVALID')
    if (input.length > MAX_RECORDS) fail('CODEX_TRANSCRIPT_INPUT_LIMIT')
    const entries = new Map<string, Entry>(); let bytes = 0
    for (const raw of snapshotCopy(input)) {
      const row = snapshotObject(raw, ['messageID', 'promptHash', 'contexts', 'created'])
      if (!snapshotID(row.messageID) || entries.has(row.messageID) || typeof row.promptHash !== 'string' || !HASH.test(row.promptHash) || !Array.isArray(row.contexts) || !row.contexts.length || !row.contexts.every(text => typeof text === 'string') || typeof row.created !== 'number' || !Number.isFinite(row.created) || Number.isNaN(new Date(row.created).getTime())) fail('SESSION_SNAPSHOT_SCHEMA_INVALID')
      const entry: Entry = snapshotCopy({ messageID: row.messageID, promptHash: row.promptHash, contexts: row.contexts as string[], created: row.created })
      entries.set(entry.messageID, entry); bytes += charge(entry)
    }
    this.limit(entries.size, bytes)
    if (!entries.size) return () => {}
    const state = this.create(session)
    for (const [id, entry] of entries) state.entries.set(id, entry)
    state.bytes = bytes; this.bytes += bytes; this.records += entries.size
    return () => { if (this.states.get(session.sessionID) === state) state.cleanup() }
  }

  dispose(): void { this.disposed = true; for (const state of this.states.values()) state.cleanup() }
  inspect() { return Object.freeze({ promptContexts: this.records, promptContextBytes: this.bytes }) }
  private limit(records: number, bytes: number): void { if (this.records + records > MAX_RECORDS || this.bytes + bytes > MAX_BYTES) fail('CODEX_TRANSCRIPT_INPUT_LIMIT') }
  private state(session: SessionSnapshot): State | undefined {
    const state = this.states.get(session.sessionID)
    if (this.disposed || session.signal.aborted || state && state.owner !== session.signal) fail('CODEX_PROMPT_OWNER_MISMATCH')
    return state
  }
  private create(session: SessionSnapshot): State {
    const cleanup = () => { const state = this.states.get(session.sessionID); if (!state || state.owner !== session.signal) return; this.records -= state.entries.size; this.bytes -= state.bytes; this.states.delete(session.sessionID); session.signal.removeEventListener('abort', cleanup) }
    const state: State = { owner: session.signal, entries: new Map(), bytes: 0, cleanup }
    this.states.set(session.sessionID, state); session.signal.addEventListener('abort', cleanup, { once: true })
    return state
  }
}
