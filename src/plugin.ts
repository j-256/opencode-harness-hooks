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
  readonly model?: { readonly modelID: string }
}
interface UserMessage { readonly id: string; readonly model?: { readonly modelID: string } }
interface V2SessionEvents {
  readonly prompt: { readonly sessionID: string; readonly messageID: string }
  readonly context: { readonly sessionID: string; readonly model: { readonly id: string } }
}
export interface V2Context extends V2ToolContext {
  readonly location: { readonly directory: string }
  readonly options: unknown
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
  const transcripts = services.transcripts ?? new ClaudeTranscript({ host: 'v1', directory: input.directory, history: async (event, signal) => {
    if (!input.client) throw new HostHookError('HOST_TRANSCRIPT_HISTORY_UNAVAILABLE', 'unsupported')
    const [info, messages] = await Promise.all([input.client.session.get({ path: { id: event.sessionID }, signal }), input.client.session.messages({ path: { id: event.sessionID }, signal })])
    if (info.error || messages.error) throw new HostHookError('HOST_TRANSCRIPT_HISTORY_UNAVAILABLE', 'unsupported')
    return history(info.data, messages.data)
  } })
  const runtime = await createRuntime('v1', input.directory, options, { ...services, transcripts })
  const approvals = new CallApprovals({ diagnostic: runtime.tools.diagnostic })
  const reply = input.client?.postSessionIdPermissionsPermissionId?.bind(input.client)
  const tools = createV1Hooks({ ...runtime.tools, ...(!runtime.tools.preapprove && reply ? { preapprove: async (event: HostToolEvent) => approvals.remember(event, runtime.sessions.get(event.sessionID)) } : {}) })
  return {
    ...tools,
    'chat.message': async (prompt: Prompt, output: { readonly message: UserMessage }) => { runtime.sessions.prompt(prompt.sessionID, output.message.id, prompt.model?.modelID ?? output.message.model?.modelID) },
    'chat.params': async (prompt: Prompt & { readonly message: UserMessage }) => {
      const model = prompt.message.model?.modelID ?? prompt.model?.modelID
      if (model) runtime.sessions.model(prompt.sessionID, model, prompt.message.id)
    },
    event: async ({ event }: { readonly event: { readonly type: string; readonly properties?: unknown } }) => {
      if (event.type !== 'permission.asked' || !reply) return
      await approvals.replyV1(event.properties, async request => {
        const result = await reply({ path: { id: request.sessionID, permissionID: request.requestID }, body: { response: 'once' }, signal: request.signal })
        if (result.error || result.data !== true) throw new HostHookError('HOST_PERMISSION_REPLY_FAILED', 'failed')
      })
    },
    inspect: () => ({ ...tools.inspect(), permissions: approvals.inspect() }),
    disposeSession: async (sessionID: string) => { runtime.sessions.close(sessionID); await tools.disposeSession(sessionID) },
    dispose: async () => { runtime.sessions.dispose(); await tools.dispose(); await approvals.dispose(); await runtime.dispose() },
  }
}

export async function setupHarnessHooks(context: V2Context, services: RuntimeServices = {}) {
  const transcripts = services.transcripts ?? new ClaudeTranscript({ host: 'v2', directory: context.location.directory, history: async (event, signal) => {
    if (!context.session.get || !context.session.context) throw new HostHookError('HOST_TRANSCRIPT_HISTORY_UNAVAILABLE', 'unsupported')
    const [info, messages] = await Promise.all([context.session.get({ sessionID: event.sessionID }, { signal }), context.session.context({ sessionID: event.sessionID }, { signal })])
    return history(info, messages)
  } })
  const runtime = await createRuntime('v2', context.location.directory, context.options, { ...services, transcripts })
  const approvals = new CallApprovals({ diagnostic: runtime.tools.diagnostic })
  const handles = new Set<{ readonly dispose: () => Promise<void> | void }>()
  let tools: Awaited<ReturnType<typeof registerV2Hooks>> | undefined
  let disposing: Promise<void> | undefined
  const cleanup = async () => {
    runtime.sessions.dispose()
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
    handles.add(await context.session.hook('prompt', async event => { runtime.sessions.prompt(event.sessionID, event.messageID) }))
    handles.add(await context.session.hook('context', async event => { runtime.sessions.model(event.sessionID, event.model.id) }))
    if (context.permission) handles.add(await context.permission.hook('evaluate', async event => { approvals.applyV2(event) }))
    tools = await registerV2Hooks(context, { ...runtime.tools, ...(!runtime.tools.preapprove && context.permission ? { preapprove: async (event: HostToolEvent) => approvals.remember(event, runtime.sessions.get(event.sessionID)) } : {}) })
    return dispose
  } catch (error) { await dispose(); throw error }
}
