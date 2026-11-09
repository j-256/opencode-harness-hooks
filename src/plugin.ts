import { createV1Hooks } from './hosts/v1.js'
import { registerV2Hooks } from './hosts/v2.js'
import type { V2ToolContext } from './hosts/v2.js'
import { HostHookError } from './hosts/tools.js'
import { createRuntime } from './runtime.js'
import type { RuntimeServices } from './runtime.js'

interface V1Input { readonly directory: string }
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
  readonly session: { readonly hook: <K extends keyof V2SessionEvents>(name: K, callback: (event: V2SessionEvents[K]) => Promise<void>) => Promise<{ readonly dispose: () => Promise<void> | void }> }
}

export async function createHarnessHooks(input: V1Input, options: unknown, services: RuntimeServices = {}) {
  const runtime = await createRuntime('v1', input.directory, options, services)
  const tools = createV1Hooks(runtime.tools)
  return {
    ...tools,
    'chat.message': async (prompt: Prompt, output: { readonly message: UserMessage }) => { runtime.sessions.prompt(prompt.sessionID, output.message.id, prompt.model?.modelID ?? output.message.model?.modelID) },
    'chat.params': async (prompt: Prompt & { readonly message: UserMessage }) => {
      const model = prompt.message.model?.modelID ?? prompt.model?.modelID
      if (model) runtime.sessions.model(prompt.sessionID, model, prompt.message.id)
    },
    disposeSession: async (sessionID: string) => { runtime.sessions.close(sessionID); await tools.disposeSession(sessionID) },
    dispose: async () => { await Promise.all([runtime.dispose(), tools.dispose()]) },
  }
}

export async function setupHarnessHooks(context: V2Context, services: RuntimeServices = {}) {
  const runtime = await createRuntime('v2', context.location.directory, context.options, services)
  const handles = new Set<{ readonly dispose: () => Promise<void> | void }>()
  let tools: Awaited<ReturnType<typeof registerV2Hooks>> | undefined
  let disposing: Promise<void> | undefined
  const cleanup = async () => {
    await runtime.dispose()
    let toolError: unknown
    try { await tools?.dispose() } catch (error) { toolError = error }
    for (const handle of handles) {
      try { await handle.dispose(); handles.delete(handle) } catch {}
    }
    if (toolError || handles.size) throw new HostHookError('HOST_REGISTRATION_DISPOSE_FAILED', 'failed')
  }
  const dispose = () => { disposing ??= cleanup().finally(() => { disposing = undefined }); return disposing }
  try {
    handles.add(await context.session.hook('prompt', async event => { runtime.sessions.prompt(event.sessionID, event.messageID) }))
    handles.add(await context.session.hook('context', async event => { runtime.sessions.model(event.sessionID, event.model.id) }))
    tools = await registerV2Hooks(context, runtime.tools)
    return dispose
  } catch (error) { await dispose(); throw error }
}
