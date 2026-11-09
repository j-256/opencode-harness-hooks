import { HostHookError, ToolBridge } from './tools.js'
import type { ToolHostOptions } from './tools.js'

interface ToolEvent {
  readonly tool: string
  readonly sessionID: string
  readonly id: string
  readonly messageID: string
  readonly agent: string
  input: unknown
  readonly status?: 'completed' | 'error'
  readonly result?: unknown
  readonly error?: unknown
}
export interface V2ToolContext {
  readonly tool: { readonly hook: (name: 'execute.before' | 'execute.after', callback: (event: ToolEvent) => Promise<void>) => Promise<{ readonly dispose: () => Promise<void> | void }> }
}

export async function registerV2Hooks(context: V2ToolContext, options: ToolHostOptions) {
  const bridge = new ToolBridge('v2', options)
  const registrations = new Set<{ readonly dispose: () => Promise<void> | void }>()
  let disposing: Promise<void> | undefined
  const cleanup = async () => {
    await bridge.dispose()
    for (const registration of registrations) {
      try { await registration.dispose(); registrations.delete(registration) } catch {}
    }
    if (registrations.size) throw new HostHookError('HOST_REGISTRATION_DISPOSE_FAILED', 'failed')
  }
  const dispose = () => {
    disposing ??= cleanup().finally(() => { disposing = undefined })
    return disposing
  }
  const call = (event: ToolEvent) => ({ tool: event.tool, sessionID: event.sessionID, callID: event.id, messageID: event.messageID, agent: event.agent })
  try {
    registrations.add(await context.tool.hook('execute.before', async event => {
      const replacement = await bridge.before(call(event), event.input)
      if (replacement) event.input = replacement
    }))
    registrations.add(await context.tool.hook('execute.after', async event => bridge.after(call(event), event.input, event.status ?? 'unknown', event.status === 'error' ? event.error : event.result)))
    return { dispose, disposeSession: (sessionID: string) => bridge.disposeSession(sessionID), inspect: () => bridge.inspect() }
  } catch (error) { await dispose(); throw error }
}
