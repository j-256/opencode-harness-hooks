import { createV1Hooks } from './v1.js'
import type { PromptProtocol } from '../prompt-contexts.js'
import { HostHookError } from '../host-errors.js'
import { createRuntime } from '../runtime.js'
import type { RuntimeServices } from '../runtime.js'
import { ClaudeTranscript } from '../transcript.js'
import { CodexTranscript } from '../codex-transcript.js'
import { codexHistoryV1 } from './codex-history-v1.js'
import { CallApprovals } from './permissions.js'
import type { HostToolEvent } from '../tool-types.js'
import { PromptContexts, PROMPT_REQUEST_HEADER } from '../prompt-contexts.js'
import { record, unavailable, protocol, partsText, layout, submit, guarded, history } from './plugin-shared.js'
import { V1Startups } from './startup-v1.js'
import { V1SessionState } from './session-state-v1.js'
import { SessionStore } from '../session-store.js'
import { createHash, randomUUID } from 'node:crypto'
import { ClaudeEnvironmentError } from '../claude-environment-files.js'
import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { MODEL_REQUEST_HEADER, V1PromptModels } from './model-v1.js'
import type { V1ModelClient } from './model-v1.js'

const MAX_SESSION_CLEANUPS = 1024

export interface V1Input {
  readonly directory: string
  readonly client?: {
    readonly config?: { readonly get: (options: { readonly signal: AbortSignal }) => Promise<{ readonly data?: unknown; readonly error?: unknown }> }
    readonly session: Omit<V1ModelClient['session'], 'get'> & {
      readonly get: (options: { readonly path: { readonly id: string }; readonly signal: AbortSignal }) => Promise<{ readonly data?: unknown; readonly error?: unknown }>
      readonly messages: (options: { readonly path: { readonly id: string }; readonly signal: AbortSignal }) => Promise<{ readonly data?: unknown; readonly error?: unknown }>
    }
    readonly postSessionIdPermissionsPermissionId?: (options: { readonly path: { readonly id: string; readonly permissionID: string }; readonly body: { readonly response: 'once' }; readonly signal: AbortSignal }) => Promise<{ readonly data?: unknown; readonly error?: unknown }>
    readonly tui?: {
      readonly showToast: (options: { readonly body: { readonly title: string; readonly message: string; readonly variant: 'error'; readonly duration: number }; readonly query: { readonly directory: string }; readonly signal: AbortSignal }) => Promise<{ readonly data?: unknown; readonly error?: unknown }>
    }
  }
}
export interface V1Services extends RuntimeServices {
  readonly promptTransport?: {
    readonly providerID: string
    readonly attach: (wrap: (original: typeof fetch) => typeof fetch) => void
  }
}
interface Prompt {
  readonly sessionID: string
  readonly agent?: string
  readonly model?: { readonly modelID?: string; readonly providerID?: string; readonly api?: { readonly npm?: string } }
}
interface UserMessage { readonly id: string; readonly agent?: string; readonly model?: { readonly modelID: string; readonly providerID?: string } }

function auxiliary(prompt: Prompt & { readonly message: UserMessage }): boolean {
  // V1 internal model calls reuse the user's message with a different executing agent
  return typeof prompt.agent === 'string' && prompt.agent.length > 0 && typeof prompt.message.agent === 'string' && prompt.message.agent.length > 0 && prompt.agent !== prompt.message.agent
}

export async function createHarnessHooks(input: V1Input, options: unknown, services: V1Services = {}) {
  services = { ...services }
  const readHistory = async (event: { readonly sessionID: string }, signal: AbortSignal) => {
    if (!input.client) throw new HostHookError('HOST_TRANSCRIPT_HISTORY_UNAVAILABLE', 'unsupported')
    const [info, messages] = await Promise.all([input.client.session.get({ path: { id: event.sessionID }, signal }), input.client.session.messages({ path: { id: event.sessionID }, signal })])
    if (info.error || messages.error) throw new HostHookError('HOST_TRANSCRIPT_HISTORY_UNAVAILABLE', 'unsupported')
    return { info: info.data, messages: messages.data }
  }
  const transcripts = services.transcripts ?? new ClaudeTranscript({ host: 'v1', directory: input.directory, history: async (event, signal) => {
    const snapshot = await readHistory(event, signal)
    return history(snapshot.info, snapshot.messages)
  } })
  const codexTranscripts = services.codexTranscripts ?? new CodexTranscript({ host: 'v1', directory: input.directory, history: async (event, signal) => {
    const snapshot = await readHistory(event, signal)
    return codexHistoryV1(snapshot.info, snapshot.messages)
  } })
  const contexts = new PromptContexts()
  const project = await realpath(input.directory), environment = services.host?.environment ?? process.env
  const stateDirectory = join(environment.XDG_STATE_HOME ?? join(environment.HOME ?? homedir(), '.local', 'state'), 'opencode-harness-hooks', createHash('sha256').update(project).digest('hex'), 'native-state')
  const nativeState = services.nativeState ? undefined : new V1SessionState(new SessionStore({ host: 'v1', project, directory: stateDirectory, diagnostic: value => { console.error(JSON.stringify({ component: 'opencode-harness-hooks', ...value })) } }), { ...(!services.transcripts ? { claude: transcripts as ClaudeTranscript } : {}), ...(!services.codexTranscripts ? { codex: codexTranscripts as CodexTranscript } : {}), contexts }, { persistedPrompts: async (sessionID, signal) => {
    const snapshot = await readHistory({ sessionID }, signal), saved = history(snapshot.info, snapshot.messages)
    if (saved.id !== sessionID) unavailable('HOST_TRANSCRIPT_HISTORY_UNAVAILABLE')
    const ids: string[] = []
    for (const row of saved.messages) {
      if (!record(row) || !record(row.info) || row.info.sessionID !== sessionID || typeof row.info.id !== 'string' || !row.info.id || !['user', 'assistant'].includes(String(row.info.role))) unavailable('HOST_TRANSCRIPT_HISTORY_UNAVAILABLE')
      if (row.info.role === 'user') ids.push(row.info.id)
    }
    if (new Set(ids).size !== ids.length) unavailable('HOST_TRANSCRIPT_HISTORY_UNAVAILABLE')
    return ids
  } })
  const stateService = services.nativeState ?? nativeState!
  const startup = new V1Startups(input, transcripts, codexTranscripts, services, stateService)
  let models: V1PromptModels | undefined
  const runtime = await createRuntime('v1', input.directory, options, { ...services, host: { ...services.host, environment, ...(!services.host?.evaluatePrompt ? { evaluatePrompt: request => {
    if (!models) unavailable('HOST_PROMPT_MODEL_UNAVAILABLE')
    return models.evaluate(request)
  } } : {}) }, transcripts, codexTranscripts, nativeState: stateService, sessionStart: startup.service })
  startup.attach(runtime)
  if (!services.host?.evaluatePrompt && runtime.hasPromptModelHooks) {
    models = await V1PromptModels.create({ directory: input.directory, ...(input.client ? { client: input.client } : {}) })
    models.attach(runtime.sessions, runtime.modelOptions)
  }
  const hasContextHooks = runtime.hasPromptHooks || runtime.hasStartHooks
  const approvals = new CallApprovals({ diagnostic: runtime.tools.diagnostic })
  const needsProjection = (sessionID: string) => hasContextHooks || contexts.requiresProjection(sessionID)
  const admit = async (session: ReturnType<typeof runtime.sessions.get>, text: readonly string[]) => {
    try {
      await submit(runtime, contexts, { host: 'v1', event: 'UserPromptSubmit', sessionID: session.sessionID, messageID: session.turnID!, prompt: text.join('\n'), signal: session.turnSignal }, text, services)
      nativeState?.pendingPrompt(session)
      startup.bind(session, contexts)
      await stateService.checkpoint(session, session.turnSignal)
    } catch (error) {
      nativeState?.abandonPrompt(session)
      throw error
    }
  }
  const wrappers = new Map<string, typeof fetch>()
  const delegates = new Map<string, { readonly original: typeof fetch; readonly wrapped: typeof fetch }>()
  const managedWrappers = new WeakSet<typeof fetch>()
  const rejectedTransports = new Set<string>()
  const managed = services.promptTransport
  const wrap = (id: string, original: typeof fetch): typeof fetch => {
    const previous = delegates.get(id)
    if (previous?.original === original) return previous.wrapped
    const wrapped: typeof fetch = async (input, init) => {
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
      if (headers.has(MODEL_REQUEST_HEADER)) {
        if (!models || headers.has(PROMPT_REQUEST_HEADER)) unavailable('HOST_MODEL_REQUEST_OWNER_MISMATCH')
        return models.fetch(id, original, input, init)
      }
      const token = headers.get(PROMPT_REQUEST_HEADER)
      if (!token) return original(input, init)
      return runtime.promptOperation('request', contexts.owner(token) ?? {}, async () => {
        const projected = await contexts.project(new Request(input, init), token)
        return original(input instanceof Request ? projected : input, { ...init, headers: projected.headers, body: await projected.clone().text(), signal: projected.signal })
      })
    }
    delegates.set(id, { original, wrapped })
    wrappers.set(id, wrapped)
    if (id === managed?.providerID) managedWrappers.add(wrapped)
    return wrapped
  }
  let retainedProjection = false
  try { retainedProjection = !hasContextHooks && nativeState ? await nativeState.requiresProjection() : false }
  catch (error) { await Promise.allSettled([startup.dispose(), runtime.dispose(), nativeState?.dispose()]); contexts.dispose(); throw error }
  if ((hasContextHooks || retainedProjection || models) && managed) managed.attach(original => wrap(managed.providerID, original))
  const protocols = new Map<string, { readonly turnID: string; readonly providerID: string; readonly protocol: PromptProtocol }>()
  const reply = input.client?.postSessionIdPermissionsPermissionId?.bind(input.client)
  const tools = createV1Hooks({ ...runtime.tools, ...(!runtime.tools.preapprove && reply ? { preapprove: async (event: HostToolEvent) => approvals.remember(event, runtime.sessions.get(event.sessionID)) } : {}) })
  const disposeSession = async (sessionID: string) => { runtime.sessions.close(sessionID); protocols.delete(sessionID); await Promise.all([tools.disposeSession(sessionID), models?.removeSession(sessionID)]) }
  const cleanups = new Map<string, Promise<void>>()
  const cleanupFailures = new Map<string, readonly { readonly phase: string; readonly code: string }[]>()
  let cleanupObserverFailures = 0
  let cleanupOverflowFailures = 0
  const removeSession = (sessionID: string): Promise<void> => {
    const existing = cleanups.get(sessionID)
    if (existing) return existing
    if (cleanups.size >= MAX_SESSION_CLEANUPS) return Promise.reject(new HostHookError('HOST_SESSION_CLEANUP_LIMIT', 'unsupported'))
    const operationID = randomUUID()
    const operations = [
      { phase: 'runtime', run: async () => { await disposeSession(sessionID) } },
      { phase: 'startup', run: async () => { await runtime.removeStartupSession(sessionID) } },
      { phase: 'shell', run: async () => { await startup.removeSession(sessionID) } },
      { phase: 'claude-transcript', run: async () => { await transcripts.removeSession?.(sessionID) } },
      { phase: 'codex-transcript', run: async () => { await codexTranscripts.removeSession?.(sessionID) } },
      { phase: 'native-state', run: async () => { await stateService.remove?.(sessionID) } },
    ]
    // Closing synchronously fences writers before any cleanup component begins
    let closeError: unknown
    try { runtime.sessions.close(sessionID) } catch (error) { closeError = error }
    const pending = Promise.all(operations.map(async operation => {
      const started = performance.now()
      let code = 'HOST_SESSION_CLEANUP_SUCCEEDED', failure: { phase: string; code: string } | undefined
      try { if (operation.phase === 'runtime' && closeError) throw closeError; await operation.run() }
      catch (error) { code = error instanceof HostHookError || error instanceof ClaudeEnvironmentError ? error.code : 'HOST_SESSION_CLEANUP_FAILED'; failure = { phase: operation.phase, code } }
      try { console.error(JSON.stringify({ component: 'opencode-harness-hooks', host: 'v1', event: 'session.deleted', sessionID, operationID, phase: operation.phase, code, outcome: failure ? 'failed' : 'success', durationMs: Math.round(performance.now() - started) })) } catch { cleanupObserverFailures++ }
      return failure
    })).then(results => {
      const failed = results.filter((value): value is { phase: string; code: string } => value !== undefined)
      if (!failed.length) cleanupFailures.delete(sessionID)
      else if (cleanupFailures.has(sessionID) || cleanupFailures.size < MAX_SESSION_CLEANUPS) cleanupFailures.set(sessionID, failed)
      else cleanupOverflowFailures++
    })
    cleanups.set(sessionID, pending)
    void pending.finally(() => { if (cleanups.get(sessionID) === pending) cleanups.delete(sessionID) }).catch(() => {})
    return pending
  }
  const hooks = {
    ...tools,
    config: async (config: { provider?: Record<string, { options?: Record<string, unknown> }>; model?: string; small_model?: string; shell?: string; agent?: Record<string, unknown> }) => {
      await startup.configure(config)
      models?.configure(config)
      config.provider ??= {}
      if (config.model?.includes('/')) config.provider[config.model.split('/')[0]!] ??= {}
      if (models) for (const ref of [config.small_model, runtime.modelOptions.promptModel, ...Object.values(runtime.modelOptions.modelAliases ?? {}), ...runtime.nativePromptModels]) if (ref?.includes('/')) config.provider[ref.split('/')[0]!] ??= {}
      for (const [id, provider] of Object.entries(config.provider)) {
        provider.options ??= {}
        if (id === managed?.providerID) {
          if (provider.options.fetch !== undefined) {
            rejectedTransports.add(id)
            if (hasContextHooks || models) unavailable('HOST_PROMPT_TRANSPORT_UNAVAILABLE')
            continue
          }
          rejectedTransports.delete(id)
          continue
        }
        const original = typeof provider.options.fetch === 'function' ? provider.options.fetch as typeof fetch : globalThis.fetch
        if (wrappers.get(id) === original) continue
        provider.options.fetch = wrap(id, original)
      }
    },
    'chat.message': async (prompt: Prompt, output: { readonly message: UserMessage; readonly parts?: readonly unknown[] }) => {
      runtime.sessions.prompt(prompt.sessionID, output.message.id, prompt.model?.modelID ?? output.message.model?.modelID)
      const providerID = prompt.model?.providerID ?? output.message.model?.providerID, modelID = prompt.model?.modelID ?? output.message.model?.modelID
      if (models && providerID && modelID) models.observe(prompt.sessionID, output.message.id, { providerID, modelID })
      const session = runtime.sessions.get(prompt.sessionID)
      await stateService.ensure(session, session.turnSignal)
      if (!needsProjection(prompt.sessionID)) {
        if (Array.isArray(output.parts) && output.parts.length && output.parts.every(part => record(part) && part.type === 'text' && typeof part.text === 'string')) {
          const text = partsText(output.parts)
          await admit(session, text)
        } else await stateService.checkpoint(session, session.turnSignal)
        return
      }
      const provider = prompt.model?.providerID ?? output.message.model?.providerID
      if (!provider || rejectedTransports.has(provider) || !wrappers.has(provider) && provider !== managed?.providerID) unavailable('HOST_PROMPT_TRANSPORT_UNAVAILABLE')
      const text = partsText(output.parts)
      await startup.ensure(session)
      await admit(session, text)
    },
    'chat.params': async (prompt: Prompt & { readonly message: UserMessage; readonly provider?: { readonly id?: string; readonly info?: { readonly id: string }; readonly options: Record<string, unknown> } }) => {
      if (auxiliary(prompt)) return
      const model = prompt.message.model?.modelID ?? prompt.model?.modelID
      if (model) runtime.sessions.model(prompt.sessionID, model, prompt.message.id)
      const session = runtime.sessions.get(prompt.sessionID)
      const providerID = prompt.model?.providerID ?? prompt.message.model?.providerID
      if (models && providerID && model) models.observe(prompt.sessionID, prompt.message.id, { providerID, modelID: model })
      await stateService.ensure(session, session.turnSignal)
      if (!needsProjection(prompt.sessionID)) return
      const provider = prompt.provider
      const id = provider?.id ?? provider?.info?.id
      const owned = id === managed?.providerID
        ? typeof provider?.options.fetch === 'function' && managedWrappers.has(provider.options.fetch as typeof fetch)
        : id !== undefined && wrappers.get(id) === provider?.options.fetch
      if (!provider || !id || provider.id && provider.info && provider.id !== provider.info.id || !owned) unavailable('HOST_PROMPT_TRANSPORT_UNAVAILABLE')
      protocols.set(prompt.sessionID, { turnID: prompt.message.id, providerID: id, protocol: protocol(prompt.model?.api?.npm) })
    },
    'experimental.chat.messages.transform': async (_input: unknown, output: { readonly messages: readonly unknown[] }) => {
      const users = output.messages.filter((message: unknown) => record(message) && record(message.info) && message.info.role === 'user')
      const last = users.at(-1)
      if (!record(last) || !record(last.info) || typeof last.info.sessionID !== 'string') { if (!hasContextHooks) return; unavailable('HOST_PROMPT_LAYOUT_UNAVAILABLE') }
      const session = runtime.sessions.get(last.info.sessionID)
      await stateService.ensure(session, session.turnSignal)
      if (!needsProjection(last.info.sessionID)) return
      if (!record(last) || !record(last.info) || typeof last.info.sessionID !== 'string') unavailable('HOST_PROMPT_LAYOUT_UNAVAILABLE')
      contexts.layout(runtime.sessions.get(last.info.sessionID), layout('v1', output.messages))
    },
    'chat.headers': async (prompt: Prompt & { readonly message: UserMessage }, output: { readonly headers: Record<string, string> }) => {
      if (auxiliary(prompt)) return
      const session = runtime.sessions.get(prompt.sessionID)
      await stateService.ensure(session, session.turnSignal)
      if (!needsProjection(prompt.sessionID) && !runtime.needsModelArtifacts) return
      if (session.turnID !== prompt.message.id) throw new HostHookError('SESSION_STALE_TURN', 'cancelled')
      runtime.observeModel({ host: 'v1', sessionID: prompt.sessionID, messageID: prompt.message.id, signal: session.turnSignal })
      await startup.model(session)
      await stateService.checkpoint(session, session.turnSignal)
      if (!needsProjection(prompt.sessionID)) return
      const provider = prompt.model?.providerID ?? prompt.message.model?.providerID
      const selected = protocols.get(prompt.sessionID)
      if (!selected || selected.turnID !== prompt.message.id || selected.providerID !== provider) unavailable('HOST_PROMPT_PROVIDER_UNAVAILABLE')
      const token = contexts.issue(session, selected.protocol)
      if (token) output.headers[PROMPT_REQUEST_HEADER] = token
    },
    event: async ({ event }: { readonly event: { readonly type: string; readonly properties?: unknown } }) => {
      if (models?.event(event.type, event.properties)) return
      startup.event(event.type, event.properties)
      if (event.type === 'session.created' && record(event.properties)) {
        const info = record(event.properties.info) ? event.properties.info : undefined
        const id = typeof event.properties.sessionID === 'string' ? event.properties.sessionID : info?.id
        if (typeof id === 'string' && id && (info?.id === undefined || info.id === id)) {
          try { await startup.begin(id) } catch { console.error(JSON.stringify({ component: 'opencode-harness-hooks', host: 'v1', event: 'SessionStart', phase: 'session-created', sessionID: id, code: 'HOST_STARTUP_ACTIVATION_FAILED' })) }
        }
        return
      }
      if (event.type === 'session.deleted' && record(event.properties)) {
        const info = record(event.properties.info) ? event.properties.info : undefined
        const id = typeof event.properties.sessionID === 'string' ? event.properties.sessionID : info?.id
        if (typeof id === 'string' && id && (info?.id === undefined || info.id === id)) {
          await removeSession(id)
        }
        return
      }
      if (event.type !== 'permission.asked' || !reply) return
      await approvals.replyV1(event.properties, async request => {
        const result = await reply({ path: { id: request.sessionID, permissionID: request.requestID }, body: { response: 'once' }, signal: request.signal })
        if (result.error || result.data !== true) throw new HostHookError('HOST_PERMISSION_REPLY_FAILED', 'failed')
      })
    },
    'shell.env': async (input: { readonly sessionID?: string }, output: { readonly env: Record<string, string> }) => {
      if (!input.sessionID) return
      if (models?.owns(input.sessionID)) unavailable('HOST_MODEL_TOOL_UNAVAILABLE')
      Object.assign(output.env, await startup.shellEnvironment(runtime.sessions.get(input.sessionID)))
    },
    inspect: () => ({ ...tools.inspect(), permissions: approvals.inspect(), prompts: contexts.inspect(), runtime: runtime.inspect(), ...(models ? { models: models.inspect() } : {}), cleanup: Object.freeze({ pending: cleanups.size, failedSessions: cleanupFailures.size, overflowFailures: cleanupOverflowFailures, observerFailures: cleanupObserverFailures }), ...(nativeState ? { nativeState: nativeState.inspect() } : {}) }),
    disposeSession,
    dispose: async () => { runtime.sessions.dispose(); await models?.dispose(); contexts.dispose(); protocols.clear(); wrappers.clear(); delegates.clear(); rejectedTransports.clear(); await Promise.allSettled([...cleanups.values()]); try { await startup.dispose(); await tools.dispose(); await approvals.dispose(); await runtime.dispose() } finally { await nativeState?.dispose() } },
  }
  const message = guarded(runtime, 'admission', hooks['chat.message'], (prompt, output) => ({ sessionID: prompt.sessionID, messageID: output.message.id }))
  const parameters = guarded(runtime, 'parameters', hooks['chat.params'], prompt => ({ sessionID: prompt.sessionID, messageID: prompt.message.id }))
  const headers = guarded(runtime, 'headers', hooks['chat.headers'], prompt => ({ sessionID: prompt.sessionID, messageID: prompt.message.id }))
  const messages = guarded(runtime, 'layout', hooks['experimental.chat.messages.transform'], (_input, output) => {
    const last = output.messages.findLast(message => record(message) && record(message.info) && message.info.role === 'user')
    return record(last) && record(last.info) && typeof last.info.sessionID === 'string' && typeof last.info.id === 'string' ? { sessionID: last.info.sessionID, messageID: last.info.id } : {}
  })
  return {
    ...hooks,
    'tool.execute.before': async (...args: Parameters<typeof tools['tool.execute.before']>) => { if (models?.owns(args[0].sessionID)) return models.tool(args[0]); return tools['tool.execute.before'](...args) },
    'tool.execute.after': async (...args: Parameters<typeof tools['tool.execute.after']>) => { if (models?.owns(args[0].sessionID)) return models.tool(args[0]); return tools['tool.execute.after'](...args) },
    'chat.message': async (...args: Parameters<typeof message>) => { if (models?.owns(args[0].sessionID)) return models.message(...args); return message(...args) },
    'chat.params': async (...args: Parameters<typeof parameters>) => {
      const prompt = args[0]
      if (!models?.owns(prompt.sessionID)) return parameters(...args)
      models.parameters(prompt)
      const provider = prompt.provider, id = provider?.id ?? provider?.info?.id
      const valid = id === managed?.providerID ? typeof provider?.options.fetch === 'function' && managedWrappers.has(provider.options.fetch as typeof fetch) : id !== undefined && wrappers.get(id) === provider?.options.fetch
      if (!id || !valid || id !== prompt.model?.providerID) unavailable('HOST_PROMPT_TRANSPORT_UNAVAILABLE')
    },
    'chat.headers': async (...args: Parameters<typeof headers>) => { if (models?.owns(args[0].sessionID)) { models.headers(args[0]); models.requestHeaders(args[0], args[1].headers); return }; return headers(...args) },
    'experimental.chat.messages.transform': async (...args: Parameters<typeof messages>) => { if (models?.layout(args[1].messages)) return; return messages(...args) },
    'experimental.chat.system.transform': async (prompt: Prompt, output: { system: string[] }) => { if (models?.owns(prompt.sessionID)) models.system(prompt, output) },
  }
}
