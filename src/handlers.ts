import { isBackground } from './background-types.js'
import { performance } from 'node:perf_hooks'
import { prepareCommand, CommandContextError } from './command-context.js'
import type { HookAction, HookEffect } from './effect-types.js'
import { runHttp } from './http-handler.js'
import { runModel } from './model-handler.js'
import { runMcp } from './mcp-handler.js'
import { HookServiceError, runService, UnsupportedServiceError } from './service-execution.js'
import type { HostServices } from './host-services.js'
import { buildPayload, PayloadError } from './payload.js'
import { interpretOutput } from './protocol.js'
import { claudeBlock, claudeFailureBlocks } from './protocols/claude.js'
import { runCommand } from './runner.js'
import type { NativeEvent, Registration } from './types.js'

const TOOL_EVENTS = new Set(['PreToolUse', 'PermissionRequest', 'PostToolUse', 'PostToolUseFailure', 'PermissionDenied'])
const MODEL_EVENTS = new Set(['PermissionDenied', 'PostToolBatch', 'PostToolUse', 'PostToolUseFailure', 'PreToolUse', 'Stop', 'SubagentStop', 'TaskCompleted', 'TaskCreated', 'TeammateIdle', 'UserPromptExpansion', 'UserPromptSubmit'])
type InactiveStatus = 'skipped' | 'unsupported' | 'background'
export type HandlerResult = HookEffect | {
  readonly status: InactiveStatus
  readonly jobID?: string
  readonly code: string
  readonly actions: readonly HookAction[]
  readonly diagnostic: Omit<HookEffect['diagnostic'], 'outcome'> & { readonly outcome: InactiveStatus }
}

function result(registration: Registration, status: InactiveStatus | 'failed' | 'success', code: string, started: number, actions: readonly HookAction[] = []): HandlerResult {
  const diagnostic = { sourceID: registration.sourceID, ...(registration.sourceDigest ? { sourceDigest: registration.sourceDigest } : {}), registrationID: registration.id, dialect: registration.dialect, event: registration.event, code, durationMs: Math.round(performance.now() - started) }
  if (status === 'failed' || status === 'success') return { status, code, actions, diagnostic: { ...diagnostic, outcome: status } }
  return { status, code, actions, diagnostic: { ...diagnostic, outcome: status } }
}

function nativeSkip(registration: Registration, event: NativeEvent): boolean {
  const type = registration.handler.type
  if (registration.dialect === 'codex') return type === 'prompt' || type === 'agent' || (type === 'mcp_tool' && event.event === 'SessionEnd')
  if ((type === 'prompt' || type === 'agent') && !MODEL_EVENTS.has(event.event) && !(type === 'prompt' && event.event === 'PermissionRequest')) return true
  if ((event.event === 'SessionStart' || event.event === 'Setup') && type === 'http') return true
  if (type === 'mcp_tool') {
    if (event.event === 'Setup') return true
    const source = event.dialectData?.['claude-code']?.source ?? event.data?.source
    if (event.event === 'SessionStart' && (source === 'startup' || source === 'resume')) return true
  }
  return false
}

export async function executeRegistration(registration: Registration, inputEvent: NativeEvent, services: HostServices): Promise<HandlerResult> {
  const started = performance.now()
  const event = structuredClone(inputEvent)
  const background = isBackground(registration)
  const fail = (code: string) => result(registration, 'failed', code, started, !background && registration.dialect === 'claude-code' && claudeFailureBlocks(registration, code) ? claudeBlock(event, `Hook failed: ${code}`, true) : [])
  if (registration.event !== inputEvent.event) return fail('HANDLER_EVENT_MISMATCH')
  if (nativeSkip(registration, inputEvent)) return result(registration, 'skipped', 'NATIVE_HANDLER_SKIPPED', started)
  if (registration.dialect === 'claude-code' && registration.handler.if !== undefined && !TOOL_EVENTS.has(inputEvent.event)) return result(registration, 'skipped', 'NATIVE_CONDITION_EVENT', started)
  const host: HostServices = { ...services, environment: { ...services.environment }, ...(services.sourceContext ? { sourceContext: structuredClone(services.sourceContext) } : {}) }
  try {
    const payload = buildPayload(registration, event)
    if (registration.dialect === 'claude-code' && typeof registration.handler.if === 'string') {
      if (!host.evaluateCondition) return result(registration, 'unsupported', 'HOST_CONDITION_UNAVAILABLE', started)
      const matches = await runService(null, host.signal, signal => host.evaluateCondition!(String(registration.handler.if), payload, signal))
      if (matches === undefined) return result(registration, 'unsupported', 'HOST_CONDITION_UNAVAILABLE', started)
      if (!matches) return result(registration, 'skipped', 'NATIVE_CONDITION_MISMATCH', started)
    }
    if (registration.handler.type === 'mcp_tool') {
      const execution = await runMcp(registration, event, payload, host)
      const effect = interpretOutput(registration, event, { ...execution, durationMs: Math.round(performance.now() - started) })
      return execution.sourceToolNamespace === undefined ? effect : { ...effect, actions: [...effect.actions, { kind: 'native-extension', name: 'mcpSourceNamespace', value: execution.sourceToolNamespace }] }
    }
    if (registration.handler.type === 'prompt' || registration.handler.type === 'agent') {
      const output = await runModel(registration, event, payload, host)
      return result(registration, output.status, output.code, started, output.actions)
    }
    if (registration.handler.type === 'http') {
      const execution = await runHttp(registration, payload, host)
      return interpretOutput(registration, event, { ...execution, durationMs: Math.round(performance.now() - started) })
    }
    if (registration.handler.type !== 'command') return result(registration, 'unsupported', 'HOST_HANDLER_UNAVAILABLE', started)
    if (background) {
      if (!host.background) return result(registration, 'unsupported', 'HOST_BACKGROUND_UNAVAILABLE', started)
      if (registration.dialect === 'claude-code' && registration.handler.asyncRewake === true && !host.background.supportsRewake) return result(registration, 'unsupported', 'HOST_ASYNC_REWAKE_UNAVAILABLE', started)
      const submission = host.background.enqueue({ registration, event, invocation: await prepareCommand(registration, event, payload, host), ...(host.sessionSignal ? { sessionSignal: host.sessionSignal } : {}) })
      if (submission.status === 'accepted') {
        const receipt = result(registration, 'background', submission.code, started)
        return { ...receipt, status: 'background', jobID: submission.id, diagnostic: { ...receipt.diagnostic, outcome: 'background' } }
      }
      return result(registration, submission.status, submission.code, started)
    }
    const execution = await runCommand(await prepareCommand(registration, event, payload, host))
    return interpretOutput(registration, event, { ...execution, durationMs: Math.round(performance.now() - started) })
  } catch (error) {
    if (error instanceof UnsupportedServiceError || (error instanceof CommandContextError && error.code.startsWith('HOST_'))) return result(registration, 'unsupported', error.code, started)
    const code = error instanceof CommandContextError || error instanceof HookServiceError ? error.code : error instanceof PayloadError ? 'HANDLER_PAYLOAD_INVALID' : 'HANDLER_FAILED'
    return fail(code)
  }
}
