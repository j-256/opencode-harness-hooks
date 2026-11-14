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
import { V1AgentPermissions } from './agent-permissions-v1.js'
import { V1AgentModels, AGENT_VERDICT_TOOL } from './agent-v1.js'
import type { V1ModelClient } from './model-v1.js'
import { V1McpTools } from './mcp-v1.js'
import type { V1McpClient } from './mcp-v1.js'
import { WakeRecords } from '../wake-records.js'
import { V1WakeInputs } from './wake-inputs-v1.js'
import { V1Wake } from './wake-v1.js'
import type { V1WakeDiagnostic } from './wake-v1.js'
import { V1WakeIdle } from './wake-idle-v1.js'
import type { V1WakeIdleDiagnostic } from './wake-idle-v1.js'
import { BackgroundRecords } from '../background-records.js'
import { V1Background } from './background-v1.js'
import type { V1BackgroundDiagnostic } from './background-v1.js'
import { BACKGROUND_REQUEST_HEADER, V1BackgroundProjection } from './background-projection-v1.js'

const MAX_SESSION_CLEANUPS = 1024
const NATIVE_VERDICT_TOOL = 'StructuredOutput'
const BACKGROUND_TOAST_MS = 10000

export interface V1Input {
  readonly serverUrl?: URL
  readonly directory: string
  readonly client?: {
    readonly app?: NonNullable<V1ModelClient['app']>
    readonly mcp?: NonNullable<V1McpClient['mcp']>
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
  readonly backgroundDiagnostic?: (value: V1BackgroundDiagnostic | V1WakeDiagnostic | V1WakeIdleDiagnostic) => void
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
interface UserMessage { readonly tools?: Readonly<Record<string, boolean>>; readonly id: string; readonly agent?: string; readonly model?: { readonly modelID: string; readonly providerID?: string } }

function auxiliary(prompt: Prompt & { readonly message: UserMessage }): boolean {
  // V1 internal model calls reuse the user's message with a different executing agent
  return typeof prompt.agent === 'string' && prompt.agent.length > 0 && typeof prompt.message.agent === 'string' && prompt.message.agent.length > 0 && prompt.agent !== prompt.message.agent
}

export async function createHarnessHooks(input: V1Input, options: unknown, services: V1Services = {}) {
  services = { ...services }
  const backgroundRecords = new BackgroundRecords(), wakeRecords = new WakeRecords(), wakeInputs = new V1WakeInputs()
  const readRawHistory = async (event: { readonly sessionID: string }, signal: AbortSignal) => {
    if (!input.client) throw new HostHookError('HOST_TRANSCRIPT_HISTORY_UNAVAILABLE', 'unsupported')
    const [info, messages] = await Promise.all([input.client.session.get({ path: { id: event.sessionID }, signal }), input.client.session.messages({ path: { id: event.sessionID }, signal })])
    if (info.error || messages.error) throw new HostHookError('HOST_TRANSCRIPT_HISTORY_UNAVAILABLE', 'unsupported')
    return { info: info.data, messages: messages.data }
  }
  const readHistory = async (event: { readonly sessionID: string }, signal: AbortSignal) => {
    const snapshot = await readRawHistory(event, signal)
    return { ...snapshot, messages: wakeInputs.normalize(event.sessionID, snapshot.messages) }
  }
  const transcripts = services.transcripts ?? new ClaudeTranscript({ host: 'v1', directory: input.directory, background: backgroundRecords, wakes: wakeRecords, history: async (event, signal) => {
    const snapshot = await readHistory(event, signal)
    return history(snapshot.info, snapshot.messages)
  } })
  const codexTranscripts = services.codexTranscripts ?? new CodexTranscript({ host: 'v1', directory: input.directory, background: backgroundRecords, history: async (event, signal) => {
    const snapshot = await readHistory(event, signal)
    return codexHistoryV1(snapshot.info, snapshot.messages)
  } })
  const contexts = new PromptContexts()
  const project = await realpath(input.directory), environment = services.host?.environment ?? process.env
  const stateDirectory = join(environment.XDG_STATE_HOME ?? join(environment.HOME ?? homedir(), '.local', 'state'), 'opencode-harness-hooks', createHash('sha256').update(project).digest('hex'), 'native-state')
  const nativeState = services.nativeState ? undefined : new V1SessionState(new SessionStore({ host: 'v1', project, directory: stateDirectory, diagnostic: value => { console.error(JSON.stringify({ component: 'opencode-harness-hooks', ...value })) } }), { ...(!services.transcripts ? { claude: transcripts as ClaudeTranscript } : {}), ...(!services.codexTranscripts ? { codex: codexTranscripts as CodexTranscript } : {}), contexts, background: backgroundRecords, wakes: wakeRecords, wakeInputs }, { persistedPrompts: async (sessionID, signal) => {
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
  const customBackground = services.host?.background
  const wake = new V1Wake({ records: wakeRecords, state: stateService, ...(services.backgroundDiagnostic ? { diagnostic: services.backgroundDiagnostic } : {}), ...(input.client?.tui ? { toast: async (text, _session, signal) => {
    const result = await input.client!.tui!.showToast({ body: { title: 'Hook notification', message: text, variant: 'error', duration: BACKGROUND_TOAST_MS }, query: { directory: input.directory }, signal })
    if (result.error || result.data !== true) unavailable('HOST_WAKE_UI_FAILED')
  } } : {}) })
  let idleWake: V1WakeIdle | undefined
  const canWake = !customBackground && !!input.client?.session.prompt && !!transcripts.prepareNotification
  const background = new V1Background({ records: backgroundRecords, state: stateService, ...(canWake ? { wakes: { records: wakeRecords, receive: async notice => { await wake.receive(notice); idleWake?.resume(notice.sessionID) } } } : {}), ...(services.backgroundDiagnostic ? { diagnostic: services.backgroundDiagnostic } : {}), ...(input.client?.tui ? { toast: async (text, _session, signal) => {
    const result = await input.client!.tui!.showToast({ body: { title: 'Codex background hook', message: text, variant: 'error', duration: BACKGROUND_TOAST_MS }, query: { directory: input.directory }, signal })
    if (result.error || result.data !== true) unavailable('HOST_BACKGROUND_UI_FAILED')
  } } : {}) })
  const backgroundProjection = new V1BackgroundProjection({ records: backgroundRecords, wakes: wakeRecords, prepare: async (session, anchor, signal) => { await background.prepare(session, anchor, signal); await wake.prepare(session, anchor, signal) } })
  const startup = new V1Startups(input, transcripts, codexTranscripts, services, stateService)
  let models: V1PromptModels | undefined, agents: V1AgentModels | undefined, mcp: V1McpTools | undefined
  let agentPermissions: V1AgentPermissions | undefined
  let agentTools: ReturnType<typeof createV1Hooks> | undefined
  const internal = (sessionID: string) => mcp?.owns(sessionID) ? mcp : agents?.owns(sessionID) ? agents : models?.owns(sessionID) ? models : undefined
  const runtime = await createRuntime('v1', input.directory, options, { ...services, host: { ...services.host, environment, ...(!customBackground ? { background } : {}), ...(!services.host?.evaluatePrompt ? { evaluatePrompt: request => {
    if (!models) unavailable('HOST_PROMPT_MODEL_UNAVAILABLE')
    return models.evaluate(request)
  } } : {}), ...(!services.host?.runAgent ? { runAgent: request => {
    if (!agents) unavailable('HOST_AGENT_MODEL_UNAVAILABLE')
    return agents.evaluate(request)
  } } : {}), ...(!services.host?.mcp ? { mcp: { timeoutAccounting: 'wall' as const, execute: request => {
    if (!mcp) unavailable('HOST_MCP_TOOL_UNAVAILABLE')
    return mcp.execute(request)
  } } } : {}) }, transcripts, codexTranscripts, nativeState: stateService, sessionStart: startup.service, ...(!customBackground ? { notifications: { prepare: async (event, session, signal, selected) => {
    if (services.notifications) return services.notifications.prepare(event, session, signal, selected)
    let path: string | undefined, codex: Awaited<ReturnType<NonNullable<typeof codexTranscripts.prepareNotification>>> | undefined
    if (selected.some(row => row.dialect === 'claude-code')) {
      if (!transcripts.prepareNotification) unavailable('HOST_NOTIFICATION_UNAVAILABLE')
      path = await transcripts.prepareNotification(event, session, signal)
    }
    if (selected.some(row => row.dialect === 'codex')) {
      if (!codexTranscripts.prepareNotification) unavailable('HOST_NOTIFICATION_UNAVAILABLE')
      codex = await codexTranscripts.prepareNotification(event, session, signal)
    }
    return { dialectData: { ...(path ? { 'claude-code': { transcript_path: path } } : {}), ...(codex ? { codex: { transcript_path: codex.transcriptPath, turn_id: codex.turnID } } : {}) }, ...(codex ? { nativeSessionIDs: { codex: codex.sessionID } } : {}) }
  }, capture: async (event, session, dispatch, signal) => { await services.notifications?.capture(event, session, dispatch, signal); await wake.capture(event, session, dispatch, signal) } } } : {}) })
  startup.attach(runtime)
  wake.attach(runtime.sessions, runtime)
  if (canWake) idleWake = new V1WakeIdle({ records: wakeRecords, inputs: wakeInputs, sessions: runtime.sessions, wake, state: stateService, history: async (sessionID, signal) => {
    const snapshot = await readRawHistory({ sessionID }, signal)
    return history(snapshot.info, snapshot.messages).messages
  }, prompt: (sessionID, body, signal) => input.client!.session.prompt!({ path: { id: sessionID }, query: { directory: input.directory }, body, signal }), ...(services.backgroundDiagnostic ? { diagnostic: services.backgroundDiagnostic } : {}) })
  background.attach(runtime.sessions, customBackground ? [] : runtime.backgroundRegistrations)
  if (!services.host?.evaluatePrompt && runtime.hasPromptModelHooks) {
    models = await V1PromptModels.create({ directory: input.directory, ...(input.client ? { client: input.client } : {}) })
    models.attach(runtime.sessions, runtime.modelOptions)
  }
  if (!services.host?.runAgent && runtime.hasAgentModelHooks) {
    agents = await V1AgentModels.create({
      directory: input.directory,
      ...(input.client ? { client: input.client } : {}),
      nested: {
        closed: async sessionID => { agentTools?.disposeSession(sessionID); agentPermissions?.removeChild(sessionID) },
        before: async (execution, call, output) => {
          if (!agentTools || !agentPermissions) unavailable('HOST_AGENT_TOOL_UNAVAILABLE')
          try {
            await agentTools['tool.execute.before']({ ...call, tool: call.tool === AGENT_VERDICT_TOOL ? NATIVE_VERDICT_TOOL : call.tool }, output)
            agentPermissions.capture(execution, call, output.args)
          } catch (error) { agentPermissions.complete(call); throw error }
        },
        after: async (_execution, call, output) => {
          if (!agentTools) unavailable('HOST_AGENT_TOOL_UNAVAILABLE')
          try { await agentTools['tool.execute.after']({ ...call, tool: call.tool === AGENT_VERDICT_TOOL ? NATIVE_VERDICT_TOOL : call.tool }, output) }
          finally { agentPermissions?.complete(call) }
        },
      },
    })
    agents.attach(runtime.sessions, runtime.modelOptions)
  }
  if (!services.host?.mcp && runtime.hasMcpHooks) {
    mcp = await V1McpTools.create({ directory: input.directory, ...(input.client ? { client: input.client } : {}) })
    mcp.attach(runtime.sessions)
  }
  const hasContextHooks = runtime.hasPromptHooks || runtime.hasStartHooks
  const hasBackgroundHooks = !customBackground && runtime.backgroundRegistrations.length > 0
  const approvals = new CallApprovals({ diagnostic: runtime.tools.diagnostic })
  const needsPromptProjection = (sessionID: string) => hasContextHooks || contexts.requiresProjection(sessionID)
  const needsBackgroundProjection = (sessionID: string) => hasBackgroundHooks || backgroundRecords.requiresProjection(sessionID) || wakeRecords.requiresProjection(sessionID) || wakeInputs.requiresProjection(sessionID)
  const needsProjection = (sessionID: string) => needsPromptProjection(sessionID) || needsBackgroundProjection(sessionID)
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
        const evaluator = [models, agents, mcp].find(service => service?.ownsRequest(headers.get(MODEL_REQUEST_HEADER)!))
        if (!evaluator || headers.has(PROMPT_REQUEST_HEADER) || headers.has(BACKGROUND_REQUEST_HEADER)) unavailable('HOST_MODEL_REQUEST_OWNER_MISMATCH')
        return evaluator.fetch(id, original, input, init)
      }
      const token = headers.get(PROMPT_REQUEST_HEADER)
      const backgroundToken = headers.get(BACKGROUND_REQUEST_HEADER)
      if (headers.has(PROMPT_REQUEST_HEADER) && !token || headers.has(BACKGROUND_REQUEST_HEADER) && !backgroundToken) unavailable('HOST_PROMPT_REQUEST_UNAVAILABLE')
      if (!token && !backgroundToken) return original(input, init)
      const owner = token ? contexts.owner(token) : backgroundProjection.owner(backgroundToken!)
      if (token && backgroundToken) {
        const second = backgroundProjection.owner(backgroundToken)
        if (!owner || !second || owner.sessionID !== second.sessionID || owner.messageID !== second.messageID) unavailable('HOST_BACKGROUND_OWNER_MISMATCH')
      }
      return runtime.promptOperation('request', owner ?? {}, async () => {
        let projected = new Request(input, init)
        if (token) projected = await contexts.project(projected, token)
        if (backgroundToken) projected = await backgroundProjection.project(projected, backgroundToken, id)
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
  catch (error) { await Promise.allSettled([startup.dispose(), idleWake?.dispose(), wake.dispose(), background.dispose(), runtime.dispose(), nativeState?.dispose()]); contexts.dispose(); backgroundProjection.dispose(); backgroundRecords.dispose(); wakeRecords.dispose(); wakeInputs.dispose(); throw error }
  if ((hasContextHooks || hasBackgroundHooks || retainedProjection || models || agents || mcp) && managed) managed.attach(original => wrap(managed.providerID, original))
  const protocols = new Map<string, { readonly turnID: string; readonly providerID: string; readonly protocol: PromptProtocol }>()
  const reply = input.client?.postSessionIdPermissionsPermissionId?.bind(input.client)
  const tools = createV1Hooks({ ...runtime.tools, ...(!runtime.tools.preapprove && reply ? { preapprove: async (event: HostToolEvent) => approvals.remember(event, runtime.sessions.get(event.sessionID)) } : {}) })
  if (agents) {
    agentPermissions = new V1AgentPermissions({ directory: input.directory, environment, ...(input.serverUrl ? { serverUrl: input.serverUrl } : {}), owner: request => agents!.permissionOwner(request) })
    agentTools = createV1Hooks({ ...runtime.tools, dispatch: event => runtime.agentTool(agents!.execution(event.sessionID), event), ...(!runtime.tools.preapprove ? { preapprove: async (event: HostToolEvent) => { agentPermissions!.approve(agents!.execution(event.sessionID), { ...event, tool: event.tool === NATIVE_VERDICT_TOOL ? AGENT_VERDICT_TOOL : event.tool }) } } : {}) })
  }
  const disposeSession = async (sessionID: string) => { runtime.sessions.close(sessionID); backgroundProjection.removeSession(sessionID); agentPermissions?.removeSession(sessionID); protocols.delete(sessionID); await Promise.all([tools.disposeSession(sessionID), models?.removeSession(sessionID), agents?.removeSession(sessionID), mcp?.removeSession(sessionID), agentTools?.disposeSession(sessionID), background.removeSession(sessionID), idleWake?.removeSession(sessionID), wake.removeSession(sessionID)]); backgroundRecords.removeSession(sessionID); wakeRecords.removeSession(sessionID); wakeInputs.removeSession(sessionID) }
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
    config: async (config: { provider?: Record<string, { options?: Record<string, unknown> }>; enabled_providers?: string[]; disabled_providers?: string[]; model?: string; small_model?: string; shell?: string; agent?: Record<string, unknown>; permission?: Record<string, unknown> }) => {
      await startup.configure(config)
      models?.configure(config)
      if (agents) {
        const permission: unknown = config.permission
        if (typeof permission === 'string') { if (!['allow', 'ask', 'deny'].includes(permission)) unavailable('HOST_AGENT_PERMISSION_CONFIG_INVALID'); config.permission = { '*': permission } }
        else if (permission !== undefined && !record(permission)) unavailable('HOST_AGENT_PERMISSION_CONFIG_INVALID')
        agents.configure(config)
        config.permission ??= {}; config.permission[AGENT_VERDICT_TOOL] = 'deny'
      }
      mcp?.configure(config)
      config.provider ??= {}
      if (config.model?.includes('/')) config.provider[config.model.split('/')[0]!] ??= {}
      if (models || agents) for (const ref of [config.small_model, runtime.modelOptions.promptModel, runtime.modelOptions.agentModel, ...runtime.nativeAgentModels, ...Object.values(runtime.modelOptions.modelAliases ?? {}), ...runtime.nativePromptModels]) if (ref?.includes('/')) config.provider[ref.split('/')[0]!] ??= {}
      for (const [id, provider] of Object.entries(config.provider)) {
        provider.options ??= {}
        if (id === managed?.providerID) {
          if (provider.options.fetch !== undefined) {
            rejectedTransports.add(id)
            if (hasContextHooks || hasBackgroundHooks || retainedProjection || models || agents || mcp) unavailable('HOST_PROMPT_TRANSPORT_UNAVAILABLE')
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
      idleWake?.busy(prompt.sessionID)
      const before = runtime.sessions.get(prompt.sessionID)
      await stateService.ensure(before, before.signal)
      if (idleWake && await idleWake.message(prompt.sessionID, output.message, output.parts)) return
      if (!idleWake && wakeInputs.claim(before, output.message, output.parts)) unavailable('HOST_NOTIFICATION_UNAVAILABLE')
      runtime.sessions.prompt(prompt.sessionID, output.message.id, prompt.model?.modelID ?? output.message.model?.modelID)
      const providerID = prompt.model?.providerID ?? output.message.model?.providerID, modelID = prompt.model?.modelID ?? output.message.model?.modelID
      if (models && providerID && modelID) models.observe(prompt.sessionID, output.message.id, { providerID, modelID }, { agent: output.message.agent, tools: output.message.tools })
      if (agents && providerID && modelID) agents.observe(prompt.sessionID, output.message.id, { providerID, modelID }, { agent: output.message.agent, tools: output.message.tools })
      const session = runtime.sessions.get(prompt.sessionID)
      await stateService.ensure(session, session.turnSignal)
      await background.resume(session)
      await wake.resume(session)
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
      if (models && providerID && model) models.observe(prompt.sessionID, prompt.message.id, { providerID, modelID: model }, { agent: prompt.message.agent, tools: prompt.message.tools })
      if (agents && providerID && model) agents.observe(prompt.sessionID, prompt.message.id, { providerID, modelID: model }, { agent: prompt.message.agent, tools: prompt.message.tools })
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
      const normalized = wakeInputs.normalize(session.sessionID, output.messages), owned = new Set(wakeInputs.read(session).map(input => input.messageID))
      if (needsPromptProjection(last.info.sessionID)) contexts.layout(session, layout('v1', normalized).map(row => ({ ...row, ...(owned.has(row.id) ? { external: true as const } : {}) })))
      if (needsBackgroundProjection(last.info.sessionID)) backgroundProjection.capture(session, normalized)
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
      const token = needsPromptProjection(prompt.sessionID) ? contexts.issue(session, selected.protocol) : undefined
      if (token) output.headers[PROMPT_REQUEST_HEADER] = token
      if (needsBackgroundProjection(prompt.sessionID)) output.headers[BACKGROUND_REQUEST_HEADER] = backgroundProjection.issue(session, selected.providerID, selected.protocol)
    },
    event: async ({ event }: { readonly event: { readonly type: string; readonly properties?: unknown } }) => {
      if (event.type === 'permission.asked' && record(event.properties) && typeof event.properties.sessionID === 'string' && agents?.owns(event.properties.sessionID)) {
        try { await agentPermissions!.reply(event.properties) } catch (error) { agents.failPermission(event.properties.sessionID, error instanceof HostHookError ? error.code : 'HOST_AGENT_PERMISSION_FAILED') }
        return
      }
      if (mcp?.event(event.type, event.properties) || agents?.event(event.type, event.properties) || models?.event(event.type, event.properties)) return
      startup.event(event.type, event.properties)
      idleWake?.event(event.type, event.properties)
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
      if (mcp?.owns(input.sessionID)) unavailable('HOST_MCP_TOOL_OWNER_MISMATCH')
      if (models?.owns(input.sessionID)) unavailable('HOST_MODEL_TOOL_UNAVAILABLE')
      if (agents?.owns(input.sessionID)) { const execution = agents.execution(input.sessionID); Object.assign(output.env, await startup.shellEnvironment(runtime.sessions.get(execution.parentID))); return }
      Object.assign(output.env, await startup.shellEnvironment(runtime.sessions.get(input.sessionID)))
    },
    inspect: () => ({ ...tools.inspect(), permissions: approvals.inspect(), prompts: contexts.inspect(), runtime: runtime.inspect(), ...(!customBackground ? { background: background.inspect() } : {}), backgroundRecords: backgroundRecords.inspect(), backgroundProjection: backgroundProjection.inspect(), wakes: wake.inspect(), wakeRecords: wakeRecords.inspect(), wakeInputs: wakeInputs.inspect(), ...(idleWake ? { idleWake: idleWake.inspect() } : {}), ...(models ? { models: models.inspect() } : {}), ...(mcp ? { mcp: mcp.inspect() } : {}), ...(agents ? { agents: agents.inspect(), agentPermissions: agentPermissions!.inspect(), agentTools: agentTools!.inspect() } : {}), cleanup: Object.freeze({ pending: cleanups.size, failedSessions: cleanupFailures.size, overflowFailures: cleanupOverflowFailures, observerFailures: cleanupObserverFailures }), ...(nativeState ? { nativeState: nativeState.inspect() } : {}) }),
    disposeSession,
    settleWake: async (sessionID: string) => { await background.completed(sessionID); await idleWake?.settled(sessionID); await wake.settled(sessionID) },
    dispose: async () => { runtime.sessions.dispose(); backgroundProjection.dispose(); await Promise.all([models?.dispose(), agents?.dispose(), mcp?.dispose(), idleWake?.dispose(), wake.dispose(), background.dispose()]); contexts.dispose(); protocols.clear(); wrappers.clear(); delegates.clear(); rejectedTransports.clear(); await Promise.allSettled([...cleanups.values()]); try { await startup.dispose(); await tools.dispose(); await agentTools?.dispose(); await agentPermissions?.dispose(); await approvals.dispose(); await runtime.dispose() } finally { await nativeState?.dispose(); backgroundRecords.dispose(); wakeRecords.dispose(); wakeInputs.dispose() } },
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
    ...(agents ? { tool: { [AGENT_VERDICT_TOOL]: agents.verdictTool } } : {}),
    'tool.execute.before': async (...args: Parameters<typeof tools['tool.execute.before']>) => { if (mcp?.owns(args[0].sessionID)) return mcp.beforeTool(...args); if (agents?.owns(args[0].sessionID)) return agents.beforeTool(...args); if (models?.owns(args[0].sessionID)) return models.tool(args[0]); return tools['tool.execute.before'](...args) },
    'tool.execute.after': async (...args: Parameters<typeof tools['tool.execute.after']>) => { if (mcp?.owns(args[0].sessionID)) return mcp.afterTool(...args); if (agents?.owns(args[0].sessionID)) return agents.afterTool(...args); if (models?.owns(args[0].sessionID)) return models.tool(args[0]); return tools['tool.execute.after'](...args) },
    'chat.message': async (...args: Parameters<typeof message>) => { const evaluator = internal(args[0].sessionID); if (evaluator) return evaluator.message(...args); return message(...args) },
    'chat.params': async (...args: Parameters<typeof parameters>) => {
      const prompt = args[0]
      const evaluator = internal(prompt.sessionID)
      if (!evaluator) return parameters(...args)
      evaluator.parameters(prompt)
      const provider = prompt.provider, id = provider?.id ?? provider?.info?.id
      const valid = id === managed?.providerID ? typeof provider?.options.fetch === 'function' && managedWrappers.has(provider.options.fetch as typeof fetch) : id !== undefined && wrappers.get(id) === provider?.options.fetch
      if (!id || !valid || id !== prompt.model?.providerID) unavailable('HOST_PROMPT_TRANSPORT_UNAVAILABLE')
    },
    'chat.headers': async (...args: Parameters<typeof headers>) => { const evaluator = internal(args[0].sessionID); if (evaluator) { evaluator.headers(args[0]); evaluator.requestHeaders(args[0], args[1].headers); return }; return headers(...args) },
    'experimental.chat.messages.transform': async (...args: Parameters<typeof messages>) => { if (mcp?.layout(args[1].messages) || agents?.layout(args[1].messages) || models?.layout(args[1].messages)) return; return messages(...args) },
    'experimental.chat.system.transform': async (prompt: Prompt, output: { system: string[] }) => { internal(prompt.sessionID)?.system(prompt, output) },
  }
}
