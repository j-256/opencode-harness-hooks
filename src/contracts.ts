export type Dialect = 'claude-code' | 'codex'
export type CapabilityStatus = 'verified' | 'unsupported' | 'unresolved'

export const CONTRACT_VERSIONS = Object.freeze({
  'claude-code': '2.1.318',
  codex: '0.167.0',
  opencode: '1.19.5',
})

export const HANDLER_TYPES: readonly string[] = Object.freeze(['command', 'http', 'mcp_tool', 'prompt', 'agent'])

export const HOOK_EVENTS: Readonly<Record<Dialect, readonly string[]>> = Object.freeze({
  'claude-code': Object.freeze([
    'SessionStart', 'Setup', 'InstructionsLoaded', 'UserPromptSubmit', 'UserPromptExpansion',
    'MessageDisplay', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'PostToolUseFailure',
    'PostToolBatch', 'PermissionDenied', 'Notification', 'SubagentStart', 'SubagentStop',
    'TaskCreated', 'TaskCompleted', 'Stop', 'StopFailure', 'TeammateIdle', 'ConfigChange',
    'CwdChanged', 'DirectoryAdded', 'FileChanged', 'WorktreeCreate', 'WorktreeRemove',
    'PreCompact', 'PostCompact', 'PreModelSwitch', 'PostModelSwitch', 'SessionEnd',
    'Elicitation', 'ElicitationResult',
  ]),
  codex: Object.freeze([
    'SessionStart', 'SessionEnd', 'SubagentStart', 'PreToolUse', 'PermissionRequest',
    'PostToolUse', 'PreModelRequest', 'PostModelRequest', 'PreCompact', 'PostCompact',
    'UserPromptSubmit', 'SubagentStop', 'Stop', 'Interrupt',
  ]),
})

export interface CapabilityResult {
  readonly id: string
  readonly required: boolean
  readonly status: CapabilityStatus
  readonly evidence: string
}

export interface CompatibilityReport {
  readonly equivalent: boolean
  readonly blockers: readonly CapabilityResult[]
}

export function isHookEvent(dialect: Dialect, event: string): boolean {
  return HOOK_EVENTS[dialect]?.includes(event) ?? false
}

export function assessCompatibility(results: readonly CapabilityResult[]): CompatibilityReport {
  const required = results.filter(item => item.required)
  const blockers = required
    .filter(item => item.status !== 'verified' || item.evidence.trim().length === 0)
    .map(item => Object.freeze({ ...item }))
  return Object.freeze({
    equivalent: required.length > 0 && blockers.length === 0,
    blockers: Object.freeze(blockers),
  })
}

