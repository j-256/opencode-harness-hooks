import { HostHookError } from '../host-errors.js'
import { resolveEffects } from '../effects.js'
import { runService } from '../service-execution.js'
import type { createRuntime, RuntimeServices } from '../runtime.js'
import type { PromptContexts, PromptProtocol, PromptLayout } from '../prompt-contexts.js'
import type { HostPromptEvent, PromptDiagnostic } from '../prompt-types.js'
import type { TranscriptHistory } from '../transcript.js'

const OPENAI_PACKAGES = new Set(['@ai-sdk/openai', '@ai-sdk/openai-compatible', '@opencode/ai/providers/openai', '@opencode/ai/providers/openai-compatible'])
const ANTHROPIC_PACKAGES = new Set(['@ai-sdk/anthropic', '@opencode/ai/providers/anthropic'])
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function unavailable(code: string): never { throw new HostHookError(code, 'unsupported') }
function protocol(value: unknown): PromptProtocol {
  if (typeof value === 'string' && OPENAI_PACKAGES.has(value)) return 'openai'
  if (typeof value === 'string' && ANTHROPIC_PACKAGES.has(value)) return 'anthropic'
  return unavailable('HOST_PROMPT_PROVIDER_UNAVAILABLE')
}
function partsText(parts: unknown): readonly string[] {
  if (!Array.isArray(parts) || !parts.length) return unavailable('HOST_PROMPT_INPUT_UNAVAILABLE')
  return parts.map((part: unknown) => {
    if (!record(part) || part.type !== 'text' || typeof part.text !== 'string' || part.synthetic === true || part.ignored === true) return unavailable('HOST_PROMPT_INPUT_UNAVAILABLE')
    return part.text
  })
}
function layout(host: 'v1' | 'v2', messages: unknown): readonly PromptLayout[] {
  if (!Array.isArray(messages)) return unavailable('HOST_PROMPT_LAYOUT_UNAVAILABLE')
  return messages.flatMap((message: unknown) => {
    if (!record(message)) return unavailable('HOST_PROMPT_LAYOUT_UNAVAILABLE')
    const info = host === 'v1' ? message.info : message
    if (!record(info)) return unavailable('HOST_PROMPT_LAYOUT_UNAVAILABLE')
    if (info.role !== 'user') return []
    if (typeof info.id !== 'string') return unavailable('HOST_PROMPT_LAYOUT_UNAVAILABLE')
    const content = host === 'v1' ? message.parts : typeof info.content === 'string' ? [{ type: 'text', text: info.content }] : info.content
    return [{ id: info.id, text: partsText(content) }]
  })
}
async function submit(runtime: Awaited<ReturnType<typeof createRuntime>>, contexts: PromptContexts, event: HostPromptEvent, text: readonly string[], services: RuntimeServices): Promise<void> {
  const dispatch = await runtime.prompt(event)
  const unsupported = dispatch.entries.find(entry => entry.result.status === 'unsupported')
  if (unsupported) throw new HostHookError(unsupported.result.code, 'unsupported')
  const effects = resolveEffects(dispatch)
  if (event.signal.aborted || effects.cancelled) throw new HostHookError('HOST_PROMPT_CANCELLED', 'cancelled')
  if (effects.block) throw new HostHookError('HOOK_PROMPT_BLOCKED', 'denied', effects.block.action.reason)
  if (effects.stop) throw new HostHookError('HOOK_PROMPT_STOPPED', 'stopped', effects.stop.action.reason)
  if (effects.permission || effects.input || effects.continuations.length || effects.resultReplacements.length || effects.unresolved.length) unavailable('HOST_PROMPT_EFFECT_UNAVAILABLE')
  if (effects.feedback.length || effects.warnings.length || effects.extensions.length) {
    if (!services.promptEffects) unavailable('HOST_PROMPT_EFFECT_UNAVAILABLE')
    await runService(null, event.signal, () => services.promptEffects!(event, effects))
  }
  if (event.signal.aborted) throw new HostHookError('HOST_PROMPT_CANCELLED', 'cancelled')
  runtime.admitPrompt(event, dispatch)
  contexts.remember(runtime.sessions.get(event.sessionID), text, effects.context)
}
function guarded<A extends unknown[], T>(runtime: Awaited<ReturnType<typeof createRuntime>>, phase: PromptDiagnostic['phase'], operation: (...args: A) => Promise<T>, identity: (...args: A) => { readonly sessionID?: string; readonly messageID?: string }) {
  return (...args: A) => runtime.hasPromptHooks ? runtime.promptOperation(phase, identity(...args), () => operation(...args)) : operation(...args)
}

function history(info: unknown, messages: unknown): TranscriptHistory {
  if (!info || typeof info !== 'object' || !('id' in info) || typeof info.id !== 'string' || !Array.isArray(messages) || ('parentID' in info && typeof info.parentID !== 'string')) throw new HostHookError('HOST_TRANSCRIPT_HISTORY_UNAVAILABLE', 'unsupported')
  return { id: info.id, messages, ...('parentID' in info ? { parentID: info.parentID as string } : {}) }
}

export { record, unavailable, protocol, partsText, layout, submit, guarded, history }
