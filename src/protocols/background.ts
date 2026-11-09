import type { HookAction, InterpretedOutput } from '../effect-types.js'
import type { ExecutionResult } from '../runner.js'
import type { Registration } from '../types.js'
import { record } from './shared.js'

function responseObject(stdout: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(stdout)
    return record(value) ? value : undefined
  } catch {}
  for (const line of stdout.split('\n')) {
    try {
      const value: unknown = JSON.parse(line)
      if (record(value)) return value
    } catch {}
  }
  return undefined
}

export function interpretClaudeBackground(registration: Registration, result: ExecutionResult): InterpretedOutput {
  if (registration.handler.asyncRewake === true) {
    return { status: result.exitCode === 0 ? 'success' : 'failed', code: result.exitCode === 0 ? 'OK' : 'COMMAND_FAILED', actions: result.exitCode === 2 ? [{ kind: 'native-extension', name: 'asyncRewake', value: result.stderr.trim() ? result.stderr : result.stdout }] : [] }
  }
  const body = responseObject(result.stdout)
  const actions: HookAction[] = []
  const invalidFields: string[] = []
  if (body) {
    for (const field of ['continue', 'suppressOutput']) if (Object.hasOwn(body, field) && typeof body[field] !== 'boolean') invalidFields.push(field)
    if (Object.hasOwn(body, 'stopReason') && typeof body.stopReason !== 'string') invalidFields.push('stopReason')
    if (Object.hasOwn(body, 'systemMessage') && typeof body.systemMessage === 'string') actions.push({ kind: 'context', text: body.systemMessage, placement: 'model', channel: 'systemMessage' })
    else if (Object.hasOwn(body, 'systemMessage')) invalidFields.push('systemMessage')
    if (Object.hasOwn(body, 'hookSpecificOutput') && record(body.hookSpecificOutput)) {
      const context = body.hookSpecificOutput.additionalContext
      if (Object.hasOwn(body.hookSpecificOutput, 'additionalContext') && typeof context === 'string') actions.push({ kind: 'context', text: context, placement: 'model', channel: 'additionalContext' })
      else if (Object.hasOwn(body.hookSpecificOutput, 'additionalContext')) invalidFields.push('hookSpecificOutput.additionalContext')
    } else if (Object.hasOwn(body, 'hookSpecificOutput')) invalidFields.push('hookSpecificOutput')
  }
  return {
    status: result.exitCode === 0 ? 'success' : 'failed', code: result.exitCode === 0 ? 'OK' : 'COMMAND_FAILED', actions,
    ...(invalidFields.length ? { invalidFields } : {}),
  }
}
