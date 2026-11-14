import { isBackground } from './background-types.js'
import { performance } from 'node:perf_hooks'
import { prepareCommand, CommandContextError } from './command-context.js'
import type { HookAction, HookEffect, NativeFailureArtifact } from './effect-types.js'
import { runHttp } from './http-handler.js'
import { runModel } from './model-handler.js'
import { McpToolError, runMcp } from './mcp-handler.js'
import { HookServiceError, runService, UnsupportedServiceError } from './service-execution.js'
import type { HostServices } from './host-services.js'
import { snapshotCommandContexts } from './host-services.js'
import { buildPayload, PayloadError } from './payload.js'
import { interpretOutput } from './protocol.js'
import { claudeBlock, claudeFailureBlocks } from './protocols/claude.js'
import { AGENT_MODEL_KIND, AGENT_MODEL_STATUS, ModelApiError, ModelOutputError, PROMPT_MODEL_KIND, PROMPT_MODEL_STATUS } from './model-artifact.js'
import { EXECUTION_LIMITS, runCommand } from './runner.js'
import { MCP_ARTIFACT_KIND, MCP_ARTIFACT_STATUS, MCP_PROMPT_SUCCESS_TEXT } from './mcp-artifact.js'
import type { McpArtifact } from './mcp-artifact.js'
import type { NativeEvent, Registration } from './types.js'

const TOOL_EVENTS = new Set(['PreToolUse', 'PermissionRequest', 'PostToolUse', 'PostToolUseFailure', 'PermissionDenied'])
const MODEL_EVENTS = new Set(['PermissionDenied', 'PostToolBatch', 'PostToolUse', 'PostToolUseFailure', 'PreToolUse', 'Stop', 'SubagentStop', 'TaskCompleted', 'TaskCreated', 'TeammateIdle', 'UserPromptExpansion', 'UserPromptSubmit'])
const MCP_START_REJECTION = "mcp_tool hooks are not available for the 'SessionStart' hook event (no MCP client context)"
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

function nativeHandlerSkip(registration: Registration, event: NativeEvent): boolean {
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

function nativeSkipReason(registration: Registration, event: NativeEvent): string | undefined {
  if (registration.dialect === 'claude-code' && registration.handler.if !== undefined && !TOOL_EVENTS.has(event.event)) return 'NATIVE_CONDITION_EVENT'
  if (nativeHandlerSkip(registration, event)) return 'NATIVE_HANDLER_SKIPPED'
  return undefined
}

export function nativeSkip(registration: Registration, event: NativeEvent): boolean { return nativeSkipReason(registration, event) !== undefined }

function nativeStartRejection(registration: Registration, event: NativeEvent, started: number): NativeFailureArtifact | undefined {
  if (registration.dialect !== 'claude-code' || event.event !== 'SessionStart' || registration.handler.if !== undefined) return undefined
  const type = registration.handler.type
  if ((type === 'prompt' || type === 'agent') && typeof registration.handler.prompt === 'string') return {
    type: 'hook_non_blocking_error', completedAt: Date.now(), command: registration.handler.prompt, durationMs: Math.round(performance.now() - started), stdout: '',
    stderr: `Failed to run: ${type}-type hooks are not supported for SessionStart events (no conversation context is available). Use a command-type hook instead.`, exitCode: 1,
  }
  const source = event.dialectData?.['claude-code']?.source ?? event.data?.source
  if (type === 'mcp_tool' && (source === 'startup' || source === 'resume')) return { type: 'hook_non_blocking_error', completedAt: Date.now(), stdout: '', stderr: MCP_START_REJECTION, exitCode: 1 }
  return undefined
}

export async function executeRegistration(registration: Registration, inputEvent: NativeEvent, services: HostServices): Promise<HandlerResult> {
  const started = performance.now()
  const event = structuredClone(inputEvent)
  const background = isBackground(registration)
  const fail = (code: string) => result(registration, 'failed', code, started, !background && registration.dialect === 'claude-code' && claudeFailureBlocks(registration, code) ? claudeBlock(event, `Hook failed: ${code}`, true) : [])
  if (registration.event !== inputEvent.event) return fail('HANDLER_EVENT_MISMATCH')
  const skipped = services.insideHookAgent && registration.dialect === 'claude-code' && (registration.handler.type === 'prompt' || registration.handler.type === 'agent') ? 'NATIVE_AGENT_MODEL_RECURSION' : nativeSkipReason(registration, inputEvent)
  if (skipped) {
    const artifact = nativeStartRejection(registration, event, started)
    if (artifact) {
      const rejected = result(registration, 'failed', 'NATIVE_HANDLER_EVENT_UNSUPPORTED', started)
      return { ...rejected, status: 'failed', nativeFailureArtifact: artifact, diagnostic: { ...rejected.diagnostic, outcome: 'failed' } }
    }
    return result(registration, 'skipped', skipped, started)
  }
  const host = snapshotCommandContexts({ ...services, environment: { ...services.environment } })
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
      const durationMs = Math.round(performance.now() - started)
      let effect = interpretOutput(registration, event, { ...execution, durationMs })
      if (registration.dialect === 'claude-code' && event.event === 'UserPromptSubmit' && effect.status === 'success') {
        const summary = MCP_PROMPT_SUCCESS_TEXT
        const actions = effect.actions.map(action => action.kind === 'context' && action.channel === 'stdout' ? { ...action, text: summary } : action)
        if (!actions.length && !execution.stdout.trim()) actions.push({ kind: 'context', placement: 'model', channel: 'stdout', text: summary })
        effect = { ...effect, actions }
      }
      const actions: readonly HookAction[] = execution.sourceToolNamespace === undefined ? effect.actions : [...effect.actions, { kind: 'native-extension', name: 'mcpSourceNamespace', value: execution.sourceToolNamespace }]
      const mcpArtifact: McpArtifact | undefined = host.captureMcpArtifacts ? { kind: MCP_ARTIFACT_KIND, status: MCP_ARTIFACT_STATUS.SUCCESS, server: String(registration.handler.server), tool: String(registration.handler.tool), stdout: execution.stdout, completedAt: Date.now(), durationMs, ...(execution.sourceToolNamespace === undefined ? {} : { sourceToolNamespace: execution.sourceToolNamespace }) } : undefined
      return { ...effect, actions, ...(mcpArtifact ? { mcpArtifact } : {}) }
    }
    if (registration.handler.type === 'prompt' || registration.handler.type === 'agent') {
      const output = await runModel(registration, event, payload, host)
      const effect = result(registration, output.status, output.code, started, output.actions)
      if (host.captureModelArtifacts && registration.handler.type === 'agent' && effect.status === 'success') return { ...effect, modelArtifact: { kind: AGENT_MODEL_KIND, status: AGENT_MODEL_STATUS.SUCCESS, completedAt: Date.now(), durationMs: effect.diagnostic.durationMs } }
      return host.captureModelArtifacts && registration.handler.type === 'prompt' && effect.status === 'success' ? { ...effect, modelArtifact: { kind: PROMPT_MODEL_KIND, status: PROMPT_MODEL_STATUS.SUCCESS, prompt: String(registration.handler.prompt), stdout: '', completedAt: Date.now(), durationMs: effect.diagnostic.durationMs } } : effect
    }
    if (registration.handler.type === 'http') {
      const execution = await runHttp(registration, payload, host)
      const effect = interpretOutput(registration, event, { ...execution, durationMs: Math.round(performance.now() - started) })
      return host.captureHttpArtifacts ? { ...effect, httpArtifact: { kind: 'http', completedAt: Date.now(), durationMs: effect.diagnostic.durationMs } } : effect
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
    const invocation = await prepareCommand(registration, event, payload, host)
    const execution = await runCommand(invocation)
    const completedAt = Date.now()
    const effect = interpretOutput(registration, event, { ...execution, durationMs: Math.round(performance.now() - started) })
    return host.captureCommandArtifacts ? { ...effect, commandArtifact: { ...execution, completedAt, timeoutMs: invocation.timeoutMs, command: [invocation.command, ...(invocation.args ?? [])].join(' ') } } : effect
  } catch (error) {
    if (error instanceof UnsupportedServiceError || (error instanceof CommandContextError && error.code.startsWith('HOST_'))) return result(registration, 'unsupported', error.code, started)
    if (error instanceof ModelOutputError && Buffer.byteLength(error.stdout) > (host.maxOutputBytes ?? EXECUTION_LIMITS.outputBytes)) return fail('EXECUTION_OUTPUT_LIMIT')
    if (error instanceof ModelApiError && Buffer.byteLength(error.stderr) > (host.maxOutputBytes ?? EXECUTION_LIMITS.outputBytes)) return fail('EXECUTION_OUTPUT_LIMIT')
    const code = error instanceof CommandContextError || error instanceof HookServiceError ? error.code : error instanceof PayloadError ? 'HANDLER_PAYLOAD_INVALID' : 'HANDLER_FAILED'
    const effect = fail(code)
    if (host.captureMcpArtifacts && registration.handler.type === 'mcp_tool' && error instanceof McpToolError && effect.status === 'failed') return { ...effect, mcpArtifact: { kind: MCP_ARTIFACT_KIND, status: MCP_ARTIFACT_STATUS.TOOL_ERROR, server: String(registration.handler.server), tool: String(registration.handler.tool), stdout: error.stdout, completedAt: Date.now(), durationMs: effect.diagnostic.durationMs } }
    const agentStatus = code === 'EXECUTION_TIMEOUT' ? AGENT_MODEL_STATUS.TIMEOUT : code === 'AGENT_TURN_LIMIT' ? AGENT_MODEL_STATUS.TURN_LIMIT : code === 'AGENT_INCOMPLETE' ? AGENT_MODEL_STATUS.INCOMPLETE : error instanceof ModelApiError ? AGENT_MODEL_STATUS.API_ERROR : undefined
    if (host.captureModelArtifacts && registration.handler.type === 'agent' && effect.status === 'failed' && agentStatus) return { ...effect, modelArtifact: { kind: AGENT_MODEL_KIND, status: agentStatus, completedAt: Date.now(), durationMs: effect.diagnostic.durationMs } }
    return host.captureModelArtifacts && registration.handler.type === 'prompt' && effect.status === 'failed' && (error instanceof ModelOutputError || error instanceof ModelApiError || code === 'EXECUTION_TIMEOUT') ? { ...effect, modelArtifact: { kind: PROMPT_MODEL_KIND, status: error instanceof ModelOutputError ? PROMPT_MODEL_STATUS.INVALID : error instanceof ModelApiError ? PROMPT_MODEL_STATUS.API_ERROR : PROMPT_MODEL_STATUS.TIMEOUT, prompt: String(registration.handler.prompt), stdout: error instanceof ModelOutputError ? error.stdout : '', ...(error instanceof ModelApiError ? { stderr: error.stderr } : {}), completedAt: Date.now(), durationMs: effect.diagnostic.durationMs } } : effect
  }
}
