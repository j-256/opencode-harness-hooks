import type { V2Context } from '../plugin.js'
import { HostHookError } from './tools.js'

const SESSION_GUARDS = Object.freeze(['prompt', 'context', 'model.request', 'http.request'] as const)
const TOOL_GUARDS = Object.freeze(['execute.before', 'execute.after'] as const)

export async function rejectV2Activation(context: V2Context, failure: HostHookError): Promise<() => Promise<void>> {
  const handles = new Set<{ readonly dispose: () => Promise<void> | void }>()
  const refuse = async () => { throw failure }
  let disposing: Promise<void> | undefined
  const cleanup = async () => {
    for (const handle of handles) {
      try { await handle.dispose(); handles.delete(handle) } catch {}
    }
    if (handles.size) throw new HostHookError('HOST_REGISTRATION_DISPOSE_FAILED', 'failed')
  }
  const dispose = () => {
    disposing ??= cleanup().finally(() => { disposing = undefined })
    return disposing
  }
  console.error(JSON.stringify({ component: 'opencode-harness-hooks', host: 'v2', phase: 'load', code: failure.code, outcome: failure.outcome, message: failure.message }))
  try {
    for (const name of SESSION_GUARDS) handles.add(await context.session.hook(name, refuse))
    for (const name of TOOL_GUARDS) handles.add(await context.tool.hook(name, refuse))
    return dispose
  } catch (error) { await dispose(); throw error }
}
