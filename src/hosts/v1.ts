import { HostHookError, ToolBridge } from './tools.js'
import type { HostToolEvent, ToolCall, ToolHostOptions } from './tools.js'
import type { EffectResolution } from '../effects.js'
import { v1ShellFailure } from '../tool-failure.js'

const MAX_CONTEXT_BYTES = 128 * 1024
interface PendingContext { readonly sessionID: string; readonly parts: string[]; bytes: number; finishing: boolean; replacement?: string }
function key(call: ToolCall): string { return JSON.stringify([call.sessionID, call.callID]) }

function context(effects: EffectResolution): string[] {
  if (effects.context.some(row => row.action.placement !== 'model') || effects.warnings.length || effects.extensions.length || effects.continuations.length) throw new HostHookError('HOST_EFFECT_UNAVAILABLE', 'unsupported')
  return [...effects.feedback, ...effects.context].sort((left, right) => left.configuredOrder - right.configuredOrder).map(row => row.action.text).filter(text => text.length > 0)
}

function render(output: unknown, state: PendingContext): void {
  if (!record(output)) throw new HostHookError('HOST_TOOL_RESULT_UNSUPPORTED', 'unsupported')
  const descriptor = Object.getOwnPropertyDescriptor(output, 'output')
  if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'string') throw new HostHookError('HOST_TOOL_RESULT_UNSUPPORTED', 'unsupported')
  if (!descriptor.writable) throw new HostHookError('HOST_TOOL_RESULT_IMMUTABLE', 'unsupported')
  const value = state.replacement ?? descriptor.value
  output.output = state.parts.length ? `${value}\n\n<harness-hook-context>\n${state.parts.join('\n\n')}\n</harness-hook-context>` : value
}

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function outcome(tool: string, output: unknown): 'completed' | 'error' | 'unknown' {
  try {
    if (!record(output)) return 'unknown'
    if (Array.isArray(output.content)) return output.isError === true ? 'error' : output.isError === undefined || output.isError === false ? 'completed' : 'unknown'
    if (typeof output.output !== 'string' || typeof output.title !== 'string' || !record(output.metadata)) return 'unknown'
    if (tool.replace(/^(?:functions|opencode)\./, '') === 'bash') return typeof output.metadata.exit === 'number' && Number.isInteger(output.metadata.exit) ? output.metadata.exit === 0 ? 'completed' : 'error' : 'unknown'
    return 'completed'
  } catch { return 'unknown' }
}

export function createV1Hooks(options: ToolHostOptions) {
  const pending = new Map<string, PendingContext>()
  const custom = options.applyEffects !== undefined
  const applyEffects = async (event: HostToolEvent, effects: EffectResolution): Promise<void> => {
    if (event.event !== 'PreToolUse' && (effects.stop || effects.block)) throw new HostHookError('HOST_EFFECT_UNAVAILABLE', 'unsupported')
    let replacement: string | undefined
    if (effects.resultReplacements.length) {
      const row = effects.resultReplacements[0]!
      if (effects.resultReplacements.length !== 1 || (event.event !== 'PostToolUse' && !v1ShellFailure(event)) || row.dialect !== 'codex' || typeof row.action.output !== 'string') throw new HostHookError('HOST_EFFECT_UNAVAILABLE', 'unsupported')
      replacement = row.action.output
    }
    const parts = context(effects)
    const state = pending.get(key(event))
    if (!state || event.signal.aborted) throw new HostHookError('HOST_TOOL_CANCELLED', 'cancelled')
    const bytes = state.bytes + parts.reduce((sum, part) => sum + Buffer.byteLength(part), 0) + (replacement === undefined ? 0 : Buffer.byteLength(replacement))
    if (bytes > MAX_CONTEXT_BYTES) throw new HostHookError(replacement === undefined ? 'HOST_TOOL_CONTEXT_LIMIT' : 'HOST_TOOL_REPLACEMENT_LIMIT', 'unsupported')
    state.parts.push(...parts)
    state.bytes = bytes
    if (replacement !== undefined) state.replacement = replacement
  }
  const dispatch: ToolHostOptions['dispatch'] = async event => {
    const id = key(event)
    const state = pending.get(id)
    const clear = () => { if (pending.get(id) === state) pending.delete(id) }
    try {
      const result = await options.dispatch(event)
      if (result.cancelled || event.signal.aborted) clear()
      return result
    } catch (error) {
      if (event.signal.aborted || error instanceof HostHookError && error.outcome === 'cancelled') clear()
      throw error
    }
  }
  const bridge = new ToolBridge('v1', { ...options, dispatch: custom ? options.dispatch : dispatch, applyEffects: options.applyEffects ?? applyEffects })
  return {
    'tool.execute.before': async (input: ToolCall, output: { args: unknown }) => {
      const id = key(input)
      if (!custom && pending.has(id)) throw new HostHookError('HOST_TOOL_CALL_BUSY', 'failed')
      const state: PendingContext = { sessionID: input.sessionID, parts: [], bytes: 0, finishing: false }
      if (!custom) pending.set(id, state)
      try {
        const replacement = await bridge.before(input, output.args)
        if (!replacement) return
        if (!record(output.args) || Reflect.ownKeys(output.args).some(key => !Object.getOwnPropertyDescriptor(output.args, key)?.configurable) || !Object.isExtensible(output.args)) {
          bridge.unknown(input)
          throw new HostHookError('HOST_TOOL_INPUT_IMMUTABLE', 'unsupported')
        }
        for (const key of Reflect.ownKeys(output.args)) Reflect.deleteProperty(output.args, key)
        for (const [key, value] of Object.entries(replacement)) Object.defineProperty(output.args, key, { value, writable: true, enumerable: true, configurable: true })
      } catch (error) {
        if (pending.get(id) === state) {
          pending.delete(id)
          if (error instanceof HostHookError && error.outcome === 'denied' && state.parts.length) error.message += `\n\n${state.parts.join('\n\n')}`
        }
        throw error
      }
    },
    'tool.execute.after': async (input: ToolCall & { readonly args: unknown }, output: unknown) => {
      const id = key(input)
      const state = pending.get(id)
      if (state?.finishing) return
      if (state) state.finishing = true
      const status = outcome(input.tool, output)
      try {
        await bridge.after(input, input.args, status, output)
        if (state && pending.get(id) === state && (state.parts.length || state.replacement !== undefined) && status !== 'unknown') render(output, state)
      } catch (error) {
        bridge.effectFailure(input, status === 'error' ? 'PostToolUseFailure' : 'PostToolUse', error)
      } finally { if (pending.get(id) === state) pending.delete(id) }
    },
    dispose: () => { pending.clear(); return bridge.dispose() },
    disposeSession: (sessionID: string) => {
      for (const [id, state] of pending) if (state.sessionID === sessionID) pending.delete(id)
      bridge.disposeSession(sessionID)
    },
    inspect: () => bridge.inspect(),
  }
}
