import type { InterpretedOutput, HookAction } from '../effect-types.js'
import type { ExecutionResult } from '../runner.js'
import type { JsonValue, NativeEvent, Registration } from '../types.js'
import { toolIdentity } from '../matchers.js'
import { failure, knownFields, optionalBooleans, optionalStrings, record, success, text } from './shared.js'

const UNIVERSAL = ['continue', 'stopReason', 'suppressOutput', 'systemMessage']
const ADVISORY = new Set(['PreModelRequest', 'PostModelRequest', 'SessionEnd'])
const TEXT_CONTEXT = new Set(['SessionStart', 'SubagentStart', 'UserPromptSubmit'])
const STOP_EVENTS = new Set(['Stop', 'SubagentStop'])
const BLOCK_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'SubagentStop'])
const SPECIFIC_FIELDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  PreToolUse: ['permissionDecision', 'permissionDecisionReason', 'updatedInput', 'additionalContext'],
  PermissionRequest: ['decision'], PostToolUse: ['additionalContext', 'updatedMCPToolOutput'],
  SessionStart: ['additionalContext'], SubagentStart: ['additionalContext'], UserPromptSubmit: ['additionalContext'],
})
const WIRE_EVENT_NAMES = new Set(['PreToolUse', 'PermissionRequest', 'PostToolUse', 'PreCompact', 'PostCompact', 'SessionStart', 'UserPromptSubmit', 'SubagentStart', 'SubagentStop', 'Stop', 'Interrupt'])
const SERDE_RECURSION_LIMIT = 128

function unicodeScalarString(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++index)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false
    } else if (code >= 0xdc00 && code <= 0xdfff) return false
  }
  return true
}

function nativeJson(value: JsonValue, depth = 0): boolean {
  if (typeof value === 'string') return unicodeScalarString(value)
  if (typeof value === 'number') return Number.isFinite(value)
  if (value === null || typeof value !== 'object') return true
  if (depth >= SERDE_RECURSION_LIMIT - 1) return false
  return Object.entries(value).every(([key, nested]) => unicodeScalarString(key) && nativeJson(nested, depth + 1))
}

function blocked(event: string, reason: string, rejectNested = true): readonly HookAction[] {
  if (event === 'PreToolUse' || event === 'PermissionRequest') return [{ kind: 'permission', decision: 'deny', reason }]
  if (STOP_EVENTS.has(event)) return [{ kind: 'continue-turn', text: reason, mode: 'user' }]
  if (event === 'PostToolUse') return [{ kind: 'replace-result', output: reason, rejectNested }]
  return [{ kind: 'block-event', reason }]
}

function validate(name: string, body: Record<string, JsonValue>): boolean {
  const top = name === 'Interrupt' ? ['systemMessage'] : [...UNIVERSAL, ...(BLOCK_EVENTS.has(name) ? ['decision', 'reason'] : []), ...(SPECIFIC_FIELDS[name] ? ['hookSpecificOutput'] : [])]
  if (!knownFields(body, top) || !optionalBooleans(body, ['continue', 'suppressOutput']) || !optionalStrings(body, ['stopReason', 'systemMessage', 'reason'], true)) return false
  if (body.decision !== undefined && body.decision !== null && !['block', ...(name === 'PreToolUse' ? ['approve'] : [])].includes(text(body.decision))) return false
  const hook = body.hookSpecificOutput
  if (hook === undefined || hook === null) return true
  if (!record(hook) || !knownFields(hook, ['hookEventName', ...(SPECIFIC_FIELDS[name] ?? [])]) || !WIRE_EVENT_NAMES.has(text(hook.hookEventName))) return false
  if (!optionalStrings(hook, ['additionalContext', 'permissionDecisionReason'], true)) return false
  if (hook.permissionDecision !== undefined && hook.permissionDecision !== null && !['allow', 'deny', 'ask'].includes(text(hook.permissionDecision))) return false
  if (hook.decision !== undefined && hook.decision !== null) {
    const decision = hook.decision
    if (!record(decision) || !knownFields(decision, ['behavior', 'message', 'updatedInput', 'updatedPermissions', 'interrupt']) || !['allow', 'deny'].includes(text(decision.behavior)) || !optionalStrings(decision, ['message'], true) || !optionalBooleans(decision, ['interrupt'])) return false
  }
  return true
}

export function interpretCodex(registration: Registration, event: NativeEvent, result: ExecutionResult, controls = true): InterpretedOutput {
  const name = event.event
  if (result.exitCode !== 0) {
    if (controls && result.exitCode === 2 && !ADVISORY.has(name) && (BLOCK_EVENTS.has(name) || name === 'PermissionRequest')) {
      const reason = result.stderr.trim()
      return reason ? success(blocked(name, reason)) : failure('MISSING_BLOCK_REASON')
    }
    return failure('COMMAND_FAILED')
  }
  if (ADVISORY.has(name)) return success()
  const stdout = result.stdout.trim()
  if (!stdout) return success()
  let body: unknown
  try { body = JSON.parse(stdout) } catch {}
  if (!record(body)) {
    if (/^[{[]/.test(stdout) || (controls && STOP_EVENTS.has(name))) return failure('INVALID_OUTPUT')
    return success(TEXT_CONTEXT.has(name) ? [{ kind: 'context', text: stdout, placement: 'model' }] : [])
  }
  if (!nativeJson(body) || !validate(name, body)) return failure('INVALID_OUTPUT')
  const actions: HookAction[] = []
  if (typeof body.systemMessage === 'string') actions.push({ kind: 'warning', text: body.systemMessage })
  const hook = record(body.hookSpecificOutput) ? body.hookSpecificOutput : {}
  if (!controls) {
    if (typeof hook.additionalContext === 'string') actions.push({ kind: 'context', text: hook.additionalContext, placement: 'model' })
    return success(actions)
  }
  const permission = hook.permissionDecision
  const replacement = hook.updatedInput
  const legacy = body.decision
  const hasSpecific = permission != null || hook.permissionDecisionReason != null || replacement != null
  if (name === 'PreToolUse' || name === 'PermissionRequest') {
    if (body.continue === false || body.stopReason != null || body.suppressOutput === true) return failure('NATIVE_UNSUPPORTED_OUTPUT', actions)
  }
  if (name === 'PreToolUse') {
    const reason = text(hasSpecific ? hook.permissionDecisionReason : body.reason).trim()
    const denied = hasSpecific ? permission === 'deny' : legacy === 'block'
    const identity = toolIdentity(registration.dialect, event.tool ?? '', event.host)
    const badReplacement = replacement != null && (!record(replacement) || permission !== 'allow' || (['Bash', 'apply_patch'].includes(identity) && typeof replacement.command !== 'string'))
    const unsupported = badReplacement || permission === 'ask' || (permission === 'allow' && replacement == null) || (denied && !reason) ||
      (!hasSpecific && (legacy === 'approve' || (legacy == null && body.reason != null))) || (permission == null && hook.permissionDecisionReason != null)
    if (unsupported) return failure('NATIVE_UNSUPPORTED_OUTPUT', actions)
    if (denied) actions.push(...blocked(name, reason))
    if (record(replacement)) actions.push({ kind: 'replace-input', input: structuredClone(replacement) })
  } else if (name === 'PermissionRequest') {
    const decision = record(hook.decision) ? hook.decision : {}
    if (decision.updatedInput != null || decision.updatedPermissions != null || decision.interrupt === true) return failure('NATIVE_UNSUPPORTED_OUTPUT', actions)
    if (decision.behavior === 'allow' || decision.behavior === 'deny') actions.push({ kind: 'permission', decision: decision.behavior, reason: decision.behavior === 'deny' ? text(decision.message).trim() || 'PermissionRequest hook denied approval' : '' })
  } else if (name === 'PostToolUse') {
    if (body.suppressOutput === true || hook.updatedMCPToolOutput != null) return failure('NATIVE_UNSUPPORTED_OUTPUT', actions)
    if (body.continue === false) actions.push(...blocked(name, text(body.stopReason) || 'PostToolUse hook stopped execution', false))
    else if (legacy === 'block') {
      if (!text(body.reason).trim()) return failure('MISSING_BLOCK_REASON', actions)
      actions.push(...blocked(name, text(body.reason)))
    } else if (body.reason != null) return failure('INVALID_OUTPUT', actions)
  } else if (body.continue === false && name !== 'SubagentStart' && name !== 'Interrupt') {
    actions.push({ kind: 'stop-session', reason: text(body.stopReason) })
  } else if (legacy === 'block') {
    if (!text(body.reason).trim()) return failure('MISSING_BLOCK_REASON', actions)
    actions.push(...blocked(name, text(body.reason)))
  }
  if (typeof hook.additionalContext === 'string') actions.push({ kind: 'context', text: hook.additionalContext, placement: 'model' })
  return success(actions)
}
