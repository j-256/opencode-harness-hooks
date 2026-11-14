import { createHash, randomUUID } from 'node:crypto'
import { HostHookError } from '../host-errors.js'
import { runService } from '../service-execution.js'
import type { RuntimeServices } from '../runtime.js'
import type { SessionSnapshot, Sessions } from '../sessions.js'
import type { WakeRecords } from '../wake-records.js'
import { V1WakeInputs, wakeInputPart } from './wake-inputs-v1.js'
import type { V1WakeInput } from './wake-inputs-v1.js'
import type { V1Wake } from './wake-v1.js'

const MAX_SESSIONS = 1024
const MAX_MESSAGES = 10000
const HISTORY_MS = 5000
export interface V1WakePromptBody { readonly messageID?: string; readonly noReply?: boolean; readonly model: { readonly providerID: string; readonly modelID: string }; readonly variant?: string; readonly agent: string; readonly tools?: Readonly<Record<string, boolean>>; readonly parts: readonly ReturnType<typeof wakeInputPart>[] }
export interface V1WakeIdleDiagnostic { readonly component: 'opencode-harness-hooks'; readonly operationID: string; readonly sessionID: string; readonly phase: 'idle'; readonly code: string; readonly outcome: 'success' | 'failed'; readonly durationMs: number; readonly jobID?: string }
interface Options {
  readonly records: WakeRecords; readonly inputs: V1WakeInputs; readonly sessions: Sessions; readonly wake: V1Wake
  readonly state: Pick<NonNullable<RuntimeServices['nativeState']>, 'ensure' | 'checkpoint'>
  readonly history: (sessionID: string, signal: AbortSignal) => Promise<readonly unknown[]>
  readonly prompt: (sessionID: string, body: V1WakePromptBody, signal: AbortSignal) => Promise<{ readonly data?: unknown; readonly error?: unknown }>
  readonly diagnostic?: (value: V1WakeIdleDiagnostic) => void
}
function fail(code: string): never { throw new HostHookError(code, code === 'HOST_WAKE_CANCELLED' ? 'cancelled' : 'unsupported') }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function digest(text: string): string { return createHash('sha256').update(text).digest('hex') }

export class V1WakeIdle {
  private readonly idle = new Set<string>()
  private readonly tasks = new Map<string, Promise<void>>()
  private readonly controllers = new Map<string, AbortController>()
  private readonly closed = new Set<string>()
  private readonly lifetime = new AbortController()
  private observerFailures = 0
  constructor(private readonly options: Options) { this.options = { ...options } }
  event(type: string, properties: unknown): void {
    if (!record(properties) || typeof properties.sessionID !== 'string' || !properties.sessionID) return
    if (type === 'session.idle' || type === 'session.status' && record(properties.status) && properties.status.type === 'idle') {
      this.owner(properties.sessionID); this.idle.add(properties.sessionID); this.resume(properties.sessionID)
    } else if (type === 'session.status' && record(properties.status) && ['busy', 'retry'].includes(String(properties.status.type))) this.busy(properties.sessionID)
  }
  busy(sessionID: string): void { this.idle.delete(sessionID) }
  resume(sessionID: string): void {
    if (!this.idle.has(sessionID) || this.tasks.has(sessionID) || this.lifetime.signal.aborted || this.closed.has(sessionID)) return
    const started = performance.now()
    const task = Promise.resolve().then(() => this.run(sessionID)).catch(error => { this.report(sessionID, error instanceof HostHookError ? error.code : 'HOST_WAKE_IDLE_FAILED', 'failed', started) }).finally(() => { if (this.tasks.get(sessionID) === task) this.tasks.delete(sessionID) })
    this.tasks.set(sessionID, task)
  }
  async settled(sessionID: string): Promise<void> { await this.tasks.get(sessionID) }
  async message(sessionID: string, message: unknown, parts: unknown): Promise<boolean> {
    const before = this.owner(sessionID), claim = this.options.inputs.claim(before, message, parts)
    if (!claim) { this.busy(sessionID); return false }
    const input = claim.input
    this.options.sessions.prompt(sessionID, input.messageID!, input.model!.modelID)
    const session = this.owner(sessionID)
    await this.options.state.ensure(session, session.signal)
    await this.options.state.checkpoint(session, session.signal)
    if (claim.phase === 'resume') return true
    const row = this.options.records.read(session).find(row => row.delivery.id === input.jobID)
    if (!row) fail('HOST_WAKE_OWNER_MISMATCH')
    const anchor = { kind: 'prompt' as const, sessionID, turnID: input.messageID!, messageID: input.messageID!, signature: digest(JSON.stringify([row.text.prompt])) }
    const result = await this.options.wake.system(session, input.jobID, anchor, input, session.turnSignal)
    if (result.outcome === 'block' || result.outcome === 'cancelled') {
      this.options.inputs.fail(session, input.saveNonce); await this.options.state.checkpoint(session, session.signal)
      throw new HostHookError(result.outcome === 'block' ? 'HOOK_NOTIFICATION_BLOCKED' : 'HOST_WAKE_CANCELLED', result.outcome === 'block' ? 'denied' : 'cancelled', result.reason ?? '')
    }
    return true
  }
  async removeSession(sessionID: string): Promise<void> { if (!this.closed.has(sessionID) && this.closed.size >= MAX_SESSIONS) fail('HOST_WAKE_LIMIT'); this.closed.add(sessionID); this.idle.delete(sessionID); this.controllers.get(sessionID)?.abort(); await this.tasks.get(sessionID); this.controllers.delete(sessionID) }
  async dispose(): Promise<void> { this.lifetime.abort(); for (const controller of this.controllers.values()) controller.abort(); await Promise.allSettled([...this.tasks.values()]); this.tasks.clear(); this.idle.clear(); this.controllers.clear(); this.closed.clear() }
  inspect() { return Object.freeze({ idle: this.idle.size, tasks: this.tasks.size, sessions: this.controllers.size, closed: this.closed.size, observerFailures: this.observerFailures, disposed: this.lifetime.signal.aborted }) }
  private async run(sessionID: string): Promise<void> {
    let session = this.owner(sessionID)
    const signal = AbortSignal.any([session.signal, this.lifetime.signal, this.controllers.get(sessionID)!.signal])
    await this.options.state.ensure(session, signal)
    while (this.idle.has(sessionID)) {
      session = this.owner(sessionID)
      const row = this.options.records.pending(session)[0]
      if (!row) return
      const started = performance.now()
      const previous = this.options.inputs.read(session).find(input => input.jobID === row.delivery.id)
      if (previous) fail('HOST_WAKE_IDLE_UNRESOLVED')
      const last = row.attempts.at(-1)
      if (last && (!last.result || last.result.outcome !== 'stop' || last.anchor.kind !== 'tool')) fail('HOST_WAKE_ATTEMPT_UNRESOLVED')
      const history = await this.history(sessionID, signal), users = history.filter(raw => record(raw) && record(raw.info) && raw.info.role === 'user')
      const latest = users.at(-1)
      if (!record(latest) || !record(latest.info) || latest.info.id !== session.turnID || !record(latest.info.model) || typeof latest.info.model.providerID !== 'string' || typeof latest.info.model.modelID !== 'string' || typeof latest.info.agent !== 'string') fail('HOST_WAKE_INPUT_OWNER_MISMATCH')
      const owned = new Set(this.options.inputs.read(session).map(input => input.messageID)), genuine = users.filter(raw => !owned.has((raw as { info: { id: string } }).info.id))
      if (!this.idle.has(sessionID)) return
      this.current(session, signal)
      const input = this.options.inputs.prepare(session, { jobID: row.delivery.id, prompt: row.text.prompt, model: { providerID: latest.info.model.providerID, modelID: latest.info.model.modelID, ...(typeof latest.info.model.variant === 'string' ? { variant: latest.info.model.variant } : {}) }, agent: latest.info.agent, ...(record(latest.info.tools) ? { tools: latest.info.tools as Readonly<Record<string, boolean>> } : {}), promptIndex: genuine.length - 1, turnIndex: users.length + 1 })
      await this.options.state.checkpoint(session, session.signal); this.current(session, signal)
      if (!this.idle.has(sessionID)) return
      this.idle.delete(sessionID)
      const saved = await runService(null, signal, current => this.options.prompt(sessionID, this.body(input, row.text.prompt, true), current))
      session = this.owner(sessionID)
      if (saved.error) {
        const result = this.options.records.read(session).find(value => value.delivery.id === row.delivery.id)!.attempts.at(-1)?.result
        const history = await this.history(sessionID, signal), current = this.options.inputs.read(session).find(value => value.saveNonce === input.saveNonce)!
        if ((result?.outcome === 'block' || result?.outcome === 'cancelled') && current.phase === 'failed' && !history.some(raw => record(raw) && record(raw.info) && raw.info.id === current.messageID)) { this.report(sessionID, 'HOST_WAKE_CONSUMED', 'success', started, row.delivery.id); return }
        fail('HOST_WAKE_SAVE_FAILED')
      }
      const ownedInput = this.options.inputs.saved(session, input.saveNonce, saved.data)
      await this.options.state.checkpoint(session, session.signal)
      const result = this.options.records.read(session).find(value => value.delivery.id === row.delivery.id)!.attempts.at(-1)?.result
      if (!result || !['allow', 'stop'].includes(result.outcome)) fail('HOST_WAKE_ATTEMPT_UNRESOLVED')
      if (result.outcome === 'stop') {
        this.options.inputs.finish(session, input.saveNonce, saved.data); await this.options.state.checkpoint(session, session.signal)
        this.report(sessionID, 'HOST_WAKE_FINISHED', 'success', started, row.delivery.id)
        return
      }
      if (session.turnID !== ownedInput.messageID || session.turnSignal.aborted) return
      const resuming = this.options.inputs.resume(session, input.saveNonce)
      await this.options.state.checkpoint(session, session.signal); this.current(session, signal)
      const resumed = await runService(null, signal, current => this.options.prompt(sessionID, this.body(resuming, row.text.prompt, false), current))
      if (resumed.error) fail('HOST_WAKE_RESUME_FAILED')
      session = this.owner(sessionID)
      const raw = (await this.history(sessionID, signal)).find(raw => record(raw) && record(raw.info) && raw.info.id === ownedInput.messageID)
      this.options.inputs.finish(session, input.saveNonce, raw); await this.options.state.checkpoint(session, session.signal)
      this.report(sessionID, 'HOST_WAKE_FINISHED', 'success', started, row.delivery.id)
    }
  }
  private body(input: V1WakeInput, prompt: string, save: boolean): V1WakePromptBody {
    if (!input.model || !input.agent) fail('HOST_WAKE_INPUT_OWNER_MISMATCH')
    return { ...(save ? { noReply: true } : { messageID: input.messageID! }), model: { providerID: input.model.providerID, modelID: input.model.modelID }, ...(input.model.variant !== undefined ? { variant: input.model.variant } : {}), agent: input.agent, ...(input.tools ? { tools: input.tools } : {}), parts: [wakeInputPart(input, prompt, save ? 'save' : 'resume')] }
  }
  private async history(sessionID: string, signal: AbortSignal): Promise<readonly unknown[]> {
    const history = await runService(HISTORY_MS, signal, current => this.options.history(sessionID, current))
    if (!Array.isArray(history) || history.length > MAX_MESSAGES || history.some(raw => !record(raw) || !record(raw.info) || raw.info.sessionID !== sessionID || typeof raw.info.id !== 'string' || !['user', 'assistant'].includes(String(raw.info.role)))) fail('HOST_WAKE_INPUT_OWNER_MISMATCH')
    this.options.inputs.normalize(sessionID, history)
    return history
  }
  private owner(sessionID: string): SessionSnapshot {
    if (this.lifetime.signal.aborted || this.closed.has(sessionID)) fail('HOST_WAKE_CANCELLED')
    const session = this.options.sessions.get(sessionID)
    if (session.signal.aborted) fail('HOST_WAKE_CANCELLED')
    if (!this.controllers.has(sessionID)) { if (this.controllers.size + this.closed.size >= MAX_SESSIONS) fail('HOST_WAKE_LIMIT'); this.controllers.set(sessionID, new AbortController()) }
    return session
  }
  private current(session: SessionSnapshot, signal: AbortSignal): void { const current = this.owner(session.sessionID); if (signal.aborted || session.turnSignal.aborted) fail('HOST_WAKE_CANCELLED'); if (current.turnID !== session.turnID || current.turnSignal !== session.turnSignal) fail('HOST_WAKE_OWNER_MISMATCH') }
  private report(sessionID: string, code: string, outcome: V1WakeIdleDiagnostic['outcome'], started: number, jobID?: string): void { try { (this.options.diagnostic ?? (value => { console.error(JSON.stringify(value)) }))({ component: 'opencode-harness-hooks', operationID: randomUUID(), sessionID, phase: 'idle', code, outcome, durationMs: Math.round(performance.now() - started), ...(jobID ? { jobID } : {}) }) } catch { this.observerFailures++ } }
}
