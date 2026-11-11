import { createHarnessHooks, setupHarnessHooks } from './plugin.js'
import type { V2Context } from './plugin.js'
import { HostHookError } from './hosts/tools.js'
import { rejectV1Activation } from './hosts/v1-rejection.js'
import { SourceError } from './config.js'
import { rejectV2Activation } from './hosts/v2-rejection.js'

const V2_COMPLETION_CAPABILITY = 'session.response.completed'
const V1_TRANSFORM_DOMAINS = Object.freeze(['agent', 'catalog', 'command', 'integration', 'reference', 'skill'] as const)
const V2_CONTEXT_DOMAINS = Object.freeze(['app', 'location', 'event', 'session', 'tool'] as const)
type V1PromiseContext = Readonly<Record<typeof V1_TRANSFORM_DOMAINS[number] | 'options' | 'aisdk' | 'plugin', object>>

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }

function activationFailure(error: unknown): HostHookError | undefined {
  if (error instanceof HostHookError) return error
  if (error instanceof SourceError) return new HostHookError(error.code, 'unsupported', error.sourceID)
  return undefined
}

function legacyV1(context: unknown): context is V1PromiseContext {
  if (!record(context) || !record(context.options) || V2_CONTEXT_DOMAINS.some(key => key in context)) return false
  if (!V1_TRANSFORM_DOMAINS.every(key => { const domain = context[key]; return record(domain) && typeof domain.transform === 'function' && typeof domain.reload === 'function' })) return false
  return record(context.aisdk) && typeof context.aisdk.sdk === 'function' && typeof context.aisdk.language === 'function'
    && record(context.plugin) && typeof context.plugin.add === 'function' && typeof context.plugin.remove === 'function'
}

function setup(context: V2Context): ReturnType<typeof setupHarnessHooks>
function setup(context: V1PromiseContext): Promise<void>
async function setup(context: unknown): Promise<Awaited<ReturnType<typeof setupHarnessHooks>> | void> {
  // V1 also loads setup with its experimental catalog API while server owns hook execution
  if (legacyV1(context)) return
  if (!record(context) || !record(context.location) || typeof context.location.directory !== 'string' || !context.location.directory
    || !record(context.session) || typeof context.session.hook !== 'function' || !record(context.tool) || typeof context.tool.hook !== 'function') throw new HostHookError('HOST_CONTEXT_UNSUPPORTED', 'unsupported')
  const experimental = record(context.experimental) ? context.experimental : undefined
  const capabilities = experimental && record(experimental.capabilities) ? experimental.capabilities : undefined
  const stopUnavailableCapability = capabilities?.[V2_COMPLETION_CAPABILITY] === true ? 'verified-completion-adapter' : 'awaited-completion-decision'
  try { return await setupHarnessHooks(context as unknown as V2Context, { stopUnavailableCapability }) } catch (error) {
    const failure = activationFailure(error)
    if (!failure) throw error
    return rejectV2Activation(context as unknown as V2Context, failure)
  }
}

async function server(...args: Parameters<typeof createHarnessHooks>): Promise<Awaited<ReturnType<typeof createHarnessHooks>>> {
  try { return await createHarnessHooks(...args) } catch (error) {
    const failure = activationFailure(error)
    if (!failure) throw error
    return rejectV1Activation(args[0], failure)
  }
}

export default Object.freeze({ id: 'opencode-harness-hooks', server, setup })
