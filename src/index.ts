import v1 from './v1.js'
import v2 from './v2.js'
import { legacyV1 } from './hosts/v1-context.js'
import type { V1PromiseContext } from './hosts/v1-context.js'
import type { V2Context } from './hosts/plugin-v2.js'

function setup(context: V2Context): ReturnType<typeof v2.setup>
function setup(context: V1PromiseContext): Promise<void>
async function setup(context: unknown): Promise<Awaited<ReturnType<typeof v2.setup>> | void> {
  if (legacyV1(context)) return v1.setup(context)
  return v2.setup(context as V2Context)
}

export default Object.freeze({ id: 'opencode-harness-hooks', server: v1.server, setup })
