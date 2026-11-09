import { RRegex } from 'rregex'
import { basename } from 'node:path'
import type { Dialect, HostVersion } from './contracts.js'
import { toolName } from './tool-schema.js'
import type { LoadedSource, NativeEvent, Registration } from './types.js'

const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'PermissionDenied'])
const COMMON_FIELDS: Readonly<Record<string, string>> = Object.freeze({
  SessionStart: 'source', SessionEnd: 'reason', SubagentStart: 'agent_type', SubagentStop: 'agent_type',
  PreCompact: 'trigger', PostCompact: 'trigger',
})
const CLAUDE_FIELDS: Readonly<Record<string, string>> = Object.freeze({
  ...COMMON_FIELDS, Setup: 'trigger', Notification: 'notification_type', StopFailure: 'error',
  ConfigChange: 'source', DirectoryAdded: 'source', InstructionsLoaded: 'load_reason',
  UserPromptExpansion: 'command_name', Elicitation: 'mcp_server_name', ElicitationResult: 'mcp_server_name',
})
const CLAUDE_EXACT = /^[a-zA-Z0-9_\- ,|]+$/
const NARROW_EXACT = /^[a-zA-Z0-9_|]+$/

export class MatcherError extends Error {
  constructor() {
    super('MATCHER_INVALID')
    this.name = 'MatcherError'
  }
}

export function toolIdentity(_dialect: Dialect, nativeTool: string, host: HostVersion = 'v1'): string { return toolName(host, nativeTool) }

export function matchesPattern(dialect: Dialect, event: string, pattern: string | undefined, values: readonly string[]): boolean {
  if (pattern === undefined || pattern === '' || pattern === '*') return true
  const narrow = dialect === 'codex' || event === 'FileChanged' || event === 'StopFailure'
  if ((narrow ? NARROW_EXACT : CLAUDE_EXACT).test(pattern)) {
    const alternatives = narrow ? pattern.split('|') : pattern.split(/[|,]/).map(value => value.trim())
    return values.some(value => alternatives.includes(value))
  }
  try {
    if (dialect === 'claude-code') {
      const regex = new RegExp(pattern)
      return values.some(value => regex.test(value))
    }
    const regex = new RRegex(pattern)
    try { return values.some(value => regex.isMatch(value)) } finally { regex.free() }
  } catch {
    throw new MatcherError()
  }
}

function candidates(registration: Registration, event: NativeEvent): readonly string[] | undefined {
  const data = { ...event.data, ...event.dialectData?.[registration.dialect] }
  if (registration.dialect === 'claude-code') {
    if (event.event === 'PreModelSwitch' || event.event === 'PostModelSwitch') return event.matcherValue === undefined ? undefined : [event.matcherValue]
    if (event.event === 'FileChanged') {
      const path = data.file_path
      return typeof path === 'string' ? [basename(path)] : []
    }
  }
  if (TOOL_EVENTS.has(event.event)) {
    if (!event.tool) return []
    const tool = toolIdentity(registration.dialect, event.tool, event.host)
    return registration.dialect === 'codex' && tool === 'apply_patch' ? [tool, 'Edit', 'Write'] : [tool]
  }
  const field = (registration.dialect === 'claude-code' ? CLAUDE_FIELDS : COMMON_FIELDS)[event.event]
  if (field === undefined) return undefined
  const value = data[field]
  return typeof value === 'string' ? [value] : []
}

export function selectRegistrations(sources: readonly LoadedSource[], event: NativeEvent): readonly Registration[] {
  return sources.flatMap(source => source.enabled ? source.registrations.filter(registration => {
    if (registration.event !== event.event) return false
    const values = candidates(registration, event)
    return values === undefined || matchesPattern(registration.dialect, event.event, registration.matcher, values)
  }) : [])
}
