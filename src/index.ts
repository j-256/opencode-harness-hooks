import { createHarnessHooks, setupHarnessHooks } from './plugin.js'

export default Object.freeze({ id: 'opencode-harness-hooks', server: createHarnessHooks, setup: setupHarnessHooks })
