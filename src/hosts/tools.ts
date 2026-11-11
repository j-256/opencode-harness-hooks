import { HostHookError } from '../host-errors.js'
import type { ToolCall, HostToolEvent, HostToolDiagnostic, ToolHostOptions } from '../tool-types.js'
export { HostHookError } from '../host-errors.js'
export type { ToolCall, HostToolEvent, HostToolDiagnostic, ToolHostOptions } from '../tool-types.js'
import { resolveEffects } from '../effects.js'
import type { EffectResolution } from '../effects.js'
import type { JsonValue } from '../types.js'
import { runService } from '../service-execution.js'
import { hostToolInput } from '../tool-schema.js'
import type { HostVersion } from '../contracts.js'

const MAX_CALLS = 1024
const HISTORY_LIMIT = 128
const INPUT_BYTES = 8 * 1024 * 1024

interface State {
  readonly call: ToolCall
  readonly original: Readonly<Record<string, JsonValue>>
  readonly controller: AbortController
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function inputCopy(value: unknown): Record<string, JsonValue> {
  try {
    if (!record(value)) throw new Error()
    const text = JSON.stringify(value, (_key, item: unknown) => {
      if ((typeof item === 'number' && !Number.isFinite(item)) || ['function', 'bigint', 'symbol'].includes(typeof item)) throw new Error()
      return item
    })
    if (Buffer.byteLength(text) > INPUT_BYTES) throw new Error()
    const copy: unknown = JSON.parse(text)
    if (!record(copy)) throw new Error()
    return copy as Record<string, JsonValue>
  } catch { throw new HostHookError('HOST_TOOL_INPUT_INVALID', 'unsupported') }
}
function key(call: ToolCall): string { return JSON.stringify([call.sessionID, call.callID]) }

export function hostInput(tool: string, input: Readonly<Record<string, JsonValue>>, host: HostVersion = 'v1'): Record<string, JsonValue> {
  try { return hostToolInput(host, tool, input) } catch { throw new HostHookError('HOST_TOOL_INPUT_AMBIGUOUS', 'unsupported') }
}

export class ToolBridge {
  private readonly calls = new Map<string, State>()
  private readonly active = new Set<State>()
  private readonly history: HostToolDiagnostic[] = []
  private readonly options: ToolHostOptions
  private disposed = false
  private observerFailures = 0

  constructor(private readonly host: HostVersion, options: ToolHostOptions) { this.options = { ...options } }

  async before(call: ToolCall, args: unknown): Promise<Readonly<Record<string, JsonValue>> | undefined> {
    if (this.disposed) throw new HostHookError('HOST_TOOL_CANCELLED', 'cancelled')
    if (this.calls.has(key(call))) throw new HostHookError('HOST_TOOL_CALL_BUSY', 'failed')
    if (this.calls.size >= MAX_CALLS) throw new HostHookError('HOST_TOOL_CALL_LIMIT', 'failed')
    const state: State = { call: { ...call }, original: inputCopy(args), controller: new AbortController() }
    this.calls.set(key(call), state)
    this.active.add(state)
    const event: HostToolEvent = { ...state.call, host: this.host, event: 'PreToolUse', toolInput: structuredClone(state.original), effectiveInput: structuredClone(state.original), signal: state.controller.signal }
    try {
      const dispatch = await runService(null, event.signal, () => this.options.dispatch(event))
      if (event.signal.aborted || this.disposed) throw new HostHookError('HOST_TOOL_CANCELLED', 'cancelled')
      const unsupported = dispatch.entries.find(entry => entry.result.status === 'unsupported')
      if (unsupported) throw new HostHookError(unsupported.result.code, 'unsupported')
      const effects = resolveEffects(dispatch)
      const replacement = effects.input ? hostInput(call.tool, effects.input.action.input, this.host) : undefined
      const effectiveEvent: HostToolEvent = replacement ? { ...event, effectiveInput: structuredClone(replacement) } : event
      if (effects.cancelled) throw new HostHookError('HOST_TOOL_CANCELLED', 'cancelled')
      await this.apply(effectiveEvent, effects)
      if (effects.control === 'deny' || effects.control === 'block') throw new HostHookError('HOOK_TOOL_DENIED', 'denied', effects.permission?.action.reason ?? effects.block?.action.reason)
      if (effects.control === 'ask') {
        if (!this.options.requestApproval) throw new HostHookError('HOST_TOOL_APPROVAL_UNAVAILABLE', 'unsupported')
        const approved = await runService(null, event.signal, () => this.options.requestApproval!(effectiveEvent, effects.permission!.action.reason))
        if (!approved) throw new HostHookError('HOOK_TOOL_DENIED', 'denied')
      } else if (effects.control === 'allow') {
        if (!this.options.preapprove) throw new HostHookError('HOST_TOOL_PREAPPROVAL_UNAVAILABLE', 'unsupported')
        await runService(null, event.signal, () => this.options.preapprove!(effectiveEvent))
      } else if (effects.control === 'defer') {
        if (!this.options.deferTool) throw new HostHookError('HOST_TOOL_DEFER_UNAVAILABLE', 'unsupported')
        await runService(null, event.signal, () => this.options.deferTool!(event, effects.permission!.action.reason))
        throw new HostHookError('HOST_TOOL_DEFERRED', 'deferred')
      } else if (effects.control === 'stop') {
        if (!this.options.stopTurn) throw new HostHookError('HOST_TURN_STOP_UNAVAILABLE', 'unsupported')
        await runService(null, event.signal, () => this.options.stopTurn!(event, effects.stop!.action.reason))
        throw new HostHookError('HOST_TURN_STOPPED', 'stopped')
      }
      if (event.signal.aborted || this.disposed) throw new HostHookError('HOST_TOOL_CANCELLED', 'cancelled')
      return replacement
    } catch (error) {
      const cancelled = event.signal.aborted
      this.calls.delete(key(call))
      this.active.delete(state)
      state.controller.abort()
      const failure = error instanceof HostHookError ? error : new HostHookError(cancelled ? 'HOST_TOOL_CANCELLED' : 'HOST_TOOL_DISPATCH_FAILED', cancelled ? 'cancelled' : 'failed')
      if (failure.outcome === 'unsupported' || failure.outcome === 'failed' || failure.outcome === 'cancelled') this.report(event, failure.code, failure.outcome)
      throw failure
    }
  }

  async after(call: ToolCall, args: unknown, outcome: 'completed' | 'error' | 'unknown', result: unknown): Promise<void> {
    const state = this.calls.get(key(call))
    this.calls.delete(key(call))
    if (!state || this.disposed) return
    const identity = { ...state.call, event: outcome === 'error' ? 'PostToolUseFailure' as const : 'PostToolUse' as const }
    try {
      if (outcome === 'unknown') { this.report(identity, 'HOST_TOOL_RESULT_UNKNOWN', 'unsupported'); return }
      const event: HostToolEvent = { ...identity, host: this.host, toolInput: structuredClone(state.original), effectiveInput: inputCopy(args), signal: state.controller.signal, result }
      const dispatch = await runService(null, event.signal, () => this.options.dispatch(event))
      const unsupported = dispatch.entries.find(entry => entry.result.status === 'unsupported')
      if (unsupported) { this.report(event, unsupported.result.code, 'unsupported'); return }
      await this.apply(event, resolveEffects(dispatch))
    } catch (error) {
      this.report(identity, error instanceof HostHookError ? error.code : 'HOST_TOOL_EFFECT_FAILED', error instanceof HostHookError && error.outcome === 'unsupported' ? 'unsupported' : state.controller.signal.aborted ? 'cancelled' : 'failed')
    } finally { this.active.delete(state); state.controller.abort() }
  }

  unknown(call: ToolCall): void {
    const state = this.calls.get(key(call))
    state?.controller.abort()
    if (state) this.active.delete(state)
    this.calls.delete(key(call))
  }
  disposeSession(sessionID: string): void {
    for (const state of this.active) if (state.call.sessionID === sessionID) { state.controller.abort(); this.calls.delete(key(state.call)); this.active.delete(state) }
  }
  async dispose(): Promise<void> {
    this.disposed = true
    for (const state of this.active) state.controller.abort()
    this.calls.clear()
    this.active.clear()
  }
  inspect() { return Object.freeze({ calls: this.calls.size, diagnostics: Object.freeze([...this.history]), observerFailures: this.observerFailures }) }

  private async apply(event: HostToolEvent, effects: EffectResolution): Promise<void> {
    if (effects.unresolved.length) throw new HostHookError(effects.unresolved[0]!.code, 'unsupported')
    const other = effects.context.length || effects.feedback.length || effects.warnings.length || effects.extensions.length || effects.continuations.length || effects.resultReplacements.length || (event.event !== 'PreToolUse' && (effects.stop || effects.block))
    if (!other) return
    if (!this.options.applyEffects) throw new HostHookError('HOST_EFFECT_UNAVAILABLE', 'unsupported')
    await runService(null, event.signal, () => this.options.applyEffects!(event, effects))
  }
  private report(event: Pick<HostToolEvent, 'event' | 'sessionID' | 'callID'>, code: string, outcome: HostToolDiagnostic['outcome']): void {
    const diagnostic = Object.freeze({ code, outcome, sessionID: event.sessionID, callID: event.callID, event: event.event })
    this.history.push(diagnostic)
    if (this.history.length > HISTORY_LIMIT) this.history.shift()
    try {
      const observed = this.options.diagnostic?.(diagnostic)
      if (observed) void Promise.resolve(observed).catch(() => { this.observerFailures++ })
    } catch { this.observerFailures++ }
  }
}
