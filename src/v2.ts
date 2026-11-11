import { setupHarnessHooks } from './hosts/plugin-v2.js'
import type { V2Context } from './hosts/plugin-v2.js'
import { rejectV2Activation } from './hosts/v2-rejection.js'
import { activationFailure } from './hosts/activation.js'
import { HostHookError } from './host-errors.js'

const V2_COMPLETION_CAPABILITY = 'session.response.completed'

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }

async function setup(context: V2Context): ReturnType<typeof setupHarnessHooks> {
  if (!record(context) || !record(context.location) || typeof context.location.directory !== 'string' || !context.location.directory
    || !record(context.session) || typeof context.session.hook !== 'function' || !record(context.tool) || typeof context.tool.hook !== 'function') throw new HostHookError('HOST_CONTEXT_UNSUPPORTED', 'unsupported')
  const experimental = record(context.experimental) ? context.experimental : undefined
  const capabilities = experimental && record(experimental.capabilities) ? experimental.capabilities : undefined
  const stopUnavailableCapability = capabilities?.[V2_COMPLETION_CAPABILITY] === true ? 'verified-completion-adapter' : 'awaited-completion-decision'
  try { return await setupHarnessHooks(context, { stopUnavailableCapability }) } catch (error) {
    const failure = activationFailure(error)
    if (!failure) throw error
    return rejectV2Activation(context, failure)
  }
}

export default Object.freeze({ id: 'opencode-harness-hooks', setup })
