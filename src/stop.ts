import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import type { HostVersion, Dialect } from './contracts.js'
import { dispatchEvent } from './engine.js'
import type { DispatchResult } from './engine.js'
import { resolveEffects } from './effects.js'
import type { EffectResolution } from './effects.js'
import { nativeSkip } from './handlers.js'
import { snapshotCommandContexts } from './host-services.js'
import type { HostServices } from './host-services.js'
import { HostHookError } from './hosts/tools.js'
import { selectRegistrations } from './matchers.js'
import { buildPayload, PayloadError } from './payload.js'
import { HookServiceError, runService } from './service-execution.js'
import { SessionError } from './sessions.js'
import type { Sessions, SessionSnapshot } from './sessions.js'
import type { SessionStarts } from './session-start.js'
import type { LoadedSource, NativeEvent } from './types.js'

const MAX_COMPLETIONS = 10000
const MAX_ID_BYTES = 4096
const MAX_INPUT_BYTES = 8 * 1024 * 1024
const MAX_BYTES = 32 * 1024 * 1024
const SERVICE_TIMEOUT_MS = 5000

export interface StopEvent extends NativeEvent {
  readonly host: HostVersion
  readonly event: 'Stop'
  readonly messageID: string
  readonly completionID: string
}
export interface StopReceipt {
  readonly host: HostVersion
  readonly sessionID: string
  readonly messageID: string
  readonly completionID: string
  readonly dispatchID: string
  readonly control: 'continue' | 'complete' | 'stop'
}
export interface StopDelivery {
  readonly event: StopEvent
  readonly session: SessionSnapshot
  readonly dispatch: DispatchResult
  readonly effects: EffectResolution
  readonly signal: AbortSignal
}
export interface StopDiagnostic {
  readonly host: HostVersion
  readonly event: 'Stop'
  readonly sessionID?: string
  readonly messageID?: string
  readonly completionID?: string
  readonly dispatchID?: string
  readonly sourceID?: string
  readonly registrationID?: string
  readonly dialect?: Dialect
  readonly field?: string
  readonly phase: 'preflight' | 'dispatch' | 'admission' | 'drain'
  readonly code: string
  readonly outcome: HostHookError['outcome'] | 'success'
  readonly durationMs: number
}
export interface StopServices {
  readonly admit: (delivery: StopDelivery) => Promise<void>
  readonly diagnostic?: (value: StopDiagnostic) => Promise<void> | void
  readonly maxCompletions?: number
  readonly serviceTimeoutMs?: number
}
interface Options {
  readonly host: HostVersion
  readonly sources: readonly LoadedSource[]
  readonly sessions: Sessions
  readonly hostServices: HostServices
  readonly permissionMode?: string
  readonly starts?: Pick<SessionStarts, 'wait'>
  readonly services: StopServices
  readonly observe: (result: DispatchResult) => DispatchResult
}
interface Turn { readonly signal: AbortSignal; active: boolean }
interface Completion { readonly fingerprint: string; readonly signal: AbortSignal; readonly pending: Promise<StopReceipt>; readonly bytes: number }
interface State { readonly signal: AbortSignal; readonly completions: Map<string, Completion>; readonly cleanup: () => void; turn: Turn; busy: boolean }
type Attribution = Pick<StopDiagnostic, 'sourceID' | 'registrationID' | 'dialect' | 'field'>
function fail(code: string, outcome: HostHookError['outcome'] = 'unsupported'): never { throw new HostHookError(code, outcome) }
function validID(value: unknown): value is string { return typeof value === 'string' && !!value && !value.includes('\0') && Buffer.byteLength(value) <= MAX_ID_BYTES }
function freeze<T>(value: T): T { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) } return value }
function snapshot<T>(value: T): T {
  try {
    const text = JSON.stringify(value, (_key, item: unknown) => {
      if (typeof item === 'number' && !Number.isFinite(item) || ['bigint', 'symbol', 'function'].includes(typeof item)) throw new Error()
      return item
    })
    if (text === undefined) fail('HOST_STOP_INPUT_INVALID')
    if (Buffer.byteLength(text) > MAX_INPUT_BYTES) fail('HOST_STOP_INPUT_LIMIT')
    return freeze(JSON.parse(text) as T)
  } catch (error) { if (error instanceof HostHookError) throw error; return fail('HOST_STOP_INPUT_INVALID') }
}
function fingerprint(value: unknown): string {
  const text = JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, (item as Record<string, unknown>)[key]])) : item)
  return createHash('sha256').update(text).digest('hex')
}
function normalize(error: unknown, phase: StopDiagnostic['phase'], signal?: AbortSignal): HostHookError {
  if (signal?.aborted || error instanceof HookServiceError && error.code === 'EXECUTION_CANCELLED' || error instanceof SessionError && ['SESSION_CLOSED', 'SESSION_DISPOSED'].includes(error.code)) return new HostHookError('HOST_STOP_CANCELLED', 'cancelled')
  if (error instanceof HostHookError) return new HostHookError(error.code, error.outcome)
  if (error instanceof HookServiceError && error.code === 'EXECUTION_TIMEOUT') return new HostHookError(phase === 'drain' ? 'HOST_STOP_ADMISSION_DRAIN_FAILED' : 'HOST_STOP_ADMISSION_TIMEOUT', 'failed')
  return new HostHookError(phase === 'admission' ? 'HOST_STOP_ADMISSION_FAILED' : 'HOST_STOP_FAILED', 'failed')
}

export class Stops {
  private readonly sources: readonly LoadedSource[]
  private readonly hostServices: HostServices
  private readonly admit: StopServices['admit']
  private readonly diagnostic: NonNullable<StopServices['diagnostic']>
  private readonly limit: number
  private readonly timeout: number
  private readonly lifetime = new AbortController()
  private readonly states = new Map<string, State>()
  private readonly active = new Set<Promise<StopReceipt>>()
  private readonly admissions = new Set<Promise<void>>()
  private retained = 0
  private bytes = 0
  private observerFailures = 0
  private disposing: Promise<void> | undefined

  constructor(private readonly options: Options) {
    this.limit = options.services.maxCompletions ?? MAX_COMPLETIONS
    this.timeout = options.services.serviceTimeoutMs ?? SERVICE_TIMEOUT_MS
    if (options.host !== 'v2' || typeof options.services.admit !== 'function' || !Number.isSafeInteger(this.limit) || this.limit < 1 || this.limit > MAX_COMPLETIONS || !Number.isFinite(this.timeout) || this.timeout <= 0) fail('HOST_STOP_OPTIONS_INVALID')
    this.sources = snapshot(options.sources)
    this.hostServices = snapshotCommandContexts({ ...options.hostServices, environment: { ...options.hostServices.environment } })
    this.admit = options.services.admit
    this.diagnostic = options.services.diagnostic ?? (value => { console.error(JSON.stringify({ component: 'opencode-harness-hooks', ...value })) })
  }

  complete(input: StopEvent): Promise<StopReceipt> {
    const started = performance.now()
    let attribution: Attribution = {}
    try {
      if (this.lifetime.signal.aborted) fail('HOST_STOP_DISPOSED', 'cancelled')
      const copied = snapshot(input)
      if (!copied || copied.event !== 'Stop' || !validID(copied.sessionID) || !validID(copied.messageID) || !validID(copied.completionID) || !validID(copied.cwd) || !isAbsolute(copied.cwd)) fail('HOST_STOP_INPUT_INVALID')
      if (copied.host !== this.options.host) fail('HOST_VERSION_MISMATCH')
      const session = this.options.sessions.get(copied.sessionID)
      if (session.turnID !== copied.messageID) fail('SESSION_STALE_TURN', 'cancelled')
      if (session.signal.aborted || session.turnSignal.aborted) fail('HOST_STOP_CANCELLED', 'cancelled')
      let state = this.states.get(copied.sessionID)
      if (state && state.signal !== session.signal) fail('HOST_STOP_SESSION_MISMATCH')
      const identity = fingerprint([copied, session.model ?? null])
      const previous = state?.completions.get(copied.completionID)
      if (previous) {
        if (previous.fingerprint !== identity) fail('HOST_STOP_IDENTITY_CONFLICT')
        if (previous.signal !== session.turnSignal) fail('HOST_STOP_STALE', 'cancelled')
        return previous.pending
      }
      const turn: Turn = state?.turn.signal === session.turnSignal ? state.turn : { signal: session.turnSignal, active: false }
      if (state?.busy) fail('HOST_STOP_OVERLAP_UNVERIFIED')
      const bytes = Buffer.byteLength(JSON.stringify(copied))
      if (this.retained >= this.limit || this.bytes + bytes > MAX_BYTES) fail('HOST_STOP_LIMIT')
      for (const data of [copied.data, ...Object.values(copied.dialectData ?? {})]) {
        if (data?.stop_hook_active !== undefined || data?.turn_id !== undefined && data.turn_id !== session.turnID || data?.prompt_id !== undefined && data.prompt_id !== session.turnID) fail('HOST_STOP_METADATA_CONFLICT')
      }
      const event: StopEvent = freeze({ ...copied, data: { ...(this.options.permissionMode ? { permission_mode: this.options.permissionMode } : {}), ...(session.model ? { model: session.model } : {}), transcript_path: null, ...copied.data, turn_id: session.turnID, prompt_id: session.turnID, stop_hook_active: turn.active } })
      const selected = this.sources.flatMap(source => source.registrations.filter(registration => {
        try { return selectRegistrations([{ ...source, registrations: [registration] }], event).length > 0 } catch { return false }
      })).filter(registration => !nativeSkip(registration, event))
      for (const registration of selected) {
        attribution = { sourceID: registration.sourceID, registrationID: registration.id, dialect: registration.dialect }
        try { buildPayload(registration, event) } catch (error) {
          const field = error instanceof PayloadError ? /^PAYLOAD_(?:MISSING|INVALID):([a-z_]+)$/.exec(error.message)?.[1] : undefined
          if (field) attribution = { ...attribution, field }
          fail('HOST_NATIVE_METADATA_UNAVAILABLE')
        }
        const data = { ...event.data, ...event.dialectData?.[registration.dialect] }
        for (const field of ['last_assistant_message', ...(registration.dialect === 'claude-code' ? ['background_tasks', 'session_crons'] : [])]) {
          const valid = field === 'last_assistant_message' ? typeof data[field] === 'string' || registration.dialect === 'codex' && data[field] === null : Array.isArray(data[field])
          if (!valid) { attribution = { ...attribution, field }; fail('HOST_NATIVE_METADATA_UNAVAILABLE') }
        }
      }
      if (!state) {
        const cleanup = () => {
          const current = this.states.get(session.sessionID)
          if (!current) return
          for (const row of current.completions.values()) { this.retained--; this.bytes -= row.bytes }
          this.states.delete(session.sessionID)
          session.signal.removeEventListener('abort', cleanup)
        }
        state = { signal: session.signal, turn, busy: false, completions: new Map(), cleanup }
        this.states.set(session.sessionID, state)
        session.signal.addEventListener('abort', cleanup, { once: true })
      }
      state.turn = turn
      state.busy = true
      const currentState = state
      const signal = AbortSignal.any([session.signal, session.turnSignal, this.lifetime.signal])
      let phase: StopDiagnostic['phase'] = 'dispatch'
      let dispatchID: string | undefined
      let pendingAdmission: Promise<void> | undefined
      const work = Promise.resolve().then(async () => {
        if (signal.aborted) fail('HOST_STOP_CANCELLED', 'cancelled')
        if (this.options.starts) await runService(null, signal, () => this.options.starts!.wait(event.sessionID))
        if (signal.aborted) fail('HOST_STOP_CANCELLED', 'cancelled')
        const dispatch = this.options.observe(await dispatchEvent(this.sources, event, { ...this.hostServices, captureCommandArtifacts: true, signal, sessionSignal: session.signal }))
        dispatchID = dispatch.diagnostic.dispatchID
        if (signal.aborted || dispatch.cancelled) fail('HOST_STOP_CANCELLED', 'cancelled')
        if (dispatch.diagnostic.unsupported) fail('HOST_STOP_HANDLER_UNAVAILABLE')
        const effects = resolveEffects(dispatch)
        phase = 'admission'
        await runService(this.timeout, signal, current => {
          const admission = Promise.resolve().then(() => {
            if (current.aborted) fail('HOST_STOP_CANCELLED', 'cancelled')
            return this.admit({ event, session, dispatch, effects, signal: current })
          })
          pendingAdmission = admission
          this.admissions.add(admission)
          void admission.finally(() => { this.admissions.delete(admission) }).catch(() => {})
          return admission
        })
        if (signal.aborted) fail('HOST_STOP_CANCELLED', 'cancelled')
        const control = effects.stop ? 'stop' : effects.continuations.length ? 'continue' : 'complete'
        if (control === 'continue') turn.active = true
        const receipt: StopReceipt = Object.freeze({ host: event.host, sessionID: event.sessionID, messageID: event.messageID, completionID: event.completionID, dispatchID, control })
        this.emit(event, phase, 'STOP_ADMITTED', 'success', started, dispatchID)
        return receipt
      }).catch((error: unknown) => {
        const failure = normalize(error, phase, signal)
        this.emit(event, phase, failure.code, failure.outcome, started, dispatchID)
        throw failure
      }).finally(() => {
        const release = () => { currentState.busy = false }
        if (pendingAdmission && this.admissions.has(pendingAdmission)) void pendingAdmission.finally(release).catch(() => {})
        else release()
      })
      state.completions.set(event.completionID, { fingerprint: identity, signal: session.turnSignal, pending: work, bytes })
      this.retained++; this.bytes += bytes
      this.active.add(work)
      void work.finally(() => { this.active.delete(work) }).catch(() => {})
      return work
    } catch (error) {
      const failure = normalize(error, 'preflight')
      this.emit(input, 'preflight', failure.code, failure.outcome, started, undefined, attribution)
      return Promise.reject(failure)
    }
  }

  dispose(): Promise<void> {
    this.disposing ??= (async () => {
      const started = performance.now()
      this.lifetime.abort()
      await Promise.allSettled([...this.active])
      try { await runService(this.timeout, undefined, async () => { await Promise.allSettled([...this.admissions]) }) } catch (error) {
        const failure = normalize(error, 'drain')
        this.emit(undefined, 'drain', failure.code, failure.outcome, started)
        throw failure
      }
      for (const state of this.states.values()) state.cleanup()
    })().finally(() => { this.disposing = undefined })
    return this.disposing
  }

  inspect() { return Object.freeze({ active: this.active.size, admissions: this.admissions.size, retained: this.retained, bytes: this.bytes, limit: this.limit, disposed: this.lifetime.signal.aborted, observerFailures: this.observerFailures }) }

  private emit(event: Partial<StopEvent> | undefined, phase: StopDiagnostic['phase'], code: string, outcome: StopDiagnostic['outcome'], started: number, dispatchID?: string, attribution: Attribution = {}): void {
    const value: StopDiagnostic = Object.freeze({ host: this.options.host, event: 'Stop', ...(validID(event?.sessionID) ? { sessionID: event.sessionID } : {}), ...(validID(event?.messageID) ? { messageID: event.messageID } : {}), ...(validID(event?.completionID) ? { completionID: event.completionID } : {}), ...(dispatchID ? { dispatchID } : {}), ...attribution, phase, code, outcome, durationMs: Math.round(performance.now() - started) })
    try { const observed = this.diagnostic(value); if (observed) void Promise.resolve(observed).catch(() => { this.observerFailures++ }) } catch { this.observerFailures++ }
  }
}
