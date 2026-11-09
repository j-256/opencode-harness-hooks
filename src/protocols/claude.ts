import { isAbsolute } from 'node:path'
import type { HookAction, InterpretedOutput, PermissionDecision } from '../effect-types.js'
import type { ExecutionResult } from '../runner.js'
import type { JsonValue, NativeEvent, Registration } from '../types.js'
import { failure, optionalBooleans, optionalStrings, record, success, text } from './shared.js'
import { parseClaudeStopOutput } from './claude-output.js'

const STOP_EVENTS = new Set(['Stop', 'SubagentStop', 'TeammateIdle'])
const CONTINUATION_EVENTS = new Set(['Stop', 'SubagentStop'])
const APPROVAL_OUTPUT_EVENTS = new Set(['PreToolUse', 'Stop'])
const DEFAULT_STOP_REASON = 'Blocked by hook'
const DEFAULT_PREVENTION_REASON = 'Stop hook prevented continuation'
const EMPTY_STOP_STDERR = 'No stderr output'
const EXIT_BLOCK_EVENTS = new Set(['PreToolUse', 'UserPromptSubmit', 'UserPromptExpansion', ...STOP_EVENTS, 'TaskCreated', 'TaskCompleted', 'ConfigChange', 'PostToolBatch', 'PreCompact', 'PreModelSwitch', 'Elicitation', 'ElicitationResult', 'WorktreeCreate'])
const TOP_BLOCK_EVENTS = new Set(['UserPromptSubmit', 'UserPromptExpansion', 'TaskCreated', 'ConfigChange', 'PreCompact', 'PostToolBatch'])
const TEXT_CONTEXT = new Set(['SessionStart', 'UserPromptSubmit', 'UserPromptExpansion', 'PostModelSwitch'])
const DISCARD_OUTPUT = new Set(['Setup', 'InstructionsLoaded', 'Notification', 'StopFailure', 'SessionEnd', 'PostCompact', 'WorktreeRemove'])
const DISCARD_UNIVERSAL = new Set([...DISCARD_OUTPUT, 'MessageDisplay', 'ConfigChange', 'PreCompact', 'Elicitation', 'ElicitationResult', 'WorktreeCreate'])
const DISCARD_CONTINUE = new Set([...DISCARD_UNIVERSAL, 'TaskCreated', 'CwdChanged', 'DirectoryAdded', 'FileChanged'])
const FAILURE_POLICY_IGNORED = new Set(['Stop', 'SubagentStop', 'TaskCompleted', 'TeammateIdle'])
const EXTENSIONS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  SessionStart: ['initialUserMessage', 'sessionTitle', 'watchPaths', 'reloadSkills'],
  UserPromptSubmit: ['sessionTitle', 'suppressOriginalPrompt'], PostToolUse: ['classifierContext'],
  PermissionDenied: ['retry'], MessageDisplay: ['displayContent'], CwdChanged: ['watchPaths'], FileChanged: ['watchPaths'],
})
const TERMINAL_SEQUENCE = /^(?:\x07|\x1b\](?:0|1|2|9|99|777);[^\x07\x1b]*(?:\x07|\x1b\\))+$/
const OUTPUT_FIELDS = new Set(['continue', 'stopReason', 'suppressOutput', 'systemMessage', 'terminalSequence', 'decision', 'reason', 'hookSpecificOutput'])
const PERMISSION_DESTINATIONS = new Set(['session', 'localSettings', 'projectSettings', 'userSettings'])
const PERMISSION_UPDATE_MODES = new Set(['default', 'auto', 'acceptEdits', 'dontAsk', 'bypassPermissions', 'plan', 'manual'])

function validPermissionUpdate(value: JsonValue): boolean {
  if (!record(value) || !PERMISSION_DESTINATIONS.has(text(value.destination))) return false
  if (['addRules', 'replaceRules', 'removeRules'].includes(text(value.type))) {
    return ['allow', 'deny', 'ask'].includes(text(value.behavior)) && Array.isArray(value.rules) && value.rules.every(rule => record(rule) && typeof rule.toolName === 'string' && optionalStrings(rule, ['ruleContent']))
  }
  if (value.type === 'setMode') return PERMISSION_UPDATE_MODES.has(text(value.mode))
  if (value.type === 'addDirectories' || value.type === 'removeDirectories') return Array.isArray(value.directories) && value.directories.every(directory => typeof directory === 'string')
  return false
}

export function failurePolicyApplies(registration: Registration): boolean {
  return registration.handler.onFailure === 'block' && ['command', 'http'].includes(registration.handler.type) &&
    registration.handler.async !== true && registration.handler.asyncRewake !== true && !FAILURE_POLICY_IGNORED.has(registration.event)
}

export function claudeFailureBlocks(registration: Registration, code: string): boolean {
  return failurePolicyApplies(registration) || registration.event === 'WorktreeCreate' || (registration.event === 'PreModelSwitch' && code === 'EXECUTION_TIMEOUT')
}

export function claudeBlock(event: NativeEvent, reason: string, failurePolicy = false): readonly HookAction[] {
  const name = event.event
  if (name === 'PermissionRequest') return failurePolicy ? [{ kind: 'permission', decision: 'deny', reason }] : []
  if (name === 'PreToolUse' || name === 'PreModelSwitch') return [{ kind: 'permission', decision: 'deny', reason }]
  if (name === 'ConfigChange' && event.data?.source === 'policy_settings') return []
  if (STOP_EVENTS.has(name)) return [{ kind: 'continue-turn', text: reason, mode: 'feedback' }]
  if (name === 'PostToolUse' || name === 'PostToolUseFailure') return [{ kind: 'feedback', text: reason }]
  if (name === 'Elicitation' || name === 'ElicitationResult') return [{ kind: 'native-extension', name: 'elicitation', value: { action: 'decline' } }]
  return EXIT_BLOCK_EVENTS.has(name) ? [{ kind: 'block-event', reason: name === 'ConfigChange' ? '' : reason }] : []
}

function valid(body: Record<string, JsonValue>, name: string): boolean {
  if (!optionalBooleans(body, ['continue', 'suppressOutput']) || !optionalStrings(body, ['stopReason', 'systemMessage', 'reason', 'terminalSequence'])) return false
  if (body.decision !== undefined && !['block', ...(APPROVAL_OUTPUT_EVENTS.has(name) ? ['approve'] : [])].includes(text(body.decision))) return false
  const hook = body.hookSpecificOutput
  if (hook === undefined) return true
  if (!record(hook) || hook.hookEventName !== name || !optionalStrings(hook, ['additionalContext', 'permissionDecisionReason', 'sessionTitle', 'initialUserMessage', 'displayContent', 'classifierContext'])) return false
  if (!optionalBooleans(hook, ['reloadSkills', 'retry', 'suppressOriginalPrompt'])) return false
  if (hook.permissionDecision !== undefined && !['allow', 'deny', 'ask', ...(name === 'PreToolUse' ? ['defer'] : [])].includes(text(hook.permissionDecision))) return false
  if (hook.updatedInput !== undefined && !record(hook.updatedInput)) return false
  if (hook.watchPaths !== undefined && (!Array.isArray(hook.watchPaths) || hook.watchPaths.some(path => typeof path !== 'string' || !isAbsolute(path)))) return false
  if (hook.decision !== undefined) {
    if (!record(hook.decision) || !['allow', 'deny'].includes(text(hook.decision.behavior)) || !optionalStrings(hook.decision, ['message']) || !optionalBooleans(hook.decision, ['interrupt'])) return false
    if (hook.decision.updatedInput !== undefined && !record(hook.decision.updatedInput)) return false
    if (hook.decision.updatedPermissions !== undefined && (!Array.isArray(hook.decision.updatedPermissions) || !hook.decision.updatedPermissions.every(validPermissionUpdate))) return false
  }
  return true
}

export function interpretClaude(registration: Registration, event: NativeEvent, result: ExecutionResult): InterpretedOutput {
  const name = event.event
  const stdout = result.stdout.trim()
  const stderr = name === 'Stop' ? result.stderr || EMPTY_STOP_STDERR : result.stderr.trim()
  const exitActions = (): readonly HookAction[] => claudeBlock(event, stderr).map(action => name === 'Stop' && action.kind === 'continue-turn' ? { ...action, channel: 'stderr' as const } : action)
  if (name === 'WorktreeCreate' && registration.handler.type === 'command') {
    if (result.exitCode !== 0 || !stdout || !isAbsolute(stdout)) return failure('WORKTREE_CREATE_FAILED', claudeBlock(event, stderr))
    return success([{ kind: 'native-extension', name: 'worktreePath', value: stdout }])
  }
  if (result.exitCode === 2 && STOP_EVENTS.has(name) && !stdout && /No such file or directory|ENOENT|Cannot find module/i.test(result.stderr)) return failure('COMMAND_FAILED')
  let body: unknown
  let invalid = false
  if (name === 'Stop') {
    const parsed = parseClaudeStopOutput(result.stdout)
    if (parsed.kind === 'async') return failure('NATIVE_ASYNC_OUTPUT_UNSUPPORTED')
    if (parsed.kind === 'invalid' && parsed.category === 'event') return failure('INVALID_OUTPUT')
    invalid = parsed.kind === 'invalid' || parsed.kind === 'unmapped-syntax'
    if (parsed.kind === 'sync') body = parsed.body
  } else if (stdout.startsWith('{') && stdout.endsWith('}')) {
    try {
      body = JSON.parse(stdout)
      invalid = !record(body) || !valid(body, name)
    } catch {
      try {
        const lines: unknown[] = stdout.split('\n').filter(line => line.trim()).map(line => JSON.parse(line))
        invalid = lines.length < 2 || lines.some(value => record(value) && Object.keys(value).some(key => OUTPUT_FIELDS.has(key)))
      } catch { invalid = true }
    }
  }
  const actions: HookAction[] = []
  if (record(body) && typeof body.terminalSequence === 'string' && TERMINAL_SEQUENCE.test(body.terminalSequence)) actions.push({ kind: 'native-extension', name: 'terminalSequence', value: body.terminalSequence })
  if (DISCARD_OUTPUT.has(name)) return success(actions)
  if (invalid) return result.exitCode === 2 ? success([...actions, ...exitActions()]) : failure('INVALID_OUTPUT', actions)
  if (!record(body)) {
    if (result.exitCode === 2) return success([...actions, ...exitActions()])
    if (result.exitCode !== 0) return failure('COMMAND_FAILED', actions)
    if (stdout && (TEXT_CONTEXT.has(name) || name === 'PreCompact')) actions.push({ kind: 'context', text: stdout, placement: name === 'PreCompact' ? 'compaction' : 'model', channel: 'stdout' })
    return success(actions)
  }
  const hook = record(body.hookSpecificOutput) ? body.hookSpecificOutput : {}
  if (!DISCARD_UNIVERSAL.has(name) && typeof body.systemMessage === 'string' && (name !== 'Stop' || body.systemMessage.length > 0)) actions.push({ kind: 'warning', text: body.systemMessage })
  if (body.continue === false && !DISCARD_CONTINUE.has(name)) {
    if (name === 'TaskCompleted') actions.push({ kind: 'native-extension', name: 'taskCompletionStop', value: { reason: text(body.stopReason) } })
    else actions.push({ kind: 'stop-session', reason: name === 'Stop' ? text(body.stopReason) || DEFAULT_PREVENTION_REASON : text(body.stopReason) })
    if (name !== 'Stop') return success(actions)
  }
  if (name === 'PreToolUse' || name === 'PreModelSwitch') {
    let decision = hook.permissionDecision as PermissionDecision | undefined
    if (decision === undefined && body.decision !== undefined) decision = body.decision === 'block' ? 'deny' : 'allow'
    if (result.exitCode === 2) decision = 'deny'
    if (decision !== undefined) actions.push({ kind: 'permission', decision, reason: result.exitCode === 2 ? text(hook.permissionDecisionReason) || text(body.reason) || stderr : text(hook.permissionDecisionReason) || text(body.reason) })
    if (name === 'PreToolUse' && decision !== 'defer' && record(hook.updatedInput)) actions.push({ kind: 'replace-input', input: structuredClone(hook.updatedInput) })
  } else if (name === 'PermissionRequest' && record(hook.decision)) {
    const decision = hook.decision
    if (result.exitCode === 0) {
      actions.push({ kind: 'permission', decision: decision.behavior as 'allow' | 'deny', reason: text(decision.message) })
      if (decision.behavior === 'allow') {
        if (record(decision.updatedInput)) actions.push({ kind: 'replace-input', input: structuredClone(decision.updatedInput) })
        if (decision.updatedPermissions !== undefined) actions.push({ kind: 'native-extension', name: 'updatedPermissions', value: structuredClone(decision.updatedPermissions) })
      } else if (decision.interrupt === true) actions.push({ kind: 'stop-session', reason: text(decision.message) })
    }
  } else if (body.decision === 'block') {
    if (CONTINUATION_EVENTS.has(name)) {
      const reason = name === 'Stop' ? text(body.reason) || DEFAULT_STOP_REASON : text(body.reason)
      if (name !== 'Stop' && !reason.trim()) return failure('MISSING_BLOCK_REASON', actions)
      actions.push({ kind: 'continue-turn', text: reason, mode: 'feedback', ...(name === 'Stop' ? { channel: 'decision' as const } : {}) })
    } else if (name === 'PostToolUse' || name === 'PostToolUseFailure') actions.push({ kind: 'feedback', text: text(body.reason) })
    else if (TOP_BLOCK_EVENTS.has(name) || name === 'Elicitation' || name === 'ElicitationResult') actions.push(...claudeBlock(event, text(body.reason)))
  }
  if (result.exitCode === 2 && name !== 'PreToolUse' && name !== 'PreModelSwitch' && body.decision !== 'block') actions.push(...exitActions())
  if (name === 'PostToolUse') {
    const output = hook.updatedToolOutput ?? (event.tool?.startsWith('mcp__') ? hook.updatedMCPToolOutput : undefined)
    if (output !== undefined) actions.push({ kind: 'replace-result', output: structuredClone(output), rejectNested: false })
  }
  if (typeof hook.additionalContext === 'string' && hook.permissionDecision !== 'defer') {
    if (CONTINUATION_EVENTS.has(name)) {
      if (name !== 'Stop' || hook.additionalContext.length > 0) actions.push({ kind: 'continue-turn', text: hook.additionalContext, mode: 'feedback', ...(name === 'Stop' ? { channel: 'additionalContext' as const } : {}) })
    } else if (['SessionStart', 'SubagentStart', 'UserPromptSubmit', 'UserPromptExpansion', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PostToolBatch', 'PostModelSwitch'].includes(name)) actions.push({ kind: 'context', text: hook.additionalContext, placement: 'model', channel: 'additionalContext' })
  }
  for (const field of EXTENSIONS[name] ?? []) if (hook[field] !== undefined) actions.push({ kind: 'native-extension', name: field, value: structuredClone(hook[field]) })
  if ((name === 'Elicitation' || name === 'ElicitationResult') && result.exitCode === 0 && hook.action !== undefined) {
    if (!['accept', 'decline', 'cancel'].includes(text(hook.action))) return failure('INVALID_OUTPUT', actions)
    actions.push({ kind: 'native-extension', name: 'elicitation', value: { action: hook.action, ...(hook.content !== undefined ? { content: hook.content } : {}) } })
  }
  if (name === 'WorktreeCreate' && registration.handler.type === 'http') {
    if (typeof hook.worktreePath !== 'string' || !isAbsolute(hook.worktreePath)) return failure('WORKTREE_CREATE_FAILED', actions)
    actions.push({ kind: 'native-extension', name: 'worktreePath', value: hook.worktreePath })
  }
  return success(actions)
}
