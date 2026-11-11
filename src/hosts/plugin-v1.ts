import { createV1Hooks } from './v1.js'
import type { PromptProtocol } from '../prompt-contexts.js'
import { HostHookError } from '../host-errors.js'
import { createRuntime } from '../runtime.js'
import type { RuntimeServices } from '../runtime.js'
import { ClaudeTranscript } from '../transcript.js'
import { CallApprovals } from './permissions.js'
import type { HostToolEvent } from '../tool-types.js'
import { PromptContexts, PROMPT_REQUEST_HEADER } from '../prompt-contexts.js'
import { record, unavailable, protocol, partsText, layout, submit, guarded, history } from './plugin-shared.js'

export interface V1Input {
  readonly directory: string
  readonly client?: {
    readonly session: {
      readonly get: (options: { readonly path: { readonly id: string }; readonly signal: AbortSignal }) => Promise<{ readonly data?: unknown; readonly error?: unknown }>
      readonly messages: (options: { readonly path: { readonly id: string }; readonly signal: AbortSignal }) => Promise<{ readonly data?: unknown; readonly error?: unknown }>
    }
    readonly postSessionIdPermissionsPermissionId?: (options: { readonly path: { readonly id: string; readonly permissionID: string }; readonly body: { readonly response: 'once' }; readonly signal: AbortSignal }) => Promise<{ readonly data?: unknown; readonly error?: unknown }>
    readonly tui?: {
      readonly showToast: (options: { readonly body: { readonly title: string; readonly message: string; readonly variant: 'error'; readonly duration: number }; readonly query: { readonly directory: string }; readonly signal: AbortSignal }) => Promise<{ readonly data?: unknown; readonly error?: unknown }>
    }
  }
}
interface Prompt {
  readonly sessionID: string
  readonly model?: { readonly modelID?: string; readonly providerID?: string; readonly api?: { readonly npm?: string } }
}
interface UserMessage { readonly id: string; readonly model?: { readonly modelID: string; readonly providerID?: string } }

export async function createHarnessHooks(input: V1Input, options: unknown, services: RuntimeServices = {}) {
  if (services.sessionStart) throw new HostHookError('HOST_SESSION_START_HOST_UNAVAILABLE', 'unsupported')
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
      if (!runtime.hasPromptHooks && !runtime.needsModelArtifacts) return
      const session = runtime.sessions.get(prompt.sessionID)
      if (session.turnID !== prompt.message.id) throw new HostHookError('SESSION_STALE_TURN', 'cancelled')
      runtime.observeModel({ host: 'v1', sessionID: prompt.sessionID, messageID: prompt.message.id, signal: session.turnSignal })
      if (!runtime.hasPromptHooks) return
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
