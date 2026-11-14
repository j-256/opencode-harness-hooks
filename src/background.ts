import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import type { BackgroundDelivery, BackgroundExecutor, BackgroundRecord, BackgroundSubmission, BackgroundWork } from './background-types.js'
import { isBackground } from './background-types.js'
import type { HookEffect } from './effect-types.js'
import { interpretOutput } from './protocol.js'
import { runCommand } from './runner.js'
import { HookServiceError, runService } from './service-execution.js'
import { toolIdentity } from './matchers.js'

const CODEX_CONCURRENCY = 8
const DEFAULT_QUEUED_JOBS = 1024
const DEFAULT_PENDING_BYTES = 8 * 1024 * 1024
const HISTORY_LIMIT = 128
const QUALIFIED_TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure'])

interface Job {
  readonly id: string
  readonly work: BackgroundWork
  readonly queuedAt: number
  readonly controller: AbortController
  startedAt?: number
}
interface SessionState {
  readonly sessionID: string
  closed: boolean
  codexActive: number
  readonly lifecycle: AbortController
  parent?: AbortSignal
  unbindParent?: () => void
  readonly active: Map<string, Job>
  readonly tasks: Map<string, Promise<void>>
  readonly queue: Job[]
  pending: readonly BackgroundDelivery[]
  pendingBytes: number
  readonly history: BackgroundRecord[]
  readonly waiters: Set<() => void>
  deliveryTail: Promise<void>
  readonly wakes: Map<string, { readonly controller: AbortController; readonly task: Promise<void> }>
  observerFailures: number
}
export interface BackgroundOptions {
  readonly maxQueuedJobs?: number
  readonly maxPendingBytes?: number
  readonly onEvent?: (record: BackgroundRecord) => Promise<void> | void
  readonly wake?: (notice: { readonly sessionID: string; readonly delivery: BackgroundDelivery; readonly signal: AbortSignal }) => Promise<void> | void
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(freeze)
    Object.freeze(value)
  }
  return value
}

function deliveryBytes(delivery: BackgroundDelivery): number { return Buffer.byteLength(JSON.stringify(delivery)) }

export class BackgroundManager implements BackgroundExecutor {
  readonly supportsRewake: boolean
  private readonly states = new Map<string, SessionState>()
  private readonly maxQueued: number
  private readonly maxBytes: number
  private disposed = false
  private readonly options: BackgroundOptions

  constructor(options: BackgroundOptions = {}) {
    this.options = { ...options }
    this.maxQueued = options.maxQueuedJobs ?? DEFAULT_QUEUED_JOBS
    this.maxBytes = options.maxPendingBytes ?? DEFAULT_PENDING_BYTES
    if (!Number.isSafeInteger(this.maxQueued) || this.maxQueued < 0 || !Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1) throw new HookServiceError('BACKGROUND_LIMIT_INVALID')
    this.supportsRewake = typeof options.wake === 'function'
  }

  beginSession(sessionID: string): void {
    if (this.disposed) throw new HookServiceError('BACKGROUND_DISPOSED')
    const existing = this.states.get(sessionID)
    if (existing && !existing.closed) return
    if (existing && (existing.active.size || existing.wakes.size)) throw new HookServiceError('BACKGROUND_SESSION_BUSY')
    this.states.set(sessionID, {
      sessionID, closed: false, codexActive: 0, lifecycle: new AbortController(), active: new Map(), tasks: new Map(), queue: [],
      pending: [], pendingBytes: 0, history: [], waiters: new Set(), deliveryTail: Promise.resolve(), wakes: new Map(), observerFailures: 0,
    })
  }

  enqueue(input: BackgroundWork): BackgroundSubmission {
    if (this.disposed) return { status: 'failed', code: 'BACKGROUND_DISPOSED' }
    if (!isBackground(input.registration)) return { status: 'failed', code: 'BACKGROUND_REGISTRATION_INVALID' }
    if (input.registration.dialect === 'claude-code' && input.registration.handler.asyncRewake === true && !this.supportsRewake) return { status: 'unsupported', code: 'HOST_ASYNC_REWAKE_UNAVAILABLE' }
    const sessionID = input.event.sessionID
    if (!this.states.has(sessionID)) this.beginSession(sessionID)
    const state = this.states.get(sessionID)!
    if (state.closed) return { status: 'failed', code: 'BACKGROUND_SESSION_CLOSED' }
    if (input.sessionSignal) {
      if (state.parent && state.parent !== input.sessionSignal) return { status: 'failed', code: 'BACKGROUND_SESSION_SIGNAL_CONFLICT' }
      if (!state.parent) {
        state.parent = input.sessionSignal
        const abort = () => { void this.disposeSession(sessionID) }
        state.parent.addEventListener('abort', abort, { once: true })
        state.unbindParent = () => state.parent?.removeEventListener('abort', abort)
      }
      if (input.sessionSignal.aborted) { void this.disposeSession(sessionID); return { status: 'failed', code: 'BACKGROUND_SESSION_CLOSED' } }
    }
    const queued = input.registration.dialect === 'codex' && state.codexActive >= CODEX_CONCURRENCY
    if (queued && state.queue.length >= this.maxQueued) return { status: 'failed', code: 'BACKGROUND_QUEUE_LIMIT' }
    const { signal: _turnSignal, ...invocation } = input.invocation
    const work: BackgroundWork = {
      registration: structuredClone(input.registration), event: structuredClone(input.event),
      invocation: { ...invocation, env: { ...invocation.env }, ...(invocation.args ? { args: [...invocation.args] } : {}), ...(invocation.shell ? { shell: { program: invocation.shell.program, args: [...invocation.shell.args] } } : {}) },
    }
    const job: Job = { id: randomUUID(), work, queuedAt: performance.now(), controller: new AbortController() }
    state.queue.push(job)
    this.record(state, job, 'queued', 'BACKGROUND_QUEUED')
    this.pump(state)
    return { status: 'accepted', code: 'BACKGROUND_QUEUED', id: job.id }
  }

  inspect(sessionID: string) {
    const state = this.states.get(sessionID)
    return Object.freeze({
      active: state?.active.size ?? 0, queued: state?.queue.length ?? 0, pending: state?.pending.length ?? 0,
      waking: state?.wakes.size ?? 0, closed: state?.closed ?? this.disposed, observerFailures: state?.observerFailures ?? 0,
      history: Object.freeze([...(state?.history ?? [])]),
    })
  }

  waitForIdle(sessionID: string): Promise<void> {
    const state = this.states.get(sessionID)
    if (!state || (!state.active.size && !state.queue.length && !state.wakes.size)) return Promise.resolve()
    return new Promise(resolve => state.waiters.add(resolve))
  }

  hasPending(sessionID: string, jobID: string): boolean { return this.states.get(sessionID)?.pending.some(row => row.id === jobID) === true }

  deliver(sessionID: string, mode: BackgroundDelivery['mode'], apply: (records: readonly BackgroundDelivery[], signal: AbortSignal) => Promise<void> | void): Promise<void> {
    const state = this.states.get(sessionID)
    if (!state) return Promise.resolve()
    const task = state.deliveryTail.then(async () => {
      if (state.closed) return
      const batch = state.pending.filter(delivery => delivery.mode === mode && !state.wakes.has(delivery.id))
      if (!batch.length) return
      try {
        await runService(null, state.lifecycle.signal, signal => Promise.resolve(apply(Object.freeze(batch), signal)))
        if (!state.closed) this.removePending(state, new Set(batch.map(delivery => delivery.id)))
      } catch {
        for (const delivery of batch) this.deliveryFailure(state, delivery, 'delivery-failed', 'BACKGROUND_DELIVERY_FAILED')
        throw new HookServiceError(state.closed ? 'BACKGROUND_SESSION_CLOSED' : 'BACKGROUND_DELIVERY_FAILED')
      }
    })
    state.deliveryTail = task.catch(() => {})
    return task
  }

  async disposeSession(sessionID: string): Promise<void> {
    const state = this.states.get(sessionID)
    if (!state) return
    state.closed = true
    state.unbindParent?.()
    delete state.unbindParent
    delete state.parent
    state.lifecycle.abort()
    state.pending = []
    state.pendingBytes = 0
    for (const job of state.queue.splice(0)) this.record(state, job, 'completed', 'EXECUTION_CANCELLED', 'cancelled')
    for (const job of state.active.values()) job.controller.abort()
    for (const wake of state.wakes.values()) wake.controller.abort()
    this.settle(state)
    await Promise.allSettled([...state.tasks.values(), ...[...state.wakes.values()].map(wake => wake.task), state.deliveryTail])
  }

  async dispose(): Promise<void> {
    this.disposed = true
    await Promise.all([...this.states.keys()].map(sessionID => this.disposeSession(sessionID)))
    this.states.clear()
  }

  private start(state: SessionState, job: Job): void {
    job.startedAt = performance.now()
    state.active.set(job.id, job)
    if (job.work.registration.dialect === 'codex') state.codexActive++
    const task = this.run(state, job)
    state.tasks.set(job.id, task)
    void task.then(() => state.tasks.delete(job.id))
    this.record(state, job, 'running', 'BACKGROUND_RUNNING')
  }

  private async run(state: SessionState, job: Job): Promise<void> {
    const { registration, event, invocation } = job.work
    let effect: HookEffect | undefined
    let cancelled = false
    try {
      const execution = await runCommand({
        ...invocation, signal: job.controller.signal, captureProcessIdentity: true,
        timeoutMs: registration.dialect === 'claude-code' && registration.handler.asyncRewake !== true ? null : invocation.timeoutMs,
      })
      cancelled = execution.status === 'cancelled'
      effect = interpretOutput(registration, event, execution, { mode: 'background' })
      const retainCompletion = execution.status === 'exited' && (registration.dialect === 'claude-code' && registration.handler.asyncRewake !== true || effect.actions.length > 0)
      if (!state.closed && (effect.actions.length || retainCompletion)) {
        const source = { ...event.data, ...event.dialectData?.['claude-code'] }.source
        const qualifier = QUALIFIED_TOOL_EVENTS.has(event.event) && event.tool ? toolIdentity(registration.dialect, event.tool, event.host) : event.event === 'SessionStart' && typeof source === 'string' ? source : undefined
        const hookName = registration.dialect === 'claude-code' && qualifier ? registration.event + ':' + qualifier : undefined
        const delivery = freeze({ id: job.id, sourceID: registration.sourceID, ...(registration.sourceDigest ? { sourceDigest: registration.sourceDigest } : {}), registrationID: registration.id, dialect: registration.dialect, event: registration.event, ...(hookName ? { hookName } : {}), mode: effect.actions.some(action => action.kind === 'native-extension' && action.name === 'asyncRewake') ? 'wake' as const : 'safe-point' as const, actions: structuredClone(effect.actions), ...(retainCompletion ? { completion: { completedAt: Date.now(), execution: { ...execution } } } : {}) })
        const bytes = deliveryBytes(delivery)
        if (state.pendingBytes + bytes > this.maxBytes) {
          effect = { ...effect, status: 'failed', code: 'BACKGROUND_DELIVERY_LIMIT', actions: [] }
        } else {
          state.pending = [...state.pending, delivery]
          state.pendingBytes += bytes
          if (delivery.mode === 'wake') this.startWake(state, job, delivery)
        }
      }
      this.record(state, job, 'completed', effect.code, cancelled ? 'cancelled' : effect.status, effect.diagnostic.durationMs, effect.diagnostic.invalidFields)
    } catch {
      this.record(state, job, 'completed', 'BACKGROUND_EXECUTION_FAILED', 'failed')
    } finally {
      state.active.delete(job.id)
      if (registration.dialect === 'codex') state.codexActive--
      this.pump(state)
      this.settle(state)
    }
  }

  private pump(state: SessionState): void {
    while (!state.closed) {
      const index = state.queue.findIndex(job => job.work.registration.dialect !== 'codex' || state.codexActive < CODEX_CONCURRENCY)
      if (index < 0) return
      this.start(state, state.queue.splice(index, 1)[0]!)
    }
  }

  private startWake(state: SessionState, job: Job, delivery: BackgroundDelivery): void {
    const task = runService(null, job.controller.signal, signal => Promise.resolve(this.options.wake!({ sessionID: job.work.event.sessionID, delivery, signal })))
      .then(() => { if (!state.closed) this.removePending(state, new Set([delivery.id])) })
      .catch(() => { if (!state.closed) this.deliveryFailure(state, delivery, 'wake-failed', 'BACKGROUND_WAKE_FAILED') })
      .finally(() => { state.wakes.delete(job.id); this.settle(state) })
    state.wakes.set(job.id, { controller: job.controller, task })
  }

  private removePending(state: SessionState, ids: ReadonlySet<string>): void {
    state.pending = state.pending.filter(delivery => !ids.has(delivery.id))
    state.pendingBytes = state.pending.reduce((sum, delivery) => sum + deliveryBytes(delivery), 0)
  }

  private settle(state: SessionState): void {
    if (state.active.size || state.queue.length || state.wakes.size) return
    for (const resolve of state.waiters) resolve()
    state.waiters.clear()
  }

  private record(state: SessionState, job: Job, phase: BackgroundRecord['phase'], code: string, outcome?: BackgroundRecord['outcome'], durationMs = 0, invalidFields?: readonly string[]): void {
    const registration = job.work.registration
    this.emit(state, freeze({ jobID: job.id, sessionID: state.sessionID, sourceID: registration.sourceID, ...(registration.sourceDigest ? { sourceDigest: registration.sourceDigest } : {}), registrationID: registration.id, dialect: registration.dialect, event: registration.event, phase, code, queuedMs: Math.round((job.startedAt ?? performance.now()) - job.queuedAt), durationMs, ...(outcome ? { outcome } : {}), ...(invalidFields ? { invalidFields } : {}) }))
  }

  private deliveryFailure(state: SessionState, delivery: BackgroundDelivery, phase: 'delivery-failed' | 'wake-failed', code: string): void {
    this.emit(state, Object.freeze({ jobID: delivery.id, sessionID: state.sessionID, sourceID: delivery.sourceID, ...(delivery.sourceDigest ? { sourceDigest: delivery.sourceDigest } : {}), registrationID: delivery.registrationID, dialect: delivery.dialect, event: delivery.event, phase, code, queuedMs: 0, durationMs: 0, outcome: 'failed' }))
  }

  private emit(state: SessionState, record: BackgroundRecord): void {
    if (record.phase === 'completed' || record.phase === 'delivery-failed' || record.phase === 'wake-failed') {
      state.history.push(record)
      if (state.history.length > HISTORY_LIMIT) state.history.shift()
    }
    try {
      const observed = this.options.onEvent?.(record)
      if (observed) void Promise.resolve(observed).catch(() => { state.observerFailures++ })
    } catch { state.observerFailures++ }
  }
}
