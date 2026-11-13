import { HostHookError } from '../host-errors.js'
import { SESSION_SNAPSHOT_VERSION, sessionSnapshot, snapshotCopy, snapshotID, snapshotObject } from '../session-snapshot.js'
import { runService } from '../service-execution.js'
import type { SessionStore, StoredSession } from '../session-store.js'
import type { SessionSnapshot } from '../sessions.js'
import type { JsonValue } from '../types.js'
import { PromptContexts } from '../prompt-contexts.js'
import { Sessions } from '../sessions.js'
import { StartupRecords } from '../startup-records.js'

const KIND = 'v1-session-state'
const PARTICIPANTS = ['claude', 'codex', 'contexts'] as const
const FIELDS = [...PARTICIPANTS, 'pendingPrompts']
const MAX_SESSIONS = 1024
const MAX_PENDING = 128
const MAX_PROMPTS = 10000
const SCAN_MS = 5000
const HISTORY_MS = 5000
interface Participant { snapshotV1(sessionID: string): unknown; restoreV1(session: SessionSnapshot, input: unknown): () => void; discardPendingPrompt?(session: SessionSnapshot, messageID: string): void }
type Participants = Partial<Record<typeof PARTICIPANTS[number], Participant>>
interface Options { readonly persistedPrompts?: (sessionID: string, signal: AbortSignal) => Promise<readonly string[]> }
interface State { readonly signal: AbortSignal; readonly loading: Promise<void>; readonly pendingPrompts: Set<string>; tail: Promise<unknown>; receipt?: StoredSession; failure?: unknown }
function fail(code: string): never { throw new HostHookError(code, code === 'SESSION_STORE_CANCELLED' ? 'cancelled' : 'unsupported') }

export class V1SessionState {
  readonly captureOriginals = true
  private readonly states = new Map<string, State>()
  private readonly deleted = new Set<string>()
  private readonly active = new Set<Promise<unknown>>()
  private disposed = false
  private disposing?: Promise<void>
  constructor(private readonly store: SessionStore, private readonly participants: Participants, private readonly options: Options = {}) { this.participants = { ...participants }; this.options = { ...options } }

  requiresProjection(): Promise<boolean> {
    const started = performance.now()
    return this.store.someSession(receipt => {
      if (performance.now() - started > SCAN_MS) fail('SESSION_STORE_LIMIT')
      if (!receipt.payload) return false
      const sessions = new Sessions(), contexts = new PromptContexts(), starts = new StartupRecords()
      try {
        const session = sessions.get(receipt.sessionID), input = sessionSnapshot(KIND, receipt.payload, session, FIELDS)
        if (input.contexts !== null) {
          contexts.restoreV1(session, input.contexts)
          if (contexts.requiresProjection(receipt.sessionID)) return true
        }
        if (input.claude !== null) {
          const claude = sessionSnapshot('claude-transcript-v1', input.claude, session, ['directory', 'originals', 'prompts', 'starts', 'models', 'published'])
          starts.restore(session, claude.starts)
          if (starts.pending(receipt.sessionID).some(batch => batch.model.claude.length || batch.model.codex.length)) return true
        }
        if (input.codex !== null) {
          const codex = sessionSnapshot('codex-transcript-v1', input.codex, session, ['directory', 'originals', 'starts', 'published'])
          if (!Array.isArray(codex.starts)) fail('SESSION_SNAPSHOT_SCHEMA_INVALID')
          for (const raw of codex.starts) {
            const row = snapshotObject(raw, ['activationID', 'contexts', 'created', 'messageID'])
            if (!Array.isArray(row.contexts) || !row.contexts.every(text => typeof text === 'string')) fail('SESSION_SNAPSHOT_SCHEMA_INVALID')
            if (row.messageID === null && row.contexts.length) return true
          }
        }
        return false
      } finally { contexts.dispose(); starts.dispose(); sessions.dispose() }
    }, AbortSignal.timeout(SCAN_MS))
  }

  ensure(session: SessionSnapshot, waiter: AbortSignal = session.turnSignal): Promise<void> {
    try {
      if (this.disposed || session.signal.aborted) fail('SESSION_STORE_CANCELLED')
      if (this.deleted.has(session.sessionID)) fail('SESSION_STORE_DELETED')
      let state = this.states.get(session.sessionID)
      if (state && state.signal !== session.signal) fail('SESSION_SNAPSHOT_OWNER_MISMATCH')
      if (state?.failure) throw state.failure
      if (!state) {
        if (this.states.size >= MAX_SESSIONS) fail('SESSION_STORE_LIMIT')
        const pending = Promise.resolve().then(async () => {
          const receipt = await this.store.load(session.sessionID, session.signal)
          if (receipt.deleted || this.deleted.has(session.sessionID)) fail('SESSION_STORE_DELETED')
          const undo: (() => void)[] = []
          try {
            if (receipt.payload) {
              const input = sessionSnapshot(KIND, receipt.payload, session, FIELDS)
              if (!Array.isArray(input.pendingPrompts) || input.pendingPrompts.length > MAX_PROMPTS || !input.pendingPrompts.every(snapshotID) || new Set(input.pendingPrompts).size !== input.pendingPrompts.length) fail('SESSION_SNAPSHOT_SCHEMA_INVALID')
              for (const name of PARTICIPANTS) {
                const participant = this.participants[name]
                if (participant && input[name] !== null) undo.push(participant.restoreV1(session, input[name]))
              }
              if (input.pendingPrompts.length) {
                if (!this.options.persistedPrompts) fail('SESSION_SNAPSHOT_PROMPT_CONFIRMATION_UNAVAILABLE')
                const confirmed = await runService(HISTORY_MS, session.signal, signal => this.options.persistedPrompts!(session.sessionID, signal))
                if (!Array.isArray(confirmed) || !confirmed.every(snapshotID) || new Set(confirmed).size !== confirmed.length) fail('SESSION_SNAPSHOT_SCHEMA_INVALID')
                const accepted = new Set(confirmed)
                for (const messageID of input.pendingPrompts) if (!accepted.has(messageID)) {
                  for (const name of PARTICIPANTS) if (input[name] !== null) {
                    const participant = this.participants[name]
                    if (!participant?.discardPendingPrompt) fail('SESSION_SNAPSHOT_PROMPT_RECONCILIATION_UNAVAILABLE')
                    participant.discardPendingPrompt(session, messageID)
                  }
                }
              }
            }
            if (session.signal.aborted) fail('SESSION_STORE_CANCELLED')
            state!.receipt = receipt
          } catch (error) { for (const rollback of undo.reverse()) rollback(); throw error }
        }).catch(error => { state!.failure = error; throw error })
        state = { signal: session.signal, loading: pending, pendingPrompts: new Set(), tail: Promise.resolve() }
        this.states.set(session.sessionID, state); this.track(pending)
      }
      return runService(null, waiter, () => state!.loading)
    } catch (error) { return Promise.reject(error) }
  }

  pendingPrompt(session: SessionSnapshot): void {
    const state = this.states.get(session.sessionID)
    if (!state?.receipt || state.signal !== session.signal || !snapshotID(session.turnID)) fail('SESSION_SNAPSHOT_OWNER_MISMATCH')
    if (state.pendingPrompts.size >= MAX_PROMPTS) fail('SESSION_STORE_LIMIT')
    state.pendingPrompts.add(session.turnID)
  }

  abandonPrompt(session: SessionSnapshot): void {
    const state = this.states.get(session.sessionID)
    if (!state || !session.turnID || !state.pendingPrompts.has(session.turnID)) return
    if (state.signal !== session.signal) fail('SESSION_SNAPSHOT_OWNER_MISMATCH')
    for (const participant of Object.values(this.participants)) {
      if (!participant.discardPendingPrompt) fail('SESSION_SNAPSHOT_PROMPT_RECONCILIATION_UNAVAILABLE')
      participant.discardPendingPrompt(session, session.turnID)
    }
    state.pendingPrompts.delete(session.turnID)
  }

  checkpoint(session: SessionSnapshot, waiter: AbortSignal = session.turnSignal): Promise<void> {
    if (this.disposed) return Promise.reject(new HostHookError('SESSION_STORE_CANCELLED', 'cancelled'))
    if (this.active.size >= MAX_PENDING) return Promise.reject(new HostHookError('SESSION_STORE_LIMIT', 'unsupported'))
    const pending = (async () => {
      await this.ensure(session, waiter)
      const state = this.states.get(session.sessionID)!
      const previous = state.receipt!.payload
      const payload = snapshotCopy({ kind: KIND, version: SESSION_SNAPSHOT_VERSION, sessionID: session.sessionID, pendingPrompts: [...state.pendingPrompts], ...Object.fromEntries(PARTICIPANTS.map(name => [name, this.participants[name]?.snapshotV1(session.sessionID) ?? previous?.[name] ?? null])) }) as Readonly<Record<string, JsonValue>>
      const operation = state.tail.then(async () => {
        if (state.failure) throw state.failure
        if (this.deleted.has(session.sessionID)) fail('SESSION_STORE_DELETED')
        state.receipt = await this.store.save(state.receipt!, payload, session.signal)
      }).catch(error => { state.failure = error; throw error })
      state.tail = operation
      await runService(null, waiter, () => operation)
    })()
    this.track(pending)
    return pending
  }

  remove(sessionID: string): Promise<void> {
    if (this.disposed) return Promise.reject(new HostHookError('SESSION_STORE_CANCELLED', 'cancelled'))
    if (!this.deleted.has(sessionID) && this.deleted.size >= MAX_SESSIONS || this.active.size >= MAX_PENDING) return Promise.reject(new HostHookError('SESSION_STORE_LIMIT', 'unsupported'))
    this.deleted.add(sessionID)
    const state = this.states.get(sessionID)
    const pending = (async () => {
      await Promise.allSettled([state?.loading, state?.tail])
      const receipt = await this.store.load(sessionID)
      await this.store.delete(receipt)
      this.states.delete(sessionID)
    })()
    this.track(pending)
    return pending
  }

  dispose(): Promise<void> {
    this.disposed = true
    return this.disposing ??= (async () => {
      await Promise.allSettled([...this.active])
      await Promise.allSettled([...this.states.values()].map(state => state.tail))
      await this.store.dispose(); this.states.clear(); this.deleted.clear()
    })()
  }
  inspect() { return Object.freeze({ sessions: this.states.size, pending: this.active.size, disposed: this.disposed, store: this.store.inspect() }) }
  private track(pending: Promise<unknown>): void { this.active.add(pending); void pending.finally(() => { this.active.delete(pending) }).catch(() => {}) }
}
