const V1_TRANSFORM_DOMAINS = Object.freeze(['agent', 'catalog', 'command', 'integration', 'reference', 'skill'] as const)
const V2_CONTEXT_DOMAINS = Object.freeze(['app', 'location', 'event', 'session', 'tool'] as const)
export type V1PromiseContext = Readonly<Record<typeof V1_TRANSFORM_DOMAINS[number] | 'options' | 'aisdk' | 'plugin', object>>

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }

export function legacyV1(context: unknown): context is V1PromiseContext {
  if (!record(context) || !record(context.options) || V2_CONTEXT_DOMAINS.some(key => key in context)) return false
  if (!V1_TRANSFORM_DOMAINS.every(key => { const domain = context[key]; return record(domain) && typeof domain.transform === 'function' && typeof domain.reload === 'function' })) return false
  return record(context.aisdk) && typeof context.aisdk.sdk === 'function' && typeof context.aisdk.language === 'function'
    && record(context.plugin) && typeof context.plugin.add === 'function' && typeof context.plugin.remove === 'function'
}
