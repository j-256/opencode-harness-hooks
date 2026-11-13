import type { HookAction, InterpretedOutput } from './effect-types.js'
import type { HostServices, ModelHookRequest } from './host-services.js'
import { record } from './protocols/shared.js'
import { EXECUTION_LIMITS } from './runner.js'
import { HookServiceError, runService, UnsupportedServiceError } from './service-execution.js'
import { handlerTimeoutMs } from './timeouts.js'
import { snapshotJsonObject } from './bounded-json.js'
import { ModelOutputError } from './model-artifact.js'
import type { JsonValue, NativeEvent, Registration } from './types.js'

const AGENT_MAX_TURNS = 50
const STOP_EVENTS = new Set(['Stop', 'SubagentStop'])
const NO_DECISION_EVENTS = new Set(['PermissionRequest', 'PermissionDenied'])
const ALWAYS_FEEDBACK_EVENTS = new Set(['PostToolUseFailure', 'TaskCreated'])
const END_TURN_EVENTS = new Set(['PostToolBatch', 'UserPromptSubmit', 'UserPromptExpansion'])
const OUTPUT_WRAPPER_BYTES = Buffer.byteLength('{"value":}')

function renderPrompt(template: string, input: string): string {
  let substituted = false
  const prompt = template.replace(/\\\$|\$ARGUMENTS/g, token => {
    if (token === '\\$') return '$'
    substituted = true
    return input
  })
  return substituted ? prompt : `${prompt}\n\n${input}`
}

function blockedActions(registration: Registration, event: NativeEvent, reason: string, impossible: boolean): readonly HookAction[] {
  const name = event.event
  const continued = registration.handler.type === 'agent' || registration.handler.continueOnBlock === true
  if (NO_DECISION_EVENTS.has(name)) return []
  if (STOP_EVENTS.has(name)) return impossible ? [] : [{ kind: 'continue-turn', text: reason, mode: 'feedback' }]
  if (name === 'TaskCompleted') return [{ kind: 'native-extension', name: 'taskCompletionModelBlock', value: { reason, continueOnBlock: continued } }]
  if (ALWAYS_FEEDBACK_EVENTS.has(name)) return [{ kind: 'feedback', text: reason }]
  if (END_TURN_EVENTS.has(name)) return [{ kind: 'block-event', reason }, { kind: 'warning', text: reason }]
  if (name === 'PreToolUse') return [
    { kind: 'permission', decision: 'deny', reason },
    ...(continued ? [] : [{ kind: 'stop-session', reason }, { kind: 'warning', text: reason }] as const),
  ]
  if (continued) return name === 'TeammateIdle' ? [{ kind: 'continue-turn', text: reason, mode: 'feedback' }] : [{ kind: 'feedback', text: reason }]
  return [{ kind: 'stop-session', reason }, { kind: 'warning', text: reason }]
}

export async function runModel(registration: Registration, event: NativeEvent, payload: Readonly<Record<string, JsonValue>>, host: HostServices): Promise<InterpretedOutput> {
  const agent = registration.handler.type === 'agent'
  const service = agent ? host.runAgent : host.evaluatePrompt
  if (!service) throw new UnsupportedServiceError(agent ? 'HOST_AGENT_UNAVAILABLE' : 'HOST_PROMPT_UNAVAILABLE')
  const input = JSON.stringify(payload)
  const inputLimit = host.maxInputBytes ?? EXECUTION_LIMITS.inputBytes
  const outputLimit = host.maxOutputBytes ?? EXECUTION_LIMITS.outputBytes
  if (!Number.isSafeInteger(inputLimit) || inputLimit < 1 || !Number.isSafeInteger(outputLimit) || outputLimit < 1) throw new HookServiceError('EXECUTION_INVALID_INVOCATION')
  const prompt = renderPrompt(String(registration.handler.prompt), input)
  if (Buffer.byteLength(prompt) > inputLimit) throw new HookServiceError('EXECUTION_INPUT_LIMIT')
  const output = await runService(handlerTimeoutMs(registration, host), host.signal, async signal => {
    const request: ModelHookRequest = {
      prompt, sessionID: event.sessionID, cwd: event.cwd, signal,
      ...(typeof registration.handler.model === 'string' ? { model: registration.handler.model } : {}),
    }
    return agent ? host.runAgent!({ ...request, maxTurns: AGENT_MAX_TURNS }) : host.evaluatePrompt!(request)
  })
  const copied = snapshotJsonObject({ value: output === undefined ? null : output }, outputLimit + OUTPUT_WRAPPER_BYTES, kind => { throw kind === 'size' ? new HookServiceError('EXECUTION_OUTPUT_LIMIT') : new ModelOutputError('') })
  const response = copied.value.value
  const stdout = output === undefined ? '' : typeof response === 'string' ? response : JSON.stringify(response)
  if (Buffer.byteLength(JSON.stringify(response)) > outputLimit) throw new HookServiceError('EXECUTION_OUTPUT_LIMIT')
  if (!record(response) || typeof response.ok !== 'boolean' || (response.reason !== undefined && typeof response.reason !== 'string') || (response.ok === false && typeof response.reason !== 'string') || (!agent && response.impossible !== undefined && typeof response.impossible !== 'boolean')) throw new ModelOutputError(stdout)
  return { status: 'success', code: 'MODEL_EVALUATED', actions: response.ok ? [] : blockedActions(registration, event, String(response.reason), !agent && response.impossible === true) }
}
