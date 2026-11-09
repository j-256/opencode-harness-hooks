import { createV1Hooks } from './hosts/v1.js'
import { registerV2Hooks } from './hosts/v2.js'
import type { V2ToolContext } from './hosts/v2.js'
import { HostHookError } from './hosts/tools.js'
import { createRuntime } from './runtime.js'
import type { RuntimeServices } from './runtime.js'
import { ClaudeTranscript } from './transcript.js'
import type { TranscriptHistory } from './transcript.js'
import { CallApprovals } from './hosts/permissions.js'
import type { PermissionEvaluation } from './hosts/permissions.js'
import type { HostToolEvent } from './hosts/tools.js'
import { PromptContexts, PROMPT_REQUEST_HEADER } from './prompt-contexts.js'
import type { PromptProtocol, PromptLayout } from './prompt-contexts.js'
import type { HostPromptEvent, PromptDiagnostic } from './prompt-types.js'
import { resolveEffects } from './effects.js'
import { runService } from './service-execution.js'

const METADATA_MS = 5000
const OPENAI_PACKAGES = new Set(['@ai-sdk/openai', '@ai-sdk/openai-compatible', '@opencode/ai/providers/openai', '@opencode/ai/providers/openai-compatible'])
const ANTHROPIC_PACKAGES = new Set(['@ai-sdk/anthropic', '@opencode/ai/providers/anthropic'])
const PROMPT_PHASES = Object.freeze({ prompt: 'admission', context: 'layout', 'model.request': 'headers', 'http.request': 'request' } as const)
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function unavailable(code: string): never { throw new HostHookError(code, 'unsupported') }
function protocol(value: unknown): PromptProtocol {
  if (typeof value === 'string' && OPENAI_PACKAGES.has(value)) return 'openai'
  if (typeof value === 'string' && ANTHROPIC_PACKAGES.has(value)) return 'anthropic'
  return unavailable('HOST_PROMPT_PROVIDER_UNAVAILABLE')
}
function partsText(parts: unknown): readonly string[] {
  if (!Array.isArray(parts) || !parts.length) return unavailable('HOST_PROMPT_INPUT_UNAVAILABLE')
  return parts.map((part: unknown) => {
    if (!record(part) || part.type !== 'text' || typeof part.text !== 'string' || part.synthetic === true || part.ignored === true) return unavailable('HOST_PROMPT_INPUT_UNAVAILABLE')
    return part.text
  })
}
function layout(host: 'v1' | 'v2', messages: unknown): readonly PromptLayout[] {
  if (!Array.isArray(messages)) return unavailable('HOST_PROMPT_LAYOUT_UNAVAILABLE')
  return messages.flatMap((message: unknown) => {
    if (!record(message)) return unavailable('HOST_PROMPT_LAYOUT_UNAVAILABLE')
    const info = host === 'v1' ? message.info : message
    if (!record(info)) return unavailable('HOST_PROMPT_LAYOUT_UNAVAILABLE')
    if (info.role !== 'user') return []
    if (typeof info.id !== 'string') return unavailable('HOST_PROMPT_LAYOUT_UNAVAILABLE')
    const content = host === 'v1' ? message.parts : typeof info.content === 'string' ? [{ type: 'text', text: info.content }] : info.content
    return [{ id: info.id, text: partsText(content) }]
  })
}
async function submit(runtime: Awaited<ReturnType<typeof createRuntime>>, contexts: PromptContexts, event: HostPromptEvent, text: readonly string[], services: RuntimeServices): Promise<void> {
  const dispatch = await runtime.prompt(event)
  const unsupported = dispatch.entries.find(entry => entry.result.status === 'unsupported')
  if (unsupported) throw new HostHookError(unsupported.result.code, 'unsupported')
  const effects = resolveEffects(dispatch)
  if (event.signal.aborted || effects.cancelled) throw new HostHookError('HOST_PROMPT_CANCELLED', 'cancelled')
  if (effects.block) throw new HostHookError('HOOK_PROMPT_BLOCKED', 'denied', effects.block.action.reason)
  if (effects.stop) throw new HostHookError('HOOK_PROMPT_STOPPED', 'stopped', effects.stop.action.reason)
  if (effects.permission || effects.input || effects.continuations.length || effects.resultReplacements.length || effects.unresolved.length) unavailable('HOST_PROMPT_EFFECT_UNAVAILABLE')
  if (effects.feedback.length || effects.warnings.length || effects.extensions.length) {
    if (!services.promptEffects) unavailable('HOST_PROMPT_EFFECT_UNAVAILABLE')
    await runService(null, event.signal, () => services.promptEffects!(event, effects))
  }
  if (event.signal.aborted) throw new HostHookError('HOST_PROMPT_CANCELLED', 'cancelled')
  contexts.remember(runtime.sessions.get(event.sessionID), text, effects.context)
}
function guarded<A extends unknown[], T>(runtime: Awaited<ReturnType<typeof createRuntime>>, phase: PromptDiagnostic['phase'], operation: (...args: A) => Promise<T>, identity: (...args: A) => { readonly sessionID?: string; readonly messageID?: string }) {
  return (...args: A) => runtime.hasPromptHooks ? runtime.promptOperation(phase, identity(...args), () => operation(...args)) : operation(...args)
}

interface V1Input {
  readonly directory: string
  readonly client?: {
    readonly session: {
      readonly get: (options: { readonly path: { readonly id: string }; readonly signal: AbortSignal }) => Promise<{ readonly data?: unknown; readonly error?: unknown }>
      readonly messages: (options: { readonly path: { readonly id: string }; readonly signal: AbortSignal }) => Promise<{ readonly data?: unknown; readonly error?: unknown }>
    }
    readonly postSessionIdPermissionsPermissionId?: (options: { readonly path: { readonly id: string; readonly permissionID: string }; readonly body: { readonly response: 'once' }; readonly signal: AbortSignal }) => Promise<{ readonly data?: unknown; readonly error?: unknown }>
  }
}
interface Prompt {
  readonly sessionID: string
  readonly model?: { readonly modelID?: string; readonly providerID?: string; readonly api?: { readonly npm?: string } }
}
interface UserMessage { readonly id: string; readonly model?: { readonly modelID: string; readonly providerID?: string } }
interface V2SessionEvents {
  readonly prompt: { readonly sessionID: string; readonly messageID: string; readonly prompt?: { readonly text: string; readonly files?: readonly unknown[]; readonly agents?: readonly unknown[]; readonly skills?: readonly unknown[] } }
  readonly context: { readonly sessionID: string; readonly model: { readonly id: string; readonly providerID?: string }; readonly messages?: readonly unknown[] }
  readonly 'model.request': { readonly sessionID: string; readonly kind: string; readonly model: { readonly id: string; readonly providerID: string }; readonly headers: Record<string, string> }
  readonly 'http.request': { readonly sessionID: string; readonly kind: string; request: Request }
}
export interface V2Context extends V2ToolContext {
  readonly location: { readonly directory: string }
  readonly options: unknown
  readonly model?: { readonly list: (input: { readonly types: readonly ['chat'] }, options: { readonly signal: AbortSignal }) => Promise<unknown> }
  readonly provider?: { readonly get: (input: { readonly providerID: string }, options: { readonly signal: AbortSignal }) => Promise<unknown> }
  readonly permission?: { readonly hook: (name: 'evaluate', callback: (event: PermissionEvaluation) => Promise<void>) => Promise<{ readonly dispose: () => Promise<void> | void }> }
  readonly session: {
    readonly hook: <K extends keyof V2SessionEvents>(name: K, callback: (event: V2SessionEvents[K]) => Promise<void>) => Promise<{ readonly dispose: () => Promise<void> | void }>
    readonly get?: (input: { readonly sessionID: string }, options: { readonly signal: AbortSignal }) => Promise<unknown>
    readonly context?: (input: { readonly sessionID: string }, options: { readonly signal: AbortSignal }) => Promise<unknown>
  }
}

function history(info: unknown, messages: unknown): TranscriptHistory {
  if (!info || typeof info !== 'object' || !('id' in info) || typeof info.id !== 'string' || !Array.isArray(messages) || ('parentID' in info && typeof info.parentID !== 'string')) throw new HostHookError('HOST_TRANSCRIPT_HISTORY_UNAVAILABLE', 'unsupported')
  return { id: info.id, messages, ...('parentID' in info ? { parentID: info.parentID as string } : {}) }
}

export async function createHarnessHooks(input: V1Input, options: unknown, services: RuntimeServices = {}) {
  services = { ...services }
  const transcripts = services.transcripts ?? new ClaudeTranscript({ host: 'v1', directory: input.directory, history: async (event, signal) => {
    if (!input.client) throw new HostHookError('HOST_TRANSCRIPT_HISTORY_UNAVAILABLE', 'unsupported')
    const [info, messages] = await Promise.all([input.client.session.get({ path: { id: event.sessionID }, signal }), input.client.session.messages({ path: { id: event.sessionID }, signal })])
    if (info.error || messages.error) throw new HostHookError('HOST_TRANSCRIPT_HISTORY_UNAVAILABLE', 'unsupported')
    return history(info.data, messages.data)
  } })
  const runtime = await createRuntime('v1', input.directory, options, { ...services, transcripts })
  const approvals = new CallApprovals({ diagnostic: runtime.tools.diagnostic })
  const contexts = new PromptContexts()
  const wrappers = new Map<string, typeof fetch>()
  const protocols = new Map<string, { readonly turnID: string; readonly providerID: string; readonly protocol: PromptProtocol }>()
  const reply = input.client?.postSessionIdPermissionsPermissionId?.bind(input.client)
  const tools = createV1Hooks({ ...runtime.tools, ...(!runtime.tools.preapprove && reply ? { preapprove: async (event: HostToolEvent) => approvals.remember(event, runtime.sessions.get(event.sessionID)) } : {}) })
  const hooks = {
    ...tools,
    config: async (config: { provider?: Record<string, { options?: Record<string, unknown> }>; model?: string }) => {
      if (!runtime.hasPromptHooks) return
      config.provider ??= {}
      if (config.model?.includes('/')) config.provider[config.model.split('/')[0]!] ??= {}
      for (const [id, provider] of Object.entries(config.provider)) {
        provider.options ??= {}
        const original = typeof provider.options.fetch === 'function' ? provider.options.fetch as typeof fetch : globalThis.fetch
        if (wrappers.get(id) === original) continue
        const wrapped: typeof fetch = async (input, init) => {
          const token = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get(PROMPT_REQUEST_HEADER)
          if (!token) return original(input, init)
          return runtime.promptOperation('request', contexts.owner(token) ?? {}, async () => {
            const projected = await contexts.project(new Request(input, init), token)
            return original(input instanceof Request ? projected : input, { ...init, headers: projected.headers, body: await projected.clone().text(), signal: projected.signal })
          })
        }
        provider.options.fetch = wrapped
        wrappers.set(id, wrapped)
      }
    },
    'chat.message': async (prompt: Prompt, output: { readonly message: UserMessage; readonly parts?: readonly unknown[] }) => {
      runtime.sessions.prompt(prompt.sessionID, output.message.id, prompt.model?.modelID ?? output.message.model?.modelID)
      if (!runtime.hasPromptHooks) return
      const provider = prompt.model?.providerID ?? output.message.model?.providerID
      if (!provider || !wrappers.has(provider)) unavailable('HOST_PROMPT_TRANSPORT_UNAVAILABLE')
      const text = partsText(output.parts)
      const session = runtime.sessions.get(prompt.sessionID)
      await submit(runtime, contexts, { host: 'v1', event: 'UserPromptSubmit', sessionID: prompt.sessionID, messageID: output.message.id, prompt: text.join('\n'), signal: session.turnSignal }, text, services)
    },
    'chat.params': async (prompt: Prompt & { readonly message: UserMessage; readonly provider?: { readonly id?: string; readonly info?: { readonly id: string }; readonly options: Record<string, unknown> } }) => {
      const model = prompt.message.model?.modelID ?? prompt.model?.modelID
      if (model) runtime.sessions.model(prompt.sessionID, model, prompt.message.id)
      if (!runtime.hasPromptHooks) return
      const provider = prompt.provider
      const id = provider?.id ?? provider?.info?.id
      if (!provider || !id || provider.id && provider.info && provider.id !== provider.info.id || wrappers.get(id) !== provider.options.fetch) unavailable('HOST_PROMPT_TRANSPORT_UNAVAILABLE')
      protocols.set(prompt.sessionID, { turnID: prompt.message.id, providerID: id, protocol: protocol(prompt.model?.api?.npm) })
    },
    'experimental.chat.messages.transform': async (_input: unknown, output: { readonly messages: readonly unknown[] }) => {
      if (!runtime.hasPromptHooks) return
      const users = output.messages.filter((message: unknown) => record(message) && record(message.info) && message.info.role === 'user')
      const last = users.at(-1)
      if (!record(last) || !record(last.info) || typeof last.info.sessionID !== 'string') unavailable('HOST_PROMPT_LAYOUT_UNAVAILABLE')
      contexts.layout(runtime.sessions.get(last.info.sessionID), layout('v1', output.messages))
    },
    'chat.headers': async (prompt: Prompt & { readonly message: UserMessage }, output: { readonly headers: Record<string, string> }) => {
      if (!runtime.hasPromptHooks) return
      const session = runtime.sessions.get(prompt.sessionID)
      if (session.turnID !== prompt.message.id) throw new HostHookError('SESSION_STALE_TURN', 'cancelled')
      const provider = prompt.model?.providerID ?? prompt.message.model?.providerID
      const selected = protocols.get(prompt.sessionID)
      if (!selected || selected.turnID !== prompt.message.id || selected.providerID !== provider) unavailable('HOST_PROMPT_PROVIDER_UNAVAILABLE')
      const token = contexts.issue(session, selected.protocol)
      if (token) output.headers[PROMPT_REQUEST_HEADER] = token
    },
    event: async ({ event }: { readonly event: { readonly type: string; readonly properties?: unknown } }) => {
      if (event.type !== 'permission.asked' || !reply) return
      await approvals.replyV1(event.properties, async request => {
        const result = await reply({ path: { id: request.sessionID, permissionID: request.requestID }, body: { response: 'once' }, signal: request.signal })
        if (result.error || result.data !== true) throw new HostHookError('HOST_PERMISSION_REPLY_FAILED', 'failed')
      })
    },
    inspect: () => ({ ...tools.inspect(), permissions: approvals.inspect(), prompts: contexts.inspect(), runtime: runtime.inspect() }),
    disposeSession: async (sessionID: string) => { runtime.sessions.close(sessionID); protocols.delete(sessionID); await tools.disposeSession(sessionID) },
    dispose: async () => { runtime.sessions.dispose(); contexts.dispose(); protocols.clear(); await tools.dispose(); await approvals.dispose(); await runtime.dispose() },
  }
  return {
    ...hooks,
    'chat.message': guarded(runtime, 'admission', hooks['chat.message'], (prompt, output) => ({ sessionID: prompt.sessionID, messageID: output.message.id })),
    'chat.params': guarded(runtime, 'parameters', hooks['chat.params'], prompt => ({ sessionID: prompt.sessionID, messageID: prompt.message.id })),
    'chat.headers': guarded(runtime, 'headers', hooks['chat.headers'], prompt => ({ sessionID: prompt.sessionID, messageID: prompt.message.id })),
    'experimental.chat.messages.transform': guarded(runtime, 'layout', hooks['experimental.chat.messages.transform'], (_input, output) => {
      const last = output.messages.findLast(message => record(message) && record(message.info) && message.info.role === 'user')
      return record(last) && record(last.info) && typeof last.info.sessionID === 'string' && typeof last.info.id === 'string' ? { sessionID: last.info.sessionID, messageID: last.info.id } : {}
    }),
  }
}

export async function setupHarnessHooks(context: V2Context, services: RuntimeServices = {}) {
  services = { ...services }
  const transcripts = services.transcripts ?? new ClaudeTranscript({ host: 'v2', directory: context.location.directory, history: async (event, signal) => {
    if (!context.session.get || !context.session.context) throw new HostHookError('HOST_TRANSCRIPT_HISTORY_UNAVAILABLE', 'unsupported')
    const [info, messages] = await Promise.all([context.session.get({ sessionID: event.sessionID }, { signal }), context.session.context({ sessionID: event.sessionID }, { signal })])
    return history(info, messages)
  } })
  const runtime = await createRuntime('v2', context.location.directory, context.options, { ...services, transcripts })
  const approvals = new CallApprovals({ diagnostic: runtime.tools.diagnostic })
  const contexts = new PromptContexts()
  const handles = new Set<{ readonly dispose: () => Promise<void> | void }>()
  const register = <K extends keyof V2SessionEvents>(name: K, callback: (event: V2SessionEvents[K]) => Promise<void>) => context.session.hook(name, guarded(runtime, PROMPT_PHASES[name], callback, event => ({ sessionID: event.sessionID, ...('messageID' in event && typeof event.messageID === 'string' ? { messageID: event.messageID } : {}) })))
  let tools: Awaited<ReturnType<typeof registerV2Hooks>> | undefined
  let disposing: Promise<void> | undefined
  const cleanup = async () => {
    runtime.sessions.dispose()
    contexts.dispose()
    let toolError: unknown
    try { await tools?.dispose() } catch (error) { toolError = error }
    await approvals.dispose()
    let artifactError: unknown
    try { await runtime.dispose() } catch (error) { artifactError = error }
    for (const handle of handles) {
      try { await handle.dispose(); handles.delete(handle) } catch {}
    }
    if (toolError || handles.size) throw new HostHookError('HOST_REGISTRATION_DISPOSE_FAILED', 'failed')
    if (artifactError) throw artifactError
  }
  const dispose = () => { disposing ??= cleanup().finally(() => { disposing = undefined }); return disposing }
  try {
    handles.add(await register('prompt', async event => {
      runtime.sessions.prompt(event.sessionID, event.messageID)
      if (!runtime.hasPromptHooks) return
      const session = runtime.sessions.get(event.sessionID)
      if (!context.session.get || !event.prompt || ['files', 'agents', 'skills'].some(key => event.prompt![key as 'files']?.length)) unavailable('HOST_PROMPT_INPUT_UNAVAILABLE')
      const info = await runService(METADATA_MS, session.turnSignal, signal => context.session.get!({ sessionID: event.sessionID }, { signal }))
      if (!record(info) || info.id !== event.sessionID || !record(info.model) || typeof info.model.id !== 'string') unavailable('HOST_NATIVE_METADATA_UNAVAILABLE')
      runtime.sessions.model(event.sessionID, info.model.id, event.messageID)
      await submit(runtime, contexts, { host: 'v2', event: 'UserPromptSubmit', sessionID: event.sessionID, messageID: event.messageID, prompt: event.prompt.text, signal: session.turnSignal }, [event.prompt.text], services)
    }))
    handles.add(await register('context', async event => {
      const session = runtime.sessions.get(event.sessionID)
      if (runtime.hasPromptHooks) contexts.layout(session, layout('v2', event.messages))
      runtime.sessions.model(event.sessionID, event.model.id, session.turnID)
    }))
    if (runtime.hasPromptHooks) {
      handles.add(await register('model.request', async event => {
        if (event.kind !== 'primary') return
        const session = runtime.sessions.get(event.sessionID)
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
      handles.add(await register('http.request', async event => {
        if (event.kind !== 'primary') return
        const token = event.request.headers.get(PROMPT_REQUEST_HEADER)
        if (token) event.request = await contexts.project(event.request, token, runtime.sessions.get(event.sessionID))
      }))
    }
    if (context.permission) handles.add(await context.permission.hook('evaluate', async event => { approvals.applyV2(event) }))
    tools = await registerV2Hooks(context, { ...runtime.tools, ...(!runtime.tools.preapprove && context.permission ? { preapprove: async (event: HostToolEvent) => approvals.remember(event, runtime.sessions.get(event.sessionID)) } : {}) })
    return dispose
  } catch (error) { await dispose(); throw error }
}
