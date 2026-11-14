import type { HookAction, InterpretedOutput } from '../effect-types.js'
import type { ExecutionResult } from '../runner.js'
import type { Registration } from '../types.js'
import { record } from './shared.js'
import { normalizeClaudeBackgroundResponse, parseClaudeBackgroundObject } from './claude-background-output.js'

export function interpretClaudeBackground(registration: Registration, result: ExecutionResult): InterpretedOutput {
  if (registration.handler.asyncRewake === true) {
    return { status: result.exitCode === 0 ? 'success' : 'failed', code: result.exitCode === 0 ? 'OK' : 'COMMAND_FAILED', actions: result.exitCode === 2 ? [{ kind: 'native-extension', name: 'asyncRewake', value: result.stderr.trim() ? result.stderr : result.stdout }] : [] }
  }
  const raw = parseClaudeBackgroundObject(result.stdout)
  const body = normalizeClaudeBackgroundResponse(raw)
  const actions: HookAction[] = []
  const invalidFields: string[] = []
  if (raw) {
    for (const field of ['continue', 'suppressOutput']) if (Object.hasOwn(raw, field) && typeof raw[field] !== 'boolean') invalidFields.push(field)
    if (Object.hasOwn(raw, 'stopReason') && typeof raw.stopReason !== 'string') invalidFields.push('stopReason')
    if (Object.hasOwn(raw, 'systemMessage') && typeof raw.systemMessage !== 'string') invalidFields.push('systemMessage')
    if (Object.hasOwn(raw, 'hookSpecificOutput') && record(raw.hookSpecificOutput)) {
      if (Object.hasOwn(raw.hookSpecificOutput, 'additionalContext') && typeof raw.hookSpecificOutput.additionalContext !== 'string') invalidFields.push('hookSpecificOutput.additionalContext')
    } else if (Object.hasOwn(raw, 'hookSpecificOutput')) invalidFields.push('hookSpecificOutput')
  }
  if (typeof body?.systemMessage === 'string' && body.systemMessage) actions.push({ kind: 'context', text: body.systemMessage, placement: 'model', channel: 'systemMessage' })
  const specific = record(body?.hookSpecificOutput) ? body.hookSpecificOutput : undefined
  if (typeof specific?.additionalContext === 'string' && specific.additionalContext) actions.push({ kind: 'context', text: specific.additionalContext, placement: 'model', channel: 'additionalContext' })
  return {
    status: result.exitCode === 0 ? 'success' : 'failed', code: result.exitCode === 0 ? 'OK' : 'COMMAND_FAILED', actions,
    ...(invalidFields.length ? { invalidFields } : {}),
  }
}
