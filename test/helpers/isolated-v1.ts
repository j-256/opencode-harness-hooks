import { join } from 'node:path'
import { createHarnessHooks as create, setupHarnessHooks } from '../../src/plugin.js'
import { composeV1Provider as compose } from '../../src/opencode.js'
import type { RuntimeServices } from '../../src/runtime.js'

function isolated(directory: string, services: RuntimeServices = {}): RuntimeServices {
  const environment = services.host?.environment ?? process.env
  return { ...services, host: { ...services.host, environment: { ...environment, XDG_STATE_HOME: services.host?.environment?.XDG_STATE_HOME ?? join(directory, 'fixture-state') } } }
}
export const createHarnessHooks: typeof create = (input, options, services) => create(input, options, isolated(input.directory, services))
export const composeV1Provider: typeof compose = (input, options, provider, services) => compose(input, options, provider, isolated(input.directory, services))
export { setupHarnessHooks }
