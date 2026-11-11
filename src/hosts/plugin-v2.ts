import { registerV2Hooks } from './v2.js'
import type { V2ToolContext } from './v2.js'
import type { PermissionEvaluation } from './permissions.js'
import { V2StopBridge } from './v2-stop.js'
import type { V2IdleEvent, V2SyntheticInput } from './v2-stop.js'
import { HOST_VERSIONS } from '../contracts.js'
import { runService } from '../service-execution.js'
import { HostHookError } from '../host-errors.js'
import { createRuntime } from '../runtime.js'
import type { RuntimeServices } from '../runtime.js'
import { ClaudeTranscript } from '../transcript.js'
import { CallApprovals } from './permissions.js'
import type { HostToolEvent } from '../tool-types.js'
import { PromptContexts, PROMPT_REQUEST_HEADER } from '../prompt-contexts.js'
import { record, unavailable, protocol, partsText, layout, submit, guarded, history } from './plugin-shared.js'

const METADATA_MS = 5000
const PROMPT_PHASES = Object.freeze({ prompt: 'admission', context: 'layout', 'model.request': 'headers', 'http.request': 'request' } as const)

interface V2SessionEvents {
  readonly prompt: { readonly sessionID: string; readonly messageID: string; readonly prompt?: { readonly text: string; readonly files?: readonly unknown[]; readonly agents?: readonly unknown[]; readonly skills?: readonly unknown[] } }
  readonly context: { readonly sessionID: string; readonly model: { readonly id: string; readonly providerID?: string }; messages?: readonly unknown[] }
  readonly 'model.request': { readonly sessionID: string; readonly kind: string; readonly model: { readonly id: string; readonly providerID: string }; readonly headers: Record<string, string> }
  readonly 'http.request': { readonly sessionID: string; readonly kind: string; request: Request }
  readonly 'experimental.idle': V2IdleEvent
}
export interface V2Context extends V2ToolContext {
  readonly app?: { readonly version: string }
  readonly location: { readonly directory: string }
  readonly options: unknown
  readonly event?: { readonly subscribe: (options: { readonly types: readonly string[]; readonly signal: AbortSignal }) => AsyncIterable<unknown> }
  readonly model?: { readonly list: (input: { readonly types: readonly ['chat'] }, options: { readonly signal: AbortSignal }) => Promise<unknown> }
  readonly provider?: { readonly get: (input: { readonly providerID: string }, options: { readonly signal: AbortSignal }) => Promise<unknown> }
  readonly permission?: { readonly hook: (name: 'evaluate', callback: (event: PermissionEvaluation) => Promise<void>) => Promise<{ readonly dispose: () => Promise<void> | void }> }
  readonly session: {
    readonly hook: <K extends keyof V2SessionEvents>(name: K, callback: (event: V2SessionEvents[K]) => Promise<void>) => Promise<{ readonly dispose: () => Promise<void> | void }>
    readonly get?: (input: { readonly sessionID: string }, options: { readonly signal: AbortSignal }) => Promise<unknown>
    readonly context?: (input: { readonly sessionID: string }, options: { readonly signal: AbortSignal }) => Promise<unknown>
    readonly synthetic?: (input: V2SyntheticInput) => Promise<unknown>
  }
}

export async function setupHarnessHooks(context: V2Context, services: RuntimeServices = {}) {
  if (services.sessionStart) throw new HostHookError('HOST_SESSION_START_HOST_UNAVAILABLE', 'unsupported')
  if (services.stop) throw new HostHookError('HOST_STOP_HOST_UNAVAILABLE', 'unsupported')
  services = { ...services }
  let stopBridge: V2StopBridge | undefined
  const nativeHistoryReads = new Set<Promise<unknown>>()
  const trackHistory = (signal: AbortSignal, operation: () => Promise<unknown>) => {
    const work = Promise.resolve().then(() => { signal.throwIfAborted(); return operation() })
    nativeHistoryReads.add(work)
    void work.finally(() => { nativeHistoryReads.delete(work) }).catch(() => {})
    return work
  }
  const read = async (sessionID: string, signal: AbortSignal) => {
    if (!context.session.get || !context.session.context) throw new HostHookError('HOST_TRANSCRIPT_HISTORY_UNAVAILABLE', 'unsupported')
    const [info, messages] = await Promise.allSettled([trackHistory(signal, () => context.session.get!({ sessionID }, { signal })), trackHistory(signal, () => context.session.context!({ sessionID }, { signal }))])
    if (info.status === 'rejected') throw info.reason
    if (messages.status === 'rejected') throw messages.reason
    return history(info.value, messages.value)
  }
  const transcripts = services.transcripts ?? new ClaudeTranscript({ host: 'v2', directory: context.location.directory, history: async (event, signal) => {
    return read(event.sessionID, signal)
  } })
  const runtime = await createRuntime('v2', context.location.directory, context.options, { ...services, transcripts, stop: { admit: async delivery => { if (!stopBridge) unavailable('HOST_STOP_HOST_UNAVAILABLE'); await stopBridge.admit(delivery) } } })
  const approvals = new CallApprovals({ diagnostic: runtime.tools.diagnostic })
  const contexts = new PromptContexts()
  const handles = new Set<{ readonly dispose: () => Promise<void> | void }>()
  const modelOwners = new Map<string, { readonly turnID: string; readonly signal: AbortSignal }>()
  const transport = runtime.hasPromptHooks || runtime.hasStopHooks
  const register = <K extends keyof typeof PROMPT_PHASES>(name: K, callback: (event: V2SessionEvents[K]) => Promise<void>) => context.session.hook(name, guarded(runtime, PROMPT_PHASES[name], callback, event => ({ sessionID: event.sessionID, ...('messageID' in event && typeof event.messageID === 'string' ? { messageID: event.messageID } : {}) })))
  let tools: Awaited<ReturnType<typeof registerV2Hooks>> | undefined
  let disposing: Promise<void> | undefined
  const drainHistory = async () => {
    const started = performance.now()
    try { await runService(METADATA_MS, undefined, async () => { while (nativeHistoryReads.size) await Promise.allSettled([...nativeHistoryReads]) }) } catch {
      const code = runtime.hasStopHooks ? 'HOST_STOP_ADMISSION_DRAIN_FAILED' : 'HOST_TRANSCRIPT_HISTORY_DRAIN_FAILED'
      console.error(JSON.stringify({ component: 'opencode-harness-hooks', host: 'v2', phase: 'history-drain', code, outcome: 'failed', pendingReads: nativeHistoryReads.size, durationMs: Math.round(performance.now() - started) }))
      throw new HostHookError(code, 'failed')
    }
  }
  const cleanup = async () => {
    runtime.sessions.dispose()
    contexts.dispose()
    modelOwners.clear()
    let toolError: unknown
    try { await tools?.dispose() } catch (error) { toolError = error }
    await approvals.dispose()
    const [stopped, disposed, history] = await Promise.allSettled([stopBridge?.dispose(), runtime.dispose(), drainHistory()])
    if (stopped.status === 'rejected') throw stopped.reason
    if (history.status === 'rejected') throw history.reason
    const artifactError = disposed.status === 'rejected' ? disposed.reason : undefined
    if (stopBridge && artifactError) throw artifactError
    for (const handle of handles) {
      try { await handle.dispose(); handles.delete(handle) } catch {}
    }
    if (toolError || handles.size) throw new HostHookError('HOST_REGISTRATION_DISPOSE_FAILED', 'failed')
    if (artifactError) throw artifactError
  }
  const dispose = () => { disposing ??= cleanup().finally(() => { disposing = undefined }); return disposing }
  try {
    if (runtime.hasStopHooks) {
      if (context.app?.version !== HOST_VERSIONS.v2) unavailable('HOST_STOP_HOST_VERSION_UNAVAILABLE')
      if (!context.session.synthetic || !context.session.get || !context.session.context || !context.event?.subscribe) unavailable('HOST_STOP_HOST_UNAVAILABLE')
      const codex = runtime.report.sources.find(source => source.enabled && source.dialect === 'codex' && source.events.includes('Stop'))
      if (codex) throw new HostHookError('HOST_STOP_DIALECT_UNAVAILABLE', 'unsupported', `Codex Stop native rollout and model projection required for source ${codex.id}`)
      stopBridge = new V2StopBridge({ directory: context.location.directory, runtime, transcripts, contexts, history: read, synthetic: input => context.session.synthetic!(input), subscribe: options => context.event!.subscribe(options) })
      handles.add(await context.session.hook('experimental.idle', event => stopBridge!.idle(event)))
    }
    handles.add(await register('prompt', async event => {
      runtime.sessions.prompt(event.sessionID, event.messageID)
      stopBridge?.guard(runtime.sessions.get(event.sessionID), false)
      if (!transport) return
      const session = runtime.sessions.get(event.sessionID)
      if (!context.session.get || !event.prompt || ['files', 'agents', 'skills'].some(key => event.prompt![key as 'files']?.length)) unavailable('HOST_PROMPT_INPUT_UNAVAILABLE')
      const info = await runService(METADATA_MS, session.turnSignal, signal => context.session.get!({ sessionID: event.sessionID }, { signal }))
      if (!record(info) || info.id !== event.sessionID || !record(info.model) || typeof info.model.id !== 'string') unavailable('HOST_NATIVE_METADATA_UNAVAILABLE')
      runtime.sessions.model(event.sessionID, info.model.id, event.messageID)
      if (runtime.hasPromptHooks) await submit(runtime, contexts, { host: 'v2', event: 'UserPromptSubmit', sessionID: event.sessionID, messageID: event.messageID, prompt: event.prompt.text, signal: session.turnSignal }, [event.prompt.text], services)
      else contexts.remember(runtime.sessions.get(event.sessionID), [event.prompt.text], [])
      stopBridge?.accept(runtime.sessions.get(event.sessionID), event.prompt.text)
    }))
    handles.add(await register('context', async event => {
      const session = runtime.sessions.get(event.sessionID)
      const messages = await stopBridge?.context(session, event.messages)
      if (messages) event.messages = messages
      if (runtime.needsModelArtifacts) modelOwners.delete(event.sessionID)
      if (transport) contexts.layout(session, layout('v2', event.messages))
      if (runtime.needsModelArtifacts) {
        const last = Array.isArray(event.messages) ? event.messages.findLast(message => record(message) && message.role === 'user') : undefined
        if (!session.turnID || !record(last) || typeof last.id !== 'string' || !contexts.ownsCurrentMessage(session, last.id)) throw new HostHookError('SESSION_STALE_TURN', 'cancelled')
        modelOwners.set(event.sessionID, { turnID: session.turnID, signal: session.turnSignal })
      }
      runtime.sessions.model(event.sessionID, event.model.id, session.turnID)
    }))
    if (transport || runtime.needsModelArtifacts) {
      handles.add(await register('model.request', async event => {
        if (event.kind !== 'primary') return
        const session = runtime.sessions.get(event.sessionID)
        stopBridge?.guard(session)
        if (runtime.needsModelArtifacts) {
          const owner = modelOwners.get(event.sessionID)
          if (!owner) unavailable('HOST_MODEL_CONTEXT_UNAVAILABLE')
          runtime.observeModel({ host: 'v2', sessionID: event.sessionID, messageID: owner.turnID, signal: owner.signal })
        }
        if (!transport) return
        if (!context.model) unavailable('HOST_PROMPT_PROVIDER_UNAVAILABLE')
        const data = await runService(METADATA_MS, session.turnSignal, signal => context.model!.list({ types: ['chat'] }, { signal }))
        if (!record(data) || !Array.isArray(data.data)) unavailable('HOST_PROMPT_PROVIDER_UNAVAILABLE')
        const model = data.data.find((model: unknown) => record(model) && model.id === event.model.id && model.providerID === event.model.providerID)
        let selected: unknown = record(model) ? model.package : undefined
        if (selected === undefined && context.provider) {
          const provider = await runService(METADATA_MS, session.turnSignal, signal => context.provider!.get({ providerID: event.model.providerID }, { signal }))
          if (record(provider) && record(provider.data)) selected = provider.data.package
        }
        const token = contexts.issue(session, protocol(selected))
        if (token) event.headers[PROMPT_REQUEST_HEADER] = token
      }))
    }
    if (transport) {
      handles.add(await register('http.request', async event => {
        if (event.kind !== 'primary') return
        stopBridge?.guard(runtime.sessions.get(event.sessionID))
        const token = event.request.headers.get(PROMPT_REQUEST_HEADER)
        if (token) event.request = await contexts.project(event.request, token, runtime.sessions.get(event.sessionID))
      }))
    }
    if (context.permission) handles.add(await context.permission.hook('evaluate', async event => { approvals.applyV2(event) }))
    tools = await registerV2Hooks(context, { ...runtime.tools, ...(!runtime.tools.preapprove && context.permission ? { preapprove: async (event: HostToolEvent) => approvals.remember(event, runtime.sessions.get(event.sessionID)) } : {}) })
    return dispose
  } catch (error) { await dispose(); throw error }
}
