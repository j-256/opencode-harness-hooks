import { resolve } from 'node:path'
import { loadSources } from './config.js'
import { HOST_VERSIONS } from './contracts.js'
import type { Dialect, HostVersion } from './contracts.js'
import { dispatchEvent } from './engine.js'
import type { DispatchResult } from './engine.js'
import { nativeSkip } from './handlers.js'
import type { HostServices } from './host-services.js'
import { HostHookError } from './hosts/tools.js'
import type { HostToolEvent, ToolHostOptions } from './hosts/tools.js'
import { selectRegistrations } from './matchers.js'
import { buildPayload, PayloadError } from './payload.js'
import { runService } from './service-execution.js'
import { SessionError, Sessions } from './sessions.js'
import type { SessionSnapshot } from './sessions.js'
import type { JsonValue, LoadedSource, NativeEvent, Registration, SourceSpec } from './types.js'

const WIRED_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure'])
const PERMISSION_MODES = new Set(['default', 'acceptEdits', 'plan', 'dontAsk', 'bypassPermissions', 'auto'])
const MAX_RESULT_BYTES = 8 * 1024 * 1024
type NativeData = NonNullable<NativeEvent['dialectData']>

export interface RuntimeOptions {
  readonly sources: readonly SourceSpec[]
  readonly reviewedDigests: Readonly<Record<string, string>>
  readonly permissionMode?: string
}
export interface RuntimeReport {
  readonly host: HostVersion
  readonly hostContractVersion: string
  readonly equivalent: false
  readonly sources: readonly {
    readonly id: string
    readonly dialect: Dialect
    readonly digest: string
    readonly reviewed: boolean
    readonly enabled: boolean
    readonly events: readonly string[]
    readonly unwiredEvents: readonly string[]
    readonly excluded: readonly { readonly id: string; readonly event: string; readonly type: string; readonly reason: string }[]
  }[]
  readonly unresolved: readonly string[]
}
export interface RuntimeServices {
  readonly host?: Omit<HostServices, 'projectRoot' | 'signal' | 'sessionSignal'>
  readonly tools?: Omit<ToolHostOptions, 'dispatch'>
  readonly nativeData?: (event: HostToolEvent, session: SessionSnapshot, signal: AbortSignal) => Promise<NativeData>
  readonly report?: (report: RuntimeReport) => Promise<void> | void
  readonly dispatchDiagnostic?: (diagnostic: DispatchResult['diagnostic']) => Promise<void> | void
}

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }

function matched(sources: readonly LoadedSource[], event: NativeEvent): readonly Registration[] {
  return sources.flatMap(source => source.registrations.filter(registration => {
    try { return selectRegistrations([{ ...source, registrations: [registration] }], event).length > 0 } catch { return false }
  }))
}

function optionsCopy(value: unknown, directory: string): RuntimeOptions {
  if (!record(value) || Object.keys(value).some(key => !['sources', 'reviewedDigests', 'permissionMode'].includes(key)) || !Array.isArray(value.sources) || !value.sources.length || !record(value.reviewedDigests)) throw new HostHookError('PLUGIN_OPTIONS_INVALID', 'failed')
  if (value.permissionMode !== undefined && (typeof value.permissionMode !== 'string' || !PERMISSION_MODES.has(value.permissionMode))) throw new HostHookError('PLUGIN_OPTIONS_INVALID', 'failed')
  if (Object.values(value.reviewedDigests).some(digest => typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest))) throw new HostHookError('PLUGIN_OPTIONS_INVALID', 'failed')
  const sources = value.sources.map(source => {
    if (!record(source) || typeof source.path !== 'string') throw new HostHookError('PLUGIN_OPTIONS_INVALID', 'failed')
    for (const key of ['projectRoot', 'pluginRoot']) if (source[key] !== undefined && typeof source[key] !== 'string') throw new HostHookError('PLUGIN_OPTIONS_INVALID', 'failed')
    return { ...structuredClone(source), path: resolve(directory, source.path), ...(typeof source.projectRoot === 'string' ? { projectRoot: resolve(directory, source.projectRoot) } : {}), ...(typeof source.pluginRoot === 'string' ? { pluginRoot: resolve(directory, source.pluginRoot) } : {}) } as unknown as SourceSpec
  })
  return { sources, reviewedDigests: { ...value.reviewedDigests } as Record<string, string>, ...(typeof value.permissionMode === 'string' ? { permissionMode: value.permissionMode } : {}) }
}

function resultData(event: HostToolEvent): Record<string, JsonValue> {
  if (event.event === 'PreToolUse') return {}
  if (event.event === 'PostToolUseFailure') {
    const error = typeof event.result === 'string' ? event.result : event.result instanceof Error ? event.result.message : record(event.result) && typeof event.result.message === 'string' ? event.result.message : undefined
    if (error === undefined || Buffer.byteLength(error) > MAX_RESULT_BYTES) throw new HostHookError('HOST_TOOL_ERROR_UNAVAILABLE', 'unsupported')
    return { error }
  }
  try {
    const text = JSON.stringify(event.result, (_key, item: unknown) => {
      if (typeof item === 'number' && !Number.isFinite(item) || ['bigint', 'function', 'symbol'].includes(typeof item)) throw new Error()
      return item
    })
    if (text === undefined || Buffer.byteLength(text) > MAX_RESULT_BYTES) throw new Error()
    return { tool_response: JSON.parse(text) as JsonValue }
  } catch { throw new HostHookError('HOST_TOOL_RESULT_UNAVAILABLE', 'unsupported') }
}

export async function createRuntime(host: HostVersion, directory: string, inputOptions: unknown, services: RuntimeServices = {}) {
  if (!Object.hasOwn(HOST_VERSIONS, host) || typeof directory !== 'string' || !directory) throw new HostHookError('HOST_INPUT_INVALID', 'failed')
  directory = resolve(directory)
  services = { ...services, ...(services.host ? { host: { ...services.host, ...(services.host.sourceContext ? { sourceContext: structuredClone(services.host.sourceContext) } : {}) } } : {}), ...(services.tools ? { tools: { ...services.tools } } : {}) }
  const options = optionsCopy(inputOptions, directory)
  const sources = await loadSources(options.sources)
  const report: RuntimeReport = Object.freeze({
    host, hostContractVersion: HOST_VERSIONS[host], equivalent: false,
    sources: Object.freeze(sources.map(source => Object.freeze({
      id: source.id, dialect: source.dialect, digest: source.digest, reviewed: Object.hasOwn(options.reviewedDigests, source.id) && options.reviewedDigests[source.id] === source.digest, enabled: source.enabled,
      events: Object.freeze([...new Set(source.registrations.map(registration => registration.event))]),
      unwiredEvents: Object.freeze([...new Set(source.registrations.map(registration => registration.event).filter(event => !WIRED_EVENTS.has(event)))]),
      excluded: source.excluded,
    }))),
    unresolved: Object.freeze(['native-trust-and-reload', 'native-artifacts', 'permission-mode-projection', 'tool-result-projection', 'post-failure-mapping', 'non-tool-events', 'native-effects-and-lifecycle', 'migration-parity']),
  })
  await (services.report ?? (value => { console.error(JSON.stringify({ component: 'opencode-harness-hooks', code: 'RUNTIME_REPORT', ...value })) }))(report)
  for (const source of report.sources) {
    if (!Object.hasOwn(options.reviewedDigests, source.id)) throw new HostHookError('SOURCE_REVIEW_REQUIRED', 'unsupported', source.id)
    if (!source.reviewed) throw new HostHookError('SOURCE_REVIEW_MISMATCH', 'unsupported', source.id)
    if (source.unwiredEvents.length) throw new HostHookError('HOST_EVENT_UNAVAILABLE', 'unsupported', source.id)
  }
  const sessions = new Sessions()
  const active = new Set<Promise<DispatchResult>>()
  const environment = { ...(services.host?.environment ?? process.env) }
  let observerFailures = 0
  const diagnostic = services.dispatchDiagnostic ?? ((value: DispatchResult['diagnostic']) => { console.error(JSON.stringify({ component: 'opencode-harness-hooks', code: 'DISPATCH_RESULT', ...value })) })
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
        const base: NativeEvent = { host, event: event.event, sessionID: event.sessionID, cwd: directory, tool: event.tool, toolInput: event.event === 'PreToolUse' ? event.toolInput : event.effectiveInput }
        const selected = matched(sources, base).filter(registration => !nativeSkip(registration, base))
        if (event.event === 'PostToolUseFailure' && matched(sources, { ...base, event: 'PostToolUse' }).some(registration => registration.dialect === 'codex' && !nativeSkip(registration, { ...base, event: 'PostToolUse' }))) throw new HostHookError('HOST_POST_FAILURE_UNVERIFIED', 'unsupported')
        const nativeData = selected.length && services.nativeData ? await runService(null, signal, current => services.nativeData!(event, session, current)) : undefined
        const data = { ...(selected.length ? resultData(event) : {}), transcript_path: null, tool_use_id: event.callID, ...(session.turnID ? { turn_id: session.turnID } : {}), ...(session.model ? { model: session.model } : {}), ...(options.permissionMode ? { permission_mode: options.permissionMode } : {}) }
        const nativeEvent: NativeEvent = { ...base, data, ...(nativeData ? { dialectData: nativeData } : {}) }
        for (const registration of selected) {
          try { buildPayload(registration, nativeEvent) } catch (error) { throw new HostHookError('HOST_NATIVE_METADATA_UNAVAILABLE', 'unsupported', `${registration.id} ${error instanceof PayloadError ? error.message : 'PAYLOAD_INVALID'}`) }
        }
        const dispatch = await dispatchEvent(sources, nativeEvent, { ...services.host, environment, projectRoot: directory, signal, sessionSignal: session.signal })
        try {
          const observed = diagnostic(dispatch.diagnostic)
          if (observed) void Promise.resolve(observed).catch(() => { observerFailures++ })
        } catch { observerFailures++ }
        return dispatch
      })().catch((error: unknown) => {
        if (signal.aborted) throw new HostHookError('HOST_TOOL_CANCELLED', 'cancelled')
        throw error
      })
      active.add(pending)
      void pending.finally(() => { active.delete(pending) }).catch(() => {})
      return pending
    },
  }
  return { report, sessions, tools, inspect: () => Object.freeze({ activeDispatches: active.size, observerFailures, sessions: sessions.inspect() }), async dispose() { sessions.dispose(); await Promise.allSettled([...active]) } }
}
