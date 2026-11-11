import { initialize } from './v1-server.js'
import type { V1ServerHooks } from './v1-server.js'
import { HostHookError } from '../host-errors.js'
import type { RuntimeServices } from '../runtime.js'
import type { V1Input } from './plugin-v1.js'
import { record } from './plugin-shared.js'
import { rejectV1Activation } from './v1-rejection.js'

const INSPECT = 'inspect'
const DISPOSE = 'dispose'
const DISPOSE_SESSION = 'disposeSession'

async function cleanup(...operations: readonly (() => unknown)[]): Promise<void> {
  const failures: unknown[] = []
  for (const operation of operations) { try { await operation() } catch (error) { failures.push(error) } }
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, 'HOST_PROVIDER_CLEANUP_FAILED')
}

export async function composeV1Provider<Provider extends object>(input: V1Input, options: unknown, provider: Provider, services: RuntimeServices = {}): Promise<Provider & V1ServerHooks> {
  const original = provider as Record<string, unknown>
  const auth = record(original.auth) ? original.auth : undefined
  const providerID = typeof auth?.provider === 'string' && auth.provider ? auth.provider : undefined
  const loader = typeof auth?.loader === 'function' ? auth.loader : undefined
  let wrap: ((original: typeof fetch) => typeof fetch) | undefined
  let result: { readonly hooks: V1ServerHooks; readonly rejected: boolean }
  try {
    result = providerID && loader
      ? await initialize(input, options, { ...services, promptTransport: { providerID, attach: value => { wrap = value } } })
      : { hooks: rejectV1Activation(input, new HostHookError('HOST_PROMPT_AUTH_LOADER_UNAVAILABLE', 'unsupported')), rejected: true }
  } catch (error) {
    if (typeof original.dispose === 'function') {
      try { await Reflect.apply(original.dispose, provider, []) } catch (cleanup) { throw new AggregateError([error, cleanup], 'HOST_PROVIDER_INITIALIZATION_FAILED') }
    }
    throw error
  }
  const harness = result.hooks
  const combined: Record<string, unknown> = { ...original, ...harness }
  for (const [name, operation] of Object.entries(harness)) {
    const previous = original[name]
    if (result.rejected || name === INSPECT || name === DISPOSE || name === DISPOSE_SESSION || typeof operation !== 'function' || typeof previous !== 'function') continue
    combined[name] = async (...args: unknown[]) => {
      await Reflect.apply(previous, provider, args)
      return Reflect.apply(operation, harness, args)
    }
  }
  combined.auth = wrap && loader ? { ...auth, loader: async (...args: unknown[]) => {
    const loaded: unknown = await Reflect.apply(loader, auth, args)
    if (!record(loaded) || loaded.fetch !== undefined && typeof loaded.fetch !== 'function') throw new HostHookError('HOST_PROMPT_AUTH_FETCH_UNAVAILABLE', 'unsupported')
    return { ...loaded, fetch: wrap!(typeof loaded.fetch === 'function' ? loaded.fetch as typeof fetch : globalThis.fetch) }
  } } : providerID && loader ? auth : undefined
  combined.dispose = () => cleanup(() => harness.dispose(), () => typeof original.dispose === 'function' ? Reflect.apply(original.dispose, provider, []) : undefined)
  combined.disposeSession = (...args: Parameters<typeof harness.disposeSession>) => cleanup(() => harness.disposeSession(...args), () => typeof original.disposeSession === 'function' ? Reflect.apply(original.disposeSession, provider, args) : undefined)
  return combined as Provider & V1ServerHooks
}
