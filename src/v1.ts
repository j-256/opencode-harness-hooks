import { server } from './hosts/v1-server.js'
import { legacyV1 } from './hosts/v1-context.js'
import { HostHookError } from './host-errors.js'

export { composeV1Provider } from './hosts/v1-provider.js'

async function setup(context: unknown): Promise<void> {
  // The V1 server entrypoint owns execution while its experimental catalog setup stays passive
  if (!legacyV1(context)) throw new HostHookError('HOST_CONTEXT_UNSUPPORTED', 'unsupported')
}

export default Object.freeze({ id: 'opencode-harness-hooks', server, setup })
