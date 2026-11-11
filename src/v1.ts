import { createHarnessHooks } from './hosts/plugin-v1.js'
import { rejectV1Activation } from './hosts/v1-rejection.js'
import { activationFailure } from './hosts/activation.js'
import { legacyV1 } from './hosts/v1-context.js'
import { HostHookError } from './host-errors.js'

async function server(...args: Parameters<typeof createHarnessHooks>): Promise<Awaited<ReturnType<typeof createHarnessHooks>>> {
  try { return await createHarnessHooks(...args) } catch (error) {
    const failure = activationFailure(error)
    if (!failure) throw error
    return rejectV1Activation(args[0], failure)
  }
}

async function setup(context: unknown): Promise<void> {
  // The V1 server entrypoint owns execution while its experimental catalog setup stays passive
  if (!legacyV1(context)) throw new HostHookError('HOST_CONTEXT_UNSUPPORTED', 'unsupported')
}

export default Object.freeze({ id: 'opencode-harness-hooks', server, setup })
