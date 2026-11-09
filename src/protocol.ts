import { isHookEvent } from './contracts.js'
import type { HookEffect, InterpretedOutput } from './effect-types.js'
import type { ExecutionResult } from './runner.js'
import type { NativeEvent, Registration } from './types.js'
import { claudeBlock, failurePolicyApplies, interpretClaude } from './protocols/claude.js'
import { interpretCodex } from './protocols/codex.js'
import { failure } from './protocols/shared.js'

export { buildPayload } from './payload.js'
export type { HookEffect, HookAction } from './effect-types.js'

export function interpretOutput(registration: Registration, event: NativeEvent, result: ExecutionResult): HookEffect {
  let interpreted: InterpretedOutput
  if (registration.event !== event.event || !isHookEvent(registration.dialect, event.event)) interpreted = failure('PROTOCOL_EVENT_MISMATCH')
  else if (result.status !== 'exited') interpreted = failure(`EXECUTION_${result.status.toUpperCase().replaceAll('-', '_')}`)
  else if (registration.dialect === 'claude-code' && failurePolicyApplies(registration) && result.exitCode !== 0 && result.exitCode !== 2) interpreted = failure('COMMAND_FAILED')
  else interpreted = registration.dialect === 'claude-code' ? interpretClaude(registration, event, result) : interpretCodex(registration, event, result)
  if (interpreted.status === 'failed' && registration.dialect === 'claude-code' && failurePolicyApplies(registration)) {
    interpreted = { ...interpreted, actions: [...interpreted.actions, ...claudeBlock(event, `Hook failed: ${interpreted.code}`, true)] }
  }
  return {
    ...interpreted,
    diagnostic: { sourceID: registration.sourceID, registrationID: registration.id, dialect: registration.dialect, event: event.event, code: interpreted.code, outcome: interpreted.status, durationMs: result.durationMs },
  }
}
