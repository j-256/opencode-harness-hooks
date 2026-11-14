import { randomUUID } from 'node:crypto'
import { HostHookError } from '../host-errors.js'
import type { BackgroundDelivery } from '../background-types.js'
import type { BackgroundAnchor } from '../background-records.js'
import type { DispatchResult } from '../engine.js'
import type { HostNotificationEvent } from '../notification.js'
import type { RuntimeServices } from '../runtime.js'
import type { SessionSnapshot, Sessions } from '../sessions.js'
import type { WakeRecords, WakePlacement } from '../wake-records.js'
import type { WakeAttemptResult } from '../wake-attempts.js'

const MAX_PENDING = 128
const MAX_SESSIONS = 1024
interface Runtime { readonly notification: (event: HostNotificationEvent) => Promise<DispatchResult> }
export interface V1WakeDiagnostic { readonly component: 'opencode-harness-hooks'; readonly operationID: string; readonly sessionID: string; readonly phase: 'retention' | 'admission' | 'binding'; readonly code: string; readonly outcome: 'success' | 'failed'; readonly durationMs: number; readonly jobID?: string }
interface Options { readonly records: WakeRecords; readonly state: Pick<NonNullable<RuntimeServices['nativeState']>, 'ensure' | 'checkpoint'>; readonly diagnostic?: (value: V1WakeDiagnostic) => void }
function fail(code: string): never { throw new HostHookError(code, code === 'HOST_WAKE_CANCELLED' ? 'cancelled' : 'unsupported') }
function same(a: BackgroundAnchor, b: BackgroundAnchor): boolean { return a.kind === b.kind && a.sessionID === b.sessionID && a.turnID === b.turnID && a.messageID === b.messageID && a.signature === b.signature && (a.kind !== 'tool' || b.kind === 'tool' && a.callID === b.callID) }

export class V1Wake {
  private readonly lifetime = new AbortController()
  private readonly tails = new Map<string, Promise<unknown>>()
  private readonly closed = new Set<string>()
  private readonly capturing = new Set<string>()
  private sessions?: Sessions
  private runtime?: Runtime
  private pending = 0
  private observerFailures = 0
  constructor(private readonly options: Options) { this.options = { ...options } }
  attach(sessions: Sessions, runtime: Runtime): void { if (this.sessions || this.lifetime.signal.aborted) fail('HOST_WAKE_OWNER_MISMATCH'); this.sessions = sessions; this.runtime = runtime }
  async receive(notice: { readonly sessionID: string; readonly delivery: BackgroundDelivery; readonly signal: AbortSignal }): Promise<void> {
    const started = performance.now()
    try {
      await this.serial(notice.sessionID, async () => {
        const session = this.session(notice.sessionID)
        if (notice.signal.aborted) fail('HOST_WAKE_CANCELLED')
        await this.options.state.ensure(session, session.signal)
        this.options.records.admit(session, notice.delivery)
        await this.options.state.checkpoint(session, session.signal)
      })
      this.report(notice.sessionID, 'retention', 'HOST_WAKE_RETAINED', 'success', started, notice.delivery.id)
    } catch (error) { this.report(notice.sessionID, 'retention', error instanceof HostHookError ? error.code : 'HOST_WAKE_RETENTION_FAILED', 'failed', started, notice.delivery.id); throw error }
  }
  async capture(event: HostNotificationEvent, session: SessionSnapshot, dispatch: DispatchResult, signal: AbortSignal): Promise<void> {
    this.owner(session)
    if (signal.aborted || !this.capturing.has(event.notificationID)) fail('HOST_WAKE_OWNER_MISMATCH')
    this.options.records.capture(session, event, dispatch)
    // Capture runs inside admission and must not enqueue behind that same operation
    await this.options.state.checkpoint(session, session.signal)
  }
  async prepare(session: SessionSnapshot, anchor: BackgroundAnchor, signal: AbortSignal): Promise<void> {
    if (anchor.kind !== 'tool') return
    const started = performance.now()
    try {
      await this.serial(session.sessionID, async () => {
        this.current(session, signal); await this.options.state.ensure(session, session.signal)
        for (const row of this.options.records.read(session)) {
          if (row.binding) continue
          const attempt = row.attempts.at(-1)
          if (attempt && !attempt.result) fail('HOST_WAKE_ATTEMPT_UNRESOLVED')
          if (attempt && (!same(attempt.anchor, anchor) || attempt.result?.outcome !== 'allow')) continue
          await this.evaluate(session, row.delivery.id, anchor, { kind: 'queued', human: false }, signal)
        }
      })
    } catch (error) { this.report(session.sessionID, 'admission', error instanceof HostHookError ? error.code : 'HOST_WAKE_ADMISSION_FAILED', 'failed', started); throw error }
  }
  system(session: SessionSnapshot, jobID: string, anchor: BackgroundAnchor, position: { readonly promptIndex: number; readonly turnIndex: number }, signal: AbortSignal): Promise<WakeAttemptResult> {
    return this.serial(session.sessionID, async () => { this.current(session, signal); await this.options.state.ensure(session, session.signal); return this.evaluate(session, jobID, anchor, { kind: 'system', promptIndex: position.promptIndex, turnIndex: position.turnIndex }, signal) })
  }
  async removeSession(sessionID: string): Promise<void> {
    if (!this.closed.has(sessionID) && this.closed.size >= MAX_SESSIONS) fail('HOST_WAKE_LIMIT')
    this.closed.add(sessionID); await this.tails.get(sessionID)?.catch(() => {}); this.tails.delete(sessionID)
  }
  async dispose(): Promise<void> { this.lifetime.abort(); await Promise.allSettled([...this.tails.values()]); this.tails.clear(); this.capturing.clear(); this.closed.clear() }
  inspect() { return Object.freeze({ pending: this.pending, sessions: this.tails.size, capturing: this.capturing.size, closed: this.closed.size, observerFailures: this.observerFailures, disposed: this.lifetime.signal.aborted }) }
  private async evaluate(session: SessionSnapshot, jobID: string, anchor: BackgroundAnchor, placement: WakePlacement, signal: AbortSignal): Promise<WakeAttemptResult> {
    const started = performance.now()
    const row = this.options.records.read(session).find(row => row.delivery.id === jobID)
    if (!row || row.binding) fail('HOST_WAKE_OWNER_MISMATCH')
    let attempt = row.attempts.at(-1)
    if (attempt && !same(attempt.anchor, anchor)) {
      if (attempt.result?.outcome !== 'stop' || attempt.anchor.kind !== 'tool' || placement.kind !== 'system') fail('HOST_WAKE_ATTEMPT_UNRESOLVED')
      attempt = undefined
    }
    if (attempt && !attempt.result) fail('HOST_WAKE_ATTEMPT_UNRESOLVED')
    if (!attempt) {
      attempt = this.options.records.begin(session, jobID, anchor)
      await this.options.state.checkpoint(session, session.signal); this.current(session, signal)
      const event: HostNotificationEvent = { host: 'v1', event: 'UserPromptSubmit', sessionID: session.sessionID, messageID: session.turnID!, prompt: row.text.prompt, notificationID: attempt.id, anchor, signal }
      this.capturing.add(attempt.id)
      try { await this.runtime!.notification(event) } finally { this.capturing.delete(attempt.id) }
    }
    this.current(session, signal)
    const result = this.options.records.read(session).find(value => value.delivery.id === jobID)!.attempts.at(-1)!.result
    if (!result) fail('HOST_WAKE_ATTEMPT_UNRESOLVED')
    if (result.outcome === 'allow' || result.outcome === 'stop' && placement.kind === 'system') await this.bind(session, jobID, attempt.id, anchor, placement, signal)
    else if (result.outcome === 'block') this.report(session.sessionID, 'admission', 'HOST_WAKE_CONSUMED', 'success', started, jobID)
    return result
  }
  private async bind(session: SessionSnapshot, jobID: string, attemptID: string, anchor: BackgroundAnchor, placement: WakePlacement, signal: AbortSignal): Promise<void> {
    const started = performance.now()
    const reservation = this.options.records.reserveBind(session, jobID, attemptID, anchor, placement)
    let persisted = false
    try {
      await reservation.persist(() => this.options.state.checkpoint(session, session.signal)); persisted = true
      this.current(session, signal); reservation.commit()
      this.report(session.sessionID, 'binding', 'HOST_WAKE_BOUND', 'success', started, jobID)
    } catch (error) {
      reservation.release()
      if (persisted && !session.signal.aborted) {
        try { await this.options.state.checkpoint(session, session.signal) } catch { fail('HOST_WAKE_BINDING_ROLLBACK_FAILED') }
      }
      throw error
    }
  }
  private session(sessionID: string): SessionSnapshot { if (!this.sessions || !this.runtime || this.lifetime.signal.aborted || this.closed.has(sessionID)) fail('HOST_WAKE_CANCELLED'); const session = this.sessions.get(sessionID); if (session.signal.aborted) fail('HOST_WAKE_CANCELLED'); return session }
  private owner(session: SessionSnapshot): void { if (this.session(session.sessionID).signal !== session.signal) fail('HOST_WAKE_OWNER_MISMATCH') }
  private current(session: SessionSnapshot, signal: AbortSignal): void { this.owner(session); if (signal.aborted || session.turnSignal.aborted) fail('HOST_WAKE_CANCELLED'); const current = this.session(session.sessionID); if (current.turnID !== session.turnID || current.turnSignal !== session.turnSignal) fail('HOST_WAKE_OWNER_MISMATCH') }
  private serial<T>(sessionID: string, operation: () => Promise<T>): Promise<T> {
    if (this.pending >= MAX_PENDING) return Promise.reject(new HostHookError('HOST_WAKE_LIMIT', 'unsupported'))
    this.pending++
    const pending = (this.tails.get(sessionID) ?? Promise.resolve()).catch(() => {}).then(operation).finally(() => { this.pending--; if (this.tails.get(sessionID) === pending) this.tails.delete(sessionID) })
    this.tails.set(sessionID, pending); return pending
  }
  private report(sessionID: string, phase: V1WakeDiagnostic['phase'], code: string, outcome: V1WakeDiagnostic['outcome'], started: number, jobID?: string): void {
    try { (this.options.diagnostic ?? (value => { console.error(JSON.stringify(value)) }))({ component: 'opencode-harness-hooks', operationID: randomUUID(), sessionID, phase, code, outcome, durationMs: Math.round(performance.now() - started), ...(jobID ? { jobID } : {}) }) } catch { this.observerFailures++ }
  }
}
