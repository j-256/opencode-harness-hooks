import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { performance } from 'node:perf_hooks'
import { ClaudeEnvironmentError, ClaudeEnvironmentFiles } from './claude-environment-files.js'
import type { ClaudeEnvironmentPlan } from './claude-environment-files.js'
import { dispatchEvent } from './engine.js'
import type { DispatchResult } from './engine.js'
import { nativeSkip } from './handlers.js'
import { snapshotCommandContexts } from './host-services.js'
import type { HostServices } from './host-services.js'
import { HostHookError } from './hosts/tools.js'
import { selectRegistrations } from './matchers.js'
import { buildPayload, PayloadError } from './payload.js'
import { HookServiceError, runService } from './service-execution.js'
import { SessionError } from './sessions.js'
import type { Sessions, SessionSnapshot } from './sessions.js'
import type { Dialect, HostVersion } from './contracts.js'
import type { LoadedSource, NativeEvent } from './types.js'

const DEFAULT_ACTIVATIONS = 1024
const SERVICE_TIMEOUT_MS = 5000
const MAX_ID_BYTES = 4096
const MAX_INPUT_BYTES = 8 * 1024 * 1024

export interface SessionStartEvent extends NativeEvent {
  readonly host: HostVersion
  readonly event: 'SessionStart'
  readonly activationID: string
}
export interface SessionStartReceipt {
  readonly host: HostVersion
  readonly sessionID: string
  readonly activationID: string
  readonly dispatchID: string
  readonly handlers: number
  readonly failed: number
  readonly background: number
}
export interface SessionStartDelivery {
  readonly event: SessionStartEvent
  readonly session: SessionSnapshot
  readonly dispatch: DispatchResult
  readonly environment?: ClaudeEnvironmentPlan
  readonly signal: AbortSignal
}
export interface SessionStartDiagnostic {
  readonly host: HostVersion
  readonly event: 'SessionStart'
  readonly sessionID?: string
  readonly activationID?: string
  readonly dispatchID?: string
  readonly sourceID?: string
  readonly registrationID?: string
  readonly dialect?: Dialect
  readonly field?: string
  readonly phase: 'preflight' | 'environment' | 'dispatch' | 'admission' | 'barrier'
  readonly code: string
  readonly outcome: HostHookError['outcome'] | 'success'
  readonly durationMs: number
}
export interface SessionStartServices {
  readonly environmentDirectory?: string
  readonly admit: (delivery: SessionStartDelivery) => Promise<void>
  readonly diagnostic?: (value: SessionStartDiagnostic) => Promise<void> | void
  readonly maxActivations?: number
  readonly serviceTimeoutMs?: number
}
interface Options {
  readonly host: HostVersion
  readonly sources: readonly LoadedSource[]
  readonly sessions: Sessions
  readonly hostServices: HostServices
  readonly permissionMode?: string
  readonly services: SessionStartServices
  readonly observe: (result: DispatchResult) => DispatchResult
}
interface State {
  readonly activationID: string
  readonly fingerprint: string
  readonly pending: Promise<SessionStartReceipt>
  phase: 'pending' | 'ready' | 'failed'
  error?: HostHookError
}
type Attribution = Pick<SessionStartDiagnostic, 'sourceID' | 'registrationID' | 'dialect' | 'field'>

function fail(code: string, outcome: HostHookError['outcome'] = 'unsupported'): never { throw new HostHookError(code, outcome) }
function validID(value: unknown): value is string { return typeof value === 'string' && !!value && !value.includes('\0') && Buffer.byteLength(value) <= MAX_ID_BYTES }
function freeze<T>(value: T): T { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) } return value }
function snapshot<T>(value: T): T {
  try {
    const text = JSON.stringify(value, (_key, item: unknown) => {
      if (typeof item === 'number' && !Number.isFinite(item) || ['function', 'bigint', 'symbol'].includes(typeof item)) throw new Error()
      return item
    })
    if (Buffer.byteLength(text) > MAX_INPUT_BYTES) fail('HOST_SESSION_START_INPUT_LIMIT')
    return freeze(JSON.parse(text) as T)
  } catch (error) { if (error instanceof HostHookError) throw error; return fail('HOST_SESSION_START_INPUT_INVALID') }
}
function eventFingerprint(event: SessionStartEvent): string {
  const text = JSON.stringify(event, (_key, value: unknown) => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, (value as Record<string, unknown>)[key]])) : value)
  return createHash('sha256').update(text).digest('hex')
}
function normalize(error: unknown, phase: SessionStartDiagnostic['phase'], signal?: AbortSignal): HostHookError {
  if (signal?.aborted || error instanceof HookServiceError && error.code === 'EXECUTION_CANCELLED' || error instanceof SessionError && ['SESSION_CLOSED', 'SESSION_DISPOSED'].includes(error.code)) return new HostHookError('HOST_SESSION_START_CANCELLED', 'cancelled')
  if (error instanceof HostHookError) return new HostHookError(error.code, error.outcome)
  if (error instanceof ClaudeEnvironmentError) return new HostHookError(error.code, 'unsupported')
  if (error instanceof HookServiceError && error.code === 'EXECUTION_TIMEOUT') return new HostHookError(phase === 'admission' ? 'HOST_SESSION_START_ADMISSION_TIMEOUT' : 'HOST_SESSION_START_ENVIRONMENT_TIMEOUT', 'failed')
  return new HostHookError(phase === 'admission' ? 'HOST_SESSION_START_ADMISSION_FAILED' : 'HOST_SESSION_START_FAILED', 'failed')
}

export class SessionStarts {
  private readonly sources: readonly LoadedSource[]
  private readonly hostServices: HostServices
  private readonly environments: ClaudeEnvironmentFiles | undefined
  private readonly admit: SessionStartServices['admit']
  private readonly diagnostic: NonNullable<SessionStartServices['diagnostic']>
  private readonly limit: number
  private readonly serviceTimeout: number
  private readonly lifetime = new AbortController()
  private readonly states = new Map<string, State>()
  private readonly current = new Map<string, string>()
  private readonly active = new Set<Promise<SessionStartReceipt>>()
  private observerFailures = 0

  constructor(private readonly options: Options) {
    this.limit = options.services.maxActivations ?? DEFAULT_ACTIVATIONS
    this.serviceTimeout = options.services.serviceTimeoutMs ?? SERVICE_TIMEOUT_MS
    if (!Number.isSafeInteger(this.limit) || this.limit < 1 || this.limit > DEFAULT_ACTIVATIONS || !Number.isFinite(this.serviceTimeout) || this.serviceTimeout <= 0 || typeof options.services.admit !== 'function') fail('HOST_SESSION_START_OPTIONS_INVALID')
    this.sources = snapshot(options.sources)
    this.hostServices = snapshotCommandContexts({ ...options.hostServices, environment: { ...options.hostServices.environment } })
    this.admit = options.services.admit
    this.diagnostic = options.services.diagnostic ?? (value => { console.error(JSON.stringify({ component: 'opencode-harness-hooks', ...value })) })
    this.environments = options.services.environmentDirectory === undefined ? undefined : new ClaudeEnvironmentFiles({ directory: options.services.environmentDirectory, sources: this.sources })
  }

  start(input: SessionStartEvent): Promise<SessionStartReceipt> {
    const started = performance.now()
    let attribution: Attribution = {}
    try {
      if (this.lifetime.signal.aborted) fail('HOST_SESSION_START_DISPOSED', 'cancelled')
      const copied = snapshot(input)
      if (!copied || copied.event !== 'SessionStart' || !validID(copied.sessionID) || !validID(copied.activationID) || !validID(copied.cwd) || !isAbsolute(copied.cwd)) fail('HOST_SESSION_START_INPUT_INVALID')
      const event: SessionStartEvent = freeze({ ...copied, data: { ...(this.options.permissionMode ? { permission_mode: this.options.permissionMode } : {}), ...copied.data } })
      if (event.host !== this.options.host) fail('HOST_VERSION_MISMATCH')
      const key = JSON.stringify([event.sessionID, event.activationID])
      const fingerprint = eventFingerprint(event)
      const existing = this.states.get(key)
      if (existing) {
        if (existing.fingerprint !== fingerprint) fail('HOST_SESSION_START_IDENTITY_CONFLICT')
        if (this.current.get(event.sessionID) !== key) fail('HOST_SESSION_START_STALE', 'cancelled')
        this.options.sessions.get(event.sessionID)
        return existing.pending
      }
      if (this.states.size >= this.limit) fail('HOST_SESSION_START_LIMIT')
      const previous = this.current.get(event.sessionID)
      if (previous && this.states.get(previous)?.phase === 'pending') fail('HOST_SESSION_START_OVERLAP_UNVERIFIED')
      for (const source of this.sources) {
        if (!source.enabled || !source.registrations.some(registration => registration.event === 'SessionStart')) continue
        const value = { ...event.data, ...event.dialectData?.[source.dialect] }.source
        if (!validID(value)) { attribution = { sourceID: source.id, dialect: source.dialect, field: 'source' }; fail('HOST_SESSION_START_SOURCE_UNAVAILABLE') }
      }
      const selected = this.sources.flatMap(source => source.registrations.filter(registration => {
        try { return selectRegistrations([{ ...source, registrations: [registration] }], event).length > 0 } catch { return false }
      })).filter(registration => !nativeSkip(registration, event))
      for (const registration of selected) {
        try { buildPayload(registration, event) } catch (error) {
          const field = error instanceof PayloadError ? /^PAYLOAD_(?:MISSING|INVALID):([a-z_]+)$/.exec(error.message)?.[1] : undefined
          attribution = { sourceID: registration.sourceID, registrationID: registration.id, dialect: registration.dialect, ...(field ? { field } : {}) }
          fail('HOST_NATIVE_METADATA_UNAVAILABLE')
        }
      }
      const environmentCommands = selected.filter(registration => registration.dialect === 'claude-code' && registration.handler.type === 'command' && (registration.handler.args !== undefined || registration.handler.shell !== 'powershell'))
      if (environmentCommands.length && !this.environments) fail('HOST_ENVIRONMENT_FILE_UNAVAILABLE')
      const session = this.options.sessions.get(event.sessionID)
      const signal = AbortSignal.any([session.signal, this.lifetime.signal])
      let phase: SessionStartDiagnostic['phase'] = 'environment'
      let dispatchID: string | undefined
      const work = (async () => {
        const environment = environmentCommands.length ? await runService(this.serviceTimeout, signal, current => this.environments!.prepare(event.sessionID, environmentCommands, current)) : undefined
        if (signal.aborted) fail('HOST_SESSION_START_CANCELLED', 'cancelled')
        phase = 'dispatch'
        const dispatch = this.options.observe(await dispatchEvent(this.sources, event, { ...this.hostServices, ...(environment ? { registrationContext: environment.registrationContext } : {}), captureCommandArtifacts: true, signal, sessionSignal: session.signal }))
        dispatchID = dispatch.diagnostic.dispatchID
        if (signal.aborted) fail('HOST_SESSION_START_CANCELLED', 'cancelled')
        if (dispatch.diagnostic.unsupported) fail('HOST_SESSION_START_HANDLER_UNAVAILABLE')
        phase = 'admission'
        await runService(this.serviceTimeout, signal, current => this.admit({ event, session, dispatch, ...(environment ? { environment } : {}), signal: current }))
        if (signal.aborted) fail('HOST_SESSION_START_CANCELLED', 'cancelled')
        const receipt = Object.freeze({ host: event.host, sessionID: event.sessionID, activationID: event.activationID, dispatchID: dispatch.diagnostic.dispatchID, handlers: dispatch.entries.length, failed: dispatch.diagnostic.failed, background: dispatch.diagnostic.background })
        this.states.get(key)!.phase = 'ready'
        this.emit(event, phase, 'SESSION_START_ADMITTED', 'success', started, receipt.dispatchID)
        return receipt
      })().catch((error: unknown) => {
        const failure = normalize(error, phase, signal)
        const state = this.states.get(key)!
        state.phase = 'failed'; state.error = failure
        this.emit(event, phase, failure.code, failure.outcome, started, dispatchID)
        throw failure
      })
      this.states.set(key, { activationID: event.activationID, fingerprint, pending: work, phase: 'pending' })
      this.current.set(event.sessionID, key)
      this.active.add(work)
      void work.finally(() => { this.active.delete(work) }).catch(() => {})
      return work
    } catch (error) {
      const failure = normalize(error, 'preflight')
      this.emit(input, 'preflight', failure.code, failure.outcome, started, undefined, attribution)
      return Promise.reject(failure)
    }
  }

  wait(sessionID: string): Promise<SessionStartReceipt> {
    const started = performance.now()
    try { return this.state(sessionID).pending } catch (error) { return Promise.reject(this.barrierError(sessionID, error, started)) }
  }

  requireReady(sessionID: string): void {
    const started = performance.now()
    try {
      const state = this.state(sessionID)
      if (state.error) throw state.error
      if (state.phase !== 'ready') fail('HOST_SESSION_START_NOT_READY')
    } catch (error) { throw this.barrierError(sessionID, error, started) }
  }

  async dispose(): Promise<void> {
    this.lifetime.abort()
    await Promise.allSettled([...this.active])
    this.states.clear(); this.current.clear()
  }

  inspect() { return Object.freeze({ active: this.active.size, retained: this.states.size, limit: this.limit, disposed: this.lifetime.signal.aborted, observerFailures: this.observerFailures }) }

  private state(sessionID: string): State {
    if (this.lifetime.signal.aborted) fail('HOST_SESSION_START_DISPOSED', 'cancelled')
    const key = this.current.get(sessionID)
    if (!key) fail('HOST_SESSION_START_REQUIRED')
    try { this.options.sessions.get(sessionID) } catch (error) { throw normalize(error, 'barrier') }
    return this.states.get(key)!
  }

  private barrierError(sessionID: string, error: unknown, started: number): HostHookError {
    const failure = normalize(error, 'barrier')
    const key = this.current.get(sessionID)
    const state = key === undefined ? undefined : this.states.get(key)
    this.emit({ sessionID, ...(state ? { activationID: state.activationID } : {}) }, 'barrier', failure.code, failure.outcome, started)
    return failure
  }

  private emit(event: Partial<SessionStartEvent> | undefined, phase: SessionStartDiagnostic['phase'], code: string, outcome: SessionStartDiagnostic['outcome'], started: number, dispatchID?: string, attribution: Attribution = {}): void {
    const value: SessionStartDiagnostic = Object.freeze({ host: this.options.host, event: 'SessionStart', ...(validID(event?.sessionID) ? { sessionID: event.sessionID } : {}), ...(validID(event?.activationID) ? { activationID: event.activationID } : {}), ...(dispatchID ? { dispatchID } : {}), ...attribution, phase, code, outcome, durationMs: Math.round(performance.now() - started) })
    try { const observed = this.diagnostic(value); if (observed) void Promise.resolve(observed).catch(() => { this.observerFailures++ }) } catch { this.observerFailures++ }
  }
}
