import { randomUUID } from 'node:crypto'
import { BackgroundManager } from '../background.js'
import type { BackgroundExecutor, BackgroundRecord, BackgroundSubmission, BackgroundWork } from '../background-types.js'
import type { BackgroundAnchor, BackgroundRecords } from '../background-records.js'
import { HostHookError } from '../host-errors.js'
import { runService } from '../service-execution.js'
import type { RuntimeServices } from '../runtime.js'
import type { SessionSnapshot, Sessions } from '../sessions.js'
import type { Registration } from '../types.js'
import type { WakeRecords } from '../wake-records.js'
import type { V1Wake } from './wake-v1.js'

const MAX_JOBS = 64
const MAX_PENDING = 128
const MAX_SESSIONS = 1024
const UI_MS = 5000
export interface V1BackgroundDiagnostic { readonly component: 'opencode-harness-hooks'; readonly operationID: string; readonly sessionID: string; readonly phase: 'completion' | 'retention' | 'binding' | 'ui'; readonly code: string; readonly outcome: 'success' | 'failed'; readonly durationMs: number; readonly jobID?: string }
interface Options { readonly records: BackgroundRecords; readonly state: Pick<NonNullable<RuntimeServices['nativeState']>, 'ensure' | 'checkpoint'>; readonly toast?: (text: string, session: SessionSnapshot, signal: AbortSignal) => Promise<void>; readonly diagnostic?: (value: V1BackgroundDiagnostic) => void; readonly maxJobs?: number; readonly wakes?: { readonly records: WakeRecords; readonly receive: V1Wake['receive'] } }
function fail(code: string): never { throw new HostHookError(code, code === 'HOST_BACKGROUND_CANCELLED' ? 'cancelled' : 'unsupported') }
function code(error: unknown, fallback: string): string { return error instanceof HostHookError ? error.code : fallback }

export class V1Background implements BackgroundExecutor {
  readonly supportsRewake: boolean
  private readonly manager: BackgroundManager
  private readonly options: Options
  private readonly lifetime = new AbortController()
  private readonly jobs = new Map<string, string>()
  private readonly tails = new Map<string, Promise<unknown>>()
  private readonly drains = new Map<string, Promise<void>>()
  private readonly ui = new Map<string, Promise<void>>()
  private readonly again = new Set<string>()
  private readonly closed = new Set<string>()
  private readonly controllers = new Map<string, AbortController>()
  private readonly uiAgain = new Set<string>()
  private readonly maxJobs: number
  private sessions?: Sessions
  private pending = 0
  private observerFailures = 0
  constructor(options: Options) {
    this.options = { ...options }; this.maxJobs = options.maxJobs ?? MAX_JOBS
    if (!Number.isSafeInteger(this.maxJobs) || this.maxJobs < 1 || this.maxJobs > MAX_JOBS) fail('HOST_BACKGROUND_LIMIT')
    this.supportsRewake = !!options.wakes
    this.manager = new BackgroundManager({ onEvent: row => this.event(row), ...(options.wakes ? { wake: async notice => { await options.wakes!.receive(notice); this.jobs.delete(notice.delivery.id) } } : {}) })
  }
  attach(sessions: Sessions, registrations: readonly Registration[]): void { if (this.sessions || this.lifetime.signal.aborted) fail('HOST_BACKGROUND_OWNER_MISMATCH'); this.options.records.configure(registrations.filter(row => row.handler.asyncRewake !== true)); this.options.wakes?.records.configure(registrations.filter(row => row.handler.asyncRewake === true)); this.sessions = sessions }
  enqueue(work: BackgroundWork): BackgroundSubmission {
    try {
      const session = this.session(work.event.sessionID)
      if (!work.sessionSignal || work.sessionSignal !== session.signal) fail('HOST_BACKGROUND_OWNER_MISMATCH')
      if (work.registration.handler.asyncRewake === true) { if (!this.options.wakes) fail('HOST_ASYNC_REWAKE_UNAVAILABLE'); this.options.wakes.records.assertRegistration(work.registration) }
      else this.options.records.assertRegistration(work.registration)
      if (this.jobs.size >= this.maxJobs) fail('HOST_BACKGROUND_LIMIT')
      const submitted = this.manager.enqueue(work)
      if (submitted.status === 'accepted') this.jobs.set(submitted.id, session.sessionID)
      return submitted
    } catch (error) { return { status: 'unsupported', code: code(error, 'HOST_BACKGROUND_OWNER_MISMATCH') } }
  }
  async completed(sessionID: string): Promise<void> { await this.manager.waitForIdle(sessionID); await this.schedule(sessionID) }
  async settled(sessionID: string): Promise<void> { await this.completed(sessionID); await this.ui.get(sessionID) }
  async resume(session: SessionSnapshot): Promise<void> { this.owner(session); await this.schedule(session.sessionID) }
  async prepare(session: SessionSnapshot, anchor: BackgroundAnchor, signal: AbortSignal): Promise<void> {
    const started = performance.now()
    try {
      await this.serial(session.sessionID, async () => {
        this.owner(session); if (signal.aborted) fail('HOST_BACKGROUND_CANCELLED')
        const current = this.session(session.sessionID)
        if (current.turnID !== session.turnID || current.turnSignal !== session.turnSignal || session.turnSignal.aborted) fail('HOST_BACKGROUND_OWNER_MISMATCH')
        await this.drain(session)
        const reservation = this.options.records.reserveBind(session, anchor)
        let persisted = false
        try {
          // Drain the owned write before releasing or compensating a cancelled binding
          await reservation.persist(() => this.options.state.checkpoint(session, session.signal)); persisted = true
          if (signal.aborted || session.turnSignal.aborted) fail('HOST_BACKGROUND_CANCELLED')
          reservation.commit()
        } catch (error) {
          reservation.release()
          if (persisted && !session.signal.aborted) {
            try { await this.options.state.checkpoint(session, session.signal) } catch { fail('HOST_BACKGROUND_BINDING_ROLLBACK_FAILED') }
          }
          throw error
        }
      })
      this.launchUI(session.sessionID)
    } catch (error) { this.report(session.sessionID, 'binding', code(error, 'HOST_BACKGROUND_BINDING_FAILED'), 'failed', started); throw error }
  }
  async removeSession(sessionID: string): Promise<void> {
    if (!this.closed.has(sessionID) && this.closed.size >= MAX_SESSIONS) fail('HOST_BACKGROUND_LIMIT')
    this.closed.add(sessionID); this.again.delete(sessionID)
    this.controllers.get(sessionID)?.abort()
    await this.manager.disposeSession(sessionID)
    await Promise.allSettled([this.drains.get(sessionID), this.ui.get(sessionID), this.tails.get(sessionID)])
    for (const [id, owner] of this.jobs) if (owner === sessionID) this.jobs.delete(id)
    this.options.records.removeSession(sessionID); this.tails.delete(sessionID); this.controllers.delete(sessionID); this.uiAgain.delete(sessionID)
  }
  async dispose(): Promise<void> {
    this.lifetime.abort(); await this.manager.dispose()
    await Promise.allSettled([...this.drains.values(), ...this.ui.values(), ...this.tails.values()])
    this.jobs.clear(); this.tails.clear(); this.drains.clear(); this.ui.clear(); this.again.clear(); this.closed.clear(); this.controllers.clear(); this.uiAgain.clear()
  }
  inspect() { return Object.freeze({ jobs: this.jobs.size, pending: this.pending, drains: this.drains.size, ui: this.ui.size, sessions: this.tails.size, observerFailures: this.observerFailures, disposed: this.lifetime.signal.aborted }) }
  private event(row: BackgroundRecord): void {
    if (row.phase !== 'completed') return
    if (!this.manager.hasPending(row.sessionID, row.jobID)) this.jobs.delete(row.jobID)
    this.report(row.sessionID, 'completion', row.code, row.outcome === 'success' ? 'success' : 'failed', performance.now() - row.durationMs, row.jobID)
    void this.schedule(row.sessionID)
  }
  private session(sessionID: string): SessionSnapshot { if (!this.sessions || this.lifetime.signal.aborted || this.closed.has(sessionID)) fail('HOST_BACKGROUND_CANCELLED'); try { const value = this.sessions.get(sessionID); if (value.signal.aborted) fail('HOST_BACKGROUND_CANCELLED'); if (!this.controllers.has(sessionID)) this.controllers.set(sessionID, new AbortController()); return value } catch { fail('HOST_BACKGROUND_CANCELLED') } }
  private owner(session: SessionSnapshot): void { if (this.session(session.sessionID).signal !== session.signal || session.signal.aborted) fail('HOST_BACKGROUND_OWNER_MISMATCH') }
  private serial<T>(sessionID: string, operation: () => Promise<T>): Promise<T> {
    if (this.pending >= MAX_PENDING) return Promise.reject(new HostHookError('HOST_BACKGROUND_LIMIT', 'unsupported'))
    this.pending++
    const pending = (this.tails.get(sessionID) ?? Promise.resolve()).catch(() => {}).then(operation).finally(() => { this.pending--; if (this.tails.get(sessionID) === pending) this.tails.delete(sessionID) })
    this.tails.set(sessionID, pending); return pending
  }
  private async drain(session: SessionSnapshot): Promise<void> {
    const started = performance.now()
    this.owner(session); await this.options.state.ensure(session, session.signal)
    let failure: unknown
    try {
      await this.manager.deliver(session.sessionID, 'safe-point', async batch => {
        try {
          this.owner(session)
          for (const row of batch) this.options.records.admit(session, row)
          await this.options.state.checkpoint(session, session.signal)
          this.owner(session)
          for (const row of batch) { this.jobs.delete(row.id); this.report(session.sessionID, 'retention', 'HOST_BACKGROUND_RETAINED', 'success', started, row.id) }
        } catch (error) { failure = error; throw error }
      })
    } catch (error) { throw failure ?? error }
  }
  private schedule(sessionID: string): Promise<void> {
    if (this.lifetime.signal.aborted || this.closed.has(sessionID)) return Promise.resolve()
    if (this.drains.has(sessionID)) { this.again.add(sessionID); return this.drains.get(sessionID)! }
    const started = performance.now()
    const pending = (async () => {
      do { this.again.delete(sessionID); await this.serial(sessionID, () => this.drain(this.session(sessionID))) } while (this.again.has(sessionID))
      this.launchUI(sessionID)
    })().catch(error => { this.report(sessionID, 'retention', code(error, 'HOST_BACKGROUND_RETENTION_FAILED'), 'failed', started) }).finally(() => { this.drains.delete(sessionID); this.again.delete(sessionID) })
    this.drains.set(sessionID, pending); return pending
  }
  private launchUI(sessionID: string): void {
    if (this.lifetime.signal.aborted || this.closed.has(sessionID)) return
    if (this.ui.has(sessionID)) { this.uiAgain.add(sessionID); return }
    const started = performance.now()
    const pending = (async () => {
      const session = this.session(sessionID), signal = AbortSignal.any([session.signal, this.lifetime.signal, this.controllers.get(sessionID)!.signal])
      do {
        this.uiAgain.delete(sessionID)
        const warnings = await this.serial(sessionID, async () => this.options.records.warnings(session))
        if (!warnings.length) return
        if (!this.options.toast) fail('HOST_BACKGROUND_UI_UNAVAILABLE')
        for (const warning of warnings) {
          for (const text of warning.texts) await runService(UI_MS, signal, current => this.options.toast!(text, session, current))
          await this.serial(sessionID, async () => { this.owner(session); this.options.records.acknowledgeWarnings(session, [warning.id]); await this.options.state.checkpoint(session, signal) })
        }
      } while (this.uiAgain.has(sessionID))
    })().catch(error => { this.report(sessionID, 'ui', code(error, 'HOST_BACKGROUND_UI_FAILED'), 'failed', started) }).finally(() => { this.ui.delete(sessionID); this.uiAgain.delete(sessionID) })
    this.ui.set(sessionID, pending)
  }
  private report(sessionID: string, phase: V1BackgroundDiagnostic['phase'], code: string, outcome: V1BackgroundDiagnostic['outcome'], started: number, jobID?: string): void {
    try { (this.options.diagnostic ?? (value => { console.error(JSON.stringify(value)) }))({ component: 'opencode-harness-hooks', operationID: randomUUID(), sessionID, phase, code, outcome, durationMs: Math.round(performance.now() - started), ...(jobID ? { jobID } : {}) }) } catch { this.observerFailures++ }
  }
}
