import { resolve } from 'node:path'
import { HOST_VERSIONS } from './contracts.js'
import type { HostVersion } from './contracts.js'
import { dispatchEvent } from './engine.js'
import type { DispatchResult } from './engine.js'
import { nativeSkip } from './handlers.js'
import type { HostServices } from './host-services.js'
import { snapshotCommandContexts } from './host-services.js'
import { HostHookError } from './host-errors.js'
import type { HostToolEvent, ToolHostOptions } from './tool-types.js'
import type { HostPromptEvent, PromptDiagnostic } from './prompt-types.js'
import type { EffectResolution } from './effects.js'
import type { HostModelEvent, ArtifactDiagnostic } from './model-types.js'
import { selectRegistrations } from './matchers.js'
import { buildPayload, PayloadError } from './payload.js'
import { eventForDialect } from './native-event.js'
import { MAX_TOOL_RESULT_BYTES, v1ShellFailure } from './tool-failure.js'
import { inspectSources } from './inspection.js'
import type { RuntimeReport } from './inspection.js'
import { runService } from './service-execution.js'
import { SessionError, Sessions } from './sessions.js'
import type { SessionSnapshot } from './sessions.js'
import { SessionStarts } from './session-start.js'
import type { SessionStartEvent, SessionStartServices } from './session-start.js'
import { Stops } from './stop.js'
import type { StopEvent, StopServices } from './stop.js'
import type { TranscriptService } from './transcript.js'
import type { CodexTranscriptService } from './codex-transcript.js'
import type { JsonValue, LoadedSource, NativeEvent, Registration } from './types.js'

export type { RuntimeOptions, RuntimeReport } from './inspection.js'

const MAX_PROMPT_BYTES = 8 * 1024 * 1024
const STOP_HOST_CAPABILITY = 'awaited-completion-decision'
type NativeData = NonNullable<NativeEvent['dialectData']>

export interface RuntimeServices {
  readonly sessionStart?: SessionStartServices
  readonly stop?: StopServices
  readonly stopUnavailableCapability?: 'awaited-completion-decision' | 'verified-completion-adapter'
  readonly host?: Omit<HostServices, 'projectRoot' | 'signal' | 'sessionSignal'>
  readonly tools?: Omit<ToolHostOptions, 'dispatch'>
  readonly nativeData?: (event: HostToolEvent, session: SessionSnapshot, signal: AbortSignal) => Promise<NativeData>
  readonly promptData?: (event: HostPromptEvent, session: SessionSnapshot, signal: AbortSignal) => Promise<NativeData>
  readonly promptEffects?: (event: HostPromptEvent, effects: EffectResolution) => Promise<void>
  readonly promptDiagnostic?: (diagnostic: PromptDiagnostic) => Promise<void> | void
  readonly artifactDiagnostic?: (diagnostic: ArtifactDiagnostic) => Promise<void> | void
  readonly report?: (report: RuntimeReport) => Promise<void> | void
  readonly dispatchDiagnostic?: (diagnostic: DispatchResult['diagnostic']) => Promise<void> | void
  readonly transcripts?: TranscriptService
  readonly codexTranscripts?: CodexTranscriptService
}

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }

function matched(sources: readonly LoadedSource[], event: NativeEvent): readonly Registration[] {
  return sources.flatMap(source => source.registrations.filter(registration => {
    try { return selectRegistrations([{ ...source, registrations: [registration] }], event).length > 0 } catch { return false }
  }))
}

function resultData(event: HostToolEvent, failure = v1ShellFailure(event)): Record<string, JsonValue> {
  if (event.event === 'PreToolUse') return {}
  if (event.event === 'PostToolUseFailure') {
    if (failure) return { error: failure.error, is_interrupt: false }
    const error = typeof event.result === 'string' ? event.result : event.result instanceof Error ? event.result.message : record(event.result) && typeof event.result.message === 'string' ? event.result.message : undefined
    if (error === undefined || Buffer.byteLength(error) > MAX_TOOL_RESULT_BYTES) throw new HostHookError('HOST_TOOL_ERROR_UNAVAILABLE', 'unsupported')
    return { error }
  }
  try {
    const text = JSON.stringify(event.result, (_key, item: unknown) => {
      if (typeof item === 'number' && !Number.isFinite(item) || ['bigint', 'function', 'symbol'].includes(typeof item)) throw new Error()
      return item
    })
    if (text === undefined || Buffer.byteLength(text) > MAX_TOOL_RESULT_BYTES) throw new Error()
    return { tool_response: JSON.parse(text) as JsonValue }
  } catch { throw new HostHookError('HOST_TOOL_RESULT_UNAVAILABLE', 'unsupported') }
}

export async function createRuntime(host: HostVersion, directory: string, inputOptions: unknown, services: RuntimeServices = {}) {
  if (!Object.hasOwn(HOST_VERSIONS, host) || typeof directory !== 'string' || !directory) throw new HostHookError('HOST_INPUT_INVALID', 'failed')
  directory = resolve(directory)
  services = { ...services, ...(services.host ? { host: snapshotCommandContexts({ ...services.host, environment: { ...services.host.environment } }) } : {}), ...(services.tools ? { tools: { ...services.tools } } : {}), ...(services.sessionStart ? { sessionStart: { ...services.sessionStart } } : {}), ...(services.stop ? { stop: { ...services.stop } } : {}) }
  const environment = { ...(services.host?.environment ?? process.env) }
  const inspected = await inspectSources(host, directory, inputOptions)
  const { options, sources } = inspected
  const coreEvents = new Set([...(services.sessionStart ? ['SessionStart'] : []), ...(services.stop && host === 'v2' && !services.stopUnavailableCapability ? ['Stop'] : [])])
  const report: RuntimeReport = coreEvents.size ? Object.freeze({ ...inspected.report, sources: Object.freeze(inspected.report.sources.map(source => Object.freeze({ ...source, unwiredEvents: Object.freeze(source.unwiredEvents.filter(event => !coreEvents.has(event))) }))) }) : inspected.report
  await (services.report ?? (value => { console.error(JSON.stringify({ component: 'opencode-harness-hooks', code: 'RUNTIME_REPORT', ...value })) }))(report)
  if (host === 'v1' || services.stopUnavailableCapability) {
    const incompatible = sources.filter(source => source.enabled && source.registrations.some(registration => registration.event === 'Stop'))
    if (incompatible.length) throw new HostHookError('HOST_STOP_UNSUPPORTED', 'unsupported', `OpenCode ${host.toUpperCase()} cannot load enabled Stop registrations: unsupported host capability "${host === 'v1' ? STOP_HOST_CAPABILITY : services.stopUnavailableCapability}"; incompatible configs ${JSON.stringify(incompatible.map(source => ({ id: source.id, dialect: source.dialect, path: source.path })))}`)
  }
  for (const source of report.sources) {
    if (!Object.hasOwn(options.reviewedDigests, source.id)) throw new HostHookError('SOURCE_REVIEW_REQUIRED', 'unsupported', source.id)
    if (!source.reviewed) throw new HostHookError('SOURCE_REVIEW_MISMATCH', 'unsupported', source.id)
    if (source.unwiredEvents.length) throw new HostHookError('HOST_EVENT_UNAVAILABLE', 'unsupported', source.id)
  }
  const sessions = new Sessions()
  const hasCodexToolHooks = sources.some(source => source.enabled && source.dialect === 'codex' && source.registrations.some(registration => ['PreToolUse', 'PostToolUse'].includes(registration.event)))
  const active = new Set<Promise<DispatchResult>>()
  let observerFailures = 0
  const diagnostic = services.dispatchDiagnostic ?? ((value: DispatchResult['diagnostic']) => { console.error(JSON.stringify({ component: 'opencode-harness-hooks', code: 'DISPATCH_RESULT', ...value })) })
  const observe = (dispatch: DispatchResult) => {
    try {
      const observed = diagnostic(dispatch.diagnostic)
      if (observed) void Promise.resolve(observed).catch(() => { observerFailures++ })
    } catch { observerFailures++ }
    return dispatch
  }
  const starts = services.sessionStart && sources.some(source => source.enabled && source.registrations.some(registration => registration.event === 'SessionStart')) ? new SessionStarts({ host, sources, sessions, hostServices: { ...services.host, environment, projectRoot: directory }, ...(options.permissionMode ? { permissionMode: options.permissionMode } : {}), services: services.sessionStart, observe }) : undefined
  const stops = services.stop && host === 'v2' && sources.some(source => source.enabled && source.registrations.some(registration => registration.event === 'Stop')) ? new Stops({ host, sources, sessions, hostServices: { ...services.host, environment, projectRoot: directory }, ...(options.permissionMode ? { permissionMode: options.permissionMode } : {}), ...(starts ? { starts } : {}), services: services.stop, observe }) : undefined
  const reported = new WeakSet<object>()
  const needsModelArtifacts = !!services.transcripts?.observeModel && sources.some(source => source.enabled && source.dialect === 'claude-code' && source.registrations.length)
  const observeModel = (event: HostModelEvent) => {
    if (starts) {
      if (event.host !== host) throw new HostHookError('HOST_VERSION_MISMATCH', 'unsupported')
      starts.requireReady(event.sessionID)
    }
    if (!needsModelArtifacts) return
    const started = performance.now()
    try {
      if (event.host !== host) throw new HostHookError('HOST_VERSION_MISMATCH', 'unsupported')
      const session = sessions.get(event.sessionID)
      if (session.turnID !== event.messageID) throw new HostHookError('SESSION_STALE_TURN', 'cancelled')
      services.transcripts?.observeModel?.(event, session)
    } catch (error) {
      if (error && typeof error === 'object') reported.add(error)
      const value: ArtifactDiagnostic = Object.freeze({ host, artifact: 'claude-transcript', phase: 'model-request', sessionID: event.sessionID, messageID: event.messageID, code: error instanceof HostHookError || error instanceof SessionError ? error.code : 'HOST_ARTIFACT_CONTEXT_FAILED', outcome: error instanceof HostHookError && error.outcome === 'cancelled' || error instanceof SessionError && ['SESSION_CLOSED', 'SESSION_DISPOSED', 'SESSION_STALE_TURN'].includes(error.code) ? 'cancelled' : error instanceof HostHookError && error.outcome === 'unsupported' ? 'unsupported' : 'failed', durationMs: Math.round(performance.now() - started) })
      try {
        const observed = (services.artifactDiagnostic ?? (value => { console.error(JSON.stringify({ component: 'opencode-harness-hooks', ...value })) }))(value)
        if (observed) void Promise.resolve(observed).catch(() => { observerFailures++ })
      } catch { observerFailures++ }
      throw error
    }
  }
  const promptOperation = async <T>(phase: PromptDiagnostic['phase'], identity: { readonly sessionID?: string; readonly messageID?: string }, operation: () => Promise<T>): Promise<T> => {
    const started = performance.now()
    try { return await operation() } catch (error) {
      if (error && typeof error === 'object' && reported.has(error)) throw error
      if (error && typeof error === 'object') reported.add(error)
      const value: PromptDiagnostic = Object.freeze({ host, event: 'UserPromptSubmit', phase, ...identity, code: error instanceof HostHookError || error instanceof SessionError ? error.code : 'HOST_PROMPT_FAILED', outcome: error instanceof HostHookError ? error.outcome : error instanceof SessionError && ['SESSION_CLOSED', 'SESSION_DISPOSED', 'SESSION_STALE_TURN'].includes(error.code) ? 'cancelled' : 'failed', durationMs: Math.round(performance.now() - started) })
      try {
        const observed = (services.promptDiagnostic ?? (value => { console.error(JSON.stringify({ component: 'opencode-harness-hooks', ...value })) }))(value)
        if (observed) void Promise.resolve(observed).catch(() => { observerFailures++ })
      } catch { observerFailures++ }
      throw error
    }
  }
  const tools: ToolHostOptions = {
    ...services.tools,
    diagnostic: services.tools?.diagnostic ?? (value => { console.error(JSON.stringify({ component: 'opencode-harness-hooks', ...value })) }),
    dispatch(inputEvent) {
      const event = { ...inputEvent, toolInput: structuredClone(inputEvent.toolInput), effectiveInput: structuredClone(inputEvent.effectiveInput) }
      if (event.host !== host) return Promise.reject(new HostHookError('HOST_VERSION_MISMATCH', 'unsupported'))
      let session: SessionSnapshot
      try { session = sessions.get(event.sessionID) } catch (error) {
        const code = error instanceof SessionError ? error.code : 'HOST_SESSION_UNAVAILABLE'
        return Promise.reject(new HostHookError(code, code === 'SESSION_CLOSED' || code === 'SESSION_DISPOSED' ? 'cancelled' : 'failed'))
      }
      const signal = AbortSignal.any([event.signal, session.signal, session.turnSignal])
      const pending = (async () => {
        if (signal.aborted) throw new HostHookError('HOST_TOOL_CANCELLED', 'cancelled')
        if (starts) await runService(null, signal, () => starts.wait(event.sessionID))
        if (sources.some(source => source.enabled && source.dialect === 'claude-code' && source.registrations.length)) services.transcripts?.observe(event, session)
        if (hasCodexToolHooks) services.codexTranscripts?.observe(event, session)
        const failure = v1ShellFailure(event)
        const base: NativeEvent = { host, event: event.event, ...(failure ? { dialectEvents: { codex: 'PostToolUse' } } : {}), sessionID: event.sessionID, cwd: directory, tool: event.tool, toolInput: event.event === 'PreToolUse' ? event.toolInput : event.effectiveInput }
        const selected = matched(sources, base).filter(registration => !nativeSkip(registration, eventForDialect(base, registration.dialect)))
        if (event.event === 'PostToolUseFailure' && !failure && matched(sources, { ...base, event: 'PostToolUse' }).some(registration => registration.dialect === 'codex' && !nativeSkip(registration, { ...base, event: 'PostToolUse' }))) throw new HostHookError('HOST_POST_FAILURE_UNVERIFIED', 'unsupported')
        let nativeData = selected.length && services.nativeData ? await runService(null, signal, current => services.nativeData!(event, session, current)) : undefined
        if (failure) nativeData = { ...nativeData, codex: { tool_response: failure.output, ...nativeData?.codex } }
        let nativeSessionIDs: NativeEvent['nativeSessionIDs']
        if (selected.some(registration => registration.dialect === 'claude-code') && nativeData?.['claude-code']?.transcript_path === undefined && services.transcripts) {
          const path = await services.transcripts.prepare(event, session, signal)
          nativeData = { ...nativeData, 'claude-code': { ...nativeData?.['claude-code'], transcript_path: path } }
        }
        if (selected.some(registration => registration.dialect === 'codex') && nativeData?.codex?.transcript_path === undefined && services.codexTranscripts) {
          const view = await runService(null, signal, current => services.codexTranscripts!.prepare(event, session, current))
          nativeData = { ...nativeData, codex: { ...nativeData?.codex, transcript_path: view.transcriptPath, turn_id: view.turnID } }
          nativeSessionIDs = { codex: view.sessionID }
        }
        const data = { ...(selected.length ? resultData(event, failure) : {}), transcript_path: null, tool_use_id: event.callID, ...(session.turnID ? { turn_id: session.turnID } : {}), ...(session.model ? { model: session.model } : {}), ...(options.permissionMode ? { permission_mode: options.permissionMode } : {}) }
        const nativeEvent: NativeEvent = { ...base, data, ...(nativeData ? { dialectData: nativeData } : {}), ...(nativeSessionIDs ? { nativeSessionIDs } : {}) }
        for (const registration of selected) {
          try { buildPayload(registration, nativeEvent) } catch (error) { throw new HostHookError('HOST_NATIVE_METADATA_UNAVAILABLE', 'unsupported', `${registration.id} ${error instanceof PayloadError ? error.message : 'PAYLOAD_INVALID'}`) }
        }
        const dispatch = await dispatchEvent(sources, nativeEvent, { ...services.host, environment, projectRoot: directory, signal, sessionSignal: session.signal })
        return observe(dispatch)
      })().catch((error: unknown) => {
        if (signal.aborted) throw new HostHookError('HOST_TOOL_CANCELLED', 'cancelled')
        throw error
      })
      active.add(pending)
      void pending.finally(() => { active.delete(pending) }).catch(() => {})
      return pending
    },
  }
  const prompt = async (inputEvent: HostPromptEvent): Promise<DispatchResult> => {
    const event = { ...inputEvent }
    if (event.host !== host || event.event !== 'UserPromptSubmit') return Promise.reject(new HostHookError('HOST_VERSION_MISMATCH', 'unsupported'))
    const session = sessions.get(event.sessionID)
    if (session.turnID !== event.messageID) return Promise.reject(new HostHookError('SESSION_STALE_TURN', 'cancelled'))
    if (typeof event.prompt !== 'string') return Promise.reject(new HostHookError('HOST_PROMPT_INPUT_UNAVAILABLE', 'unsupported'))
    if (Buffer.byteLength(event.prompt) > MAX_PROMPT_BYTES) return Promise.reject(new HostHookError('HOST_PROMPT_INPUT_LIMIT', 'unsupported'))
    const signal = AbortSignal.any([event.signal, session.signal, session.turnSignal])
    const pending = (async () => {
      if (signal.aborted) throw new HostHookError('HOST_PROMPT_CANCELLED', 'cancelled')
      if (starts) await runService(null, signal, () => starts.wait(event.sessionID))
      const base: NativeEvent = { host, event: 'UserPromptSubmit', sessionID: event.sessionID, cwd: directory }
      const selected = matched(sources, base).filter(registration => !nativeSkip(registration, base))
      let nativeData = selected.length && services.promptData ? await runService(null, signal, current => services.promptData!(event, session, current)) : undefined
      if (selected.some(registration => registration.dialect === 'claude-code') && nativeData?.['claude-code']?.transcript_path === undefined && services.transcripts) {
        const path = await services.transcripts.prepare(event, session, signal)
        nativeData = { ...nativeData, 'claude-code': { ...nativeData?.['claude-code'], transcript_path: path } }
      }
      const data = { prompt: event.prompt, transcript_path: null, turn_id: event.messageID, ...(session.model ? { model: session.model } : {}), ...(options.permissionMode ? { permission_mode: options.permissionMode } : {}) }
      const nativeEvent: NativeEvent = { ...base, data, ...(nativeData ? { dialectData: nativeData } : {}) }
      for (const registration of selected) {
        try { buildPayload(registration, nativeEvent) } catch (error) { throw new HostHookError('HOST_NATIVE_METADATA_UNAVAILABLE', 'unsupported', `${registration.id} ${error instanceof PayloadError ? error.message : 'PAYLOAD_INVALID'}`) }
      }
      return observe(await dispatchEvent(sources, nativeEvent, { ...services.host, ...(services.transcripts?.admitPrompt ? { captureCommandArtifacts: true, captureHttpArtifacts: true } : {}), environment, projectRoot: directory, signal, sessionSignal: session.signal }))
    })().catch((error: unknown) => {
      if (signal.aborted) throw new HostHookError('HOST_PROMPT_CANCELLED', 'cancelled')
      throw error
    })
    active.add(pending)
    void pending.finally(() => { active.delete(pending) }).catch(() => {})
    return pending
  }
  const admitPrompt = (event: HostPromptEvent, dispatch: DispatchResult) => {
    const session = sessions.get(event.sessionID)
    if (session.turnID !== event.messageID) throw new HostHookError('SESSION_STALE_TURN', 'cancelled')
    services.transcripts?.admitPrompt?.(event, session, dispatch)
  }
  return { report, sessions, tools, prompt, admitPrompt, promptOperation, observeModel, needsModelArtifacts,
    start: (event: SessionStartEvent) => starts ? starts.start(event) : Promise.reject(new HostHookError('HOST_EVENT_UNAVAILABLE', 'unsupported')),
    stop: (event: StopEvent) => stops ? stops.complete(event) : Promise.reject(new HostHookError('HOST_EVENT_UNAVAILABLE', 'unsupported')),
    waitForStart: (sessionID: string) => starts ? starts.wait(sessionID) : Promise.resolve(undefined),
    hasPromptHooks: sources.some(source => source.registrations.some(registration => registration.event === 'UserPromptSubmit')),
    hasStopHooks: stops !== undefined,
    inspect: () => Object.freeze({ activeDispatches: active.size, observerFailures, sessions: sessions.inspect(), ...(starts ? { sessionStarts: starts.inspect() } : {}), ...(stops ? { stops: stops.inspect() } : {}) }),
    async dispose() {
      sessions.dispose()
      const [, started, stopped] = await Promise.allSettled([Promise.allSettled([...active]), starts?.dispose(), stops?.dispose()])
      const artifacts = await Promise.allSettled([services.transcripts?.dispose(), services.codexTranscripts?.dispose()])
      for (const result of artifacts) if (result.status === 'rejected') throw result.reason
      if (started.status === 'rejected') throw started.reason
      if (stopped.status === 'rejected') throw stopped.reason
    },
  }
}
