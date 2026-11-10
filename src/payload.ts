import { isHookEvent } from './contracts.js'
import { toolIdentity } from './matchers.js'
import { nativeToolInput } from './tool-schema.js'
import type { JsonValue, NativeEvent, Registration } from './types.js'

const TOOL_EVENTS = new Set(['PreToolUse', 'PermissionRequest', 'PostToolUse', 'PostToolUseFailure', 'PermissionDenied'])
const MAX_SESSION_ID_BYTES = 4096
const CLAUDE_PERMISSION_EVENTS = new Set(['UserPromptSubmit', 'UserPromptExpansion', ...TOOL_EVENTS, 'PostToolBatch', 'Stop', 'SubagentStop', 'TaskCompleted', 'TeammateIdle'])
const CLAUDE_COMMON = ['prompt_id', 'scratchpad_dir', 'agent_id', 'agent_type', 'effort']
const MODEL_SWITCH_FIELDS = ['from_model', 'to_model', 'requested_model', 'source', 'context_tokens', 'prompt_cache_warm', 'cache_ttl', 'estimated_cache_write_usd', 'pricing']
const CLAUDE_FIELDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  SessionStart: ['source', 'model', 'session_title', 'seconds_since_last_response', 'context_tokens', 'prompt_cache_likely_expired', 'estimated_cache_write_usd'],
  Setup: ['trigger'], InstructionsLoaded: ['file_path', 'memory_type', 'load_reason', 'globs', 'trigger_file_path', 'parent_file_path'],
  UserPromptSubmit: ['prompt'], UserPromptExpansion: ['expansion_type', 'command_name', 'command_args', 'command_source', 'prompt'],
  MessageDisplay: ['turn_id', 'message_id', 'index', 'final', 'delta'],
  PreToolUse: ['tool_use_id'], PermissionRequest: ['permission_suggestions'],
  PostToolUse: ['tool_use_id', 'tool_response', 'duration_ms'], PostToolUseFailure: ['tool_use_id', 'error', 'is_interrupt', 'duration_ms'],
  PostToolBatch: ['tool_calls'], PermissionDenied: ['tool_use_id', 'reason'], Notification: ['message', 'title', 'notification_type'],
  SubagentStart: [], SubagentStop: ['stop_hook_active', 'agent_transcript_path', 'last_assistant_message', 'background_tasks', 'session_crons'],
  TaskCreated: ['task_id', 'task_subject', 'task_description', 'teammate_name', 'team_name'],
  TaskCompleted: ['task_id', 'task_subject', 'task_description', 'teammate_name', 'team_name'],
  Stop: ['stop_hook_active', 'last_assistant_message', 'background_tasks', 'session_crons'],
  StopFailure: ['error', 'error_details', 'last_assistant_message'], TeammateIdle: ['teammate_name', 'team_name'],
  ConfigChange: ['source', 'file_path'], CwdChanged: ['old_cwd', 'new_cwd'], DirectoryAdded: ['directory', 'source'], FileChanged: ['file_path', 'event'],
  WorktreeCreate: ['name'], WorktreeRemove: ['worktree_path'], PreCompact: ['trigger', 'custom_instructions'], PostCompact: ['trigger', 'compact_summary'],
  PreModelSwitch: MODEL_SWITCH_FIELDS, PostModelSwitch: MODEL_SWITCH_FIELDS, SessionEnd: ['reason'],
  Elicitation: ['mcp_server_name', 'message', 'mode', 'requested_schema', 'url', 'elicitation_id'],
  ElicitationResult: ['mcp_server_name', 'action', 'content', 'mode', 'elicitation_id'],
})
const CODEX_TURN = ['model', 'turn_id']
const CODEX_AGENT = ['agent_id', 'agent_type']
const CODEX_PERMISSION = [...CODEX_TURN, 'permission_mode']
const CODEX_FIELDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  SessionStart: ['model', 'permission_mode', 'source'], SessionEnd: ['reason'],
  SubagentStart: [...CODEX_PERMISSION, ...CODEX_AGENT],
  PreToolUse: [...CODEX_PERMISSION, ...CODEX_AGENT, 'tool_use_id'], PermissionRequest: [...CODEX_PERMISSION, ...CODEX_AGENT],
  PostToolUse: [...CODEX_PERMISSION, ...CODEX_AGENT, 'tool_use_id', 'tool_response'],
  PreCompact: [...CODEX_TURN, ...CODEX_AGENT, 'trigger'], PostCompact: [...CODEX_TURN, ...CODEX_AGENT, 'trigger'],
  UserPromptSubmit: [...CODEX_PERMISSION, ...CODEX_AGENT, 'prompt'],
  SubagentStop: [...CODEX_PERMISSION, ...CODEX_AGENT, 'agent_transcript_path', 'stop_hook_active', 'last_assistant_message'],
  Stop: [...CODEX_PERMISSION, 'stop_hook_active', 'last_assistant_message'], Interrupt: CODEX_PERMISSION,
  PreModelRequest: [...CODEX_TURN, ...CODEX_AGENT], PostModelRequest: [...CODEX_TURN, ...CODEX_AGENT, 'status', 'error', 'token_usage'],
})
const OPTIONAL_CODEX_AGENT_EVENTS = new Set(['PreToolUse', 'PermissionRequest', 'PostToolUse', 'PreCompact', 'PostCompact', 'UserPromptSubmit', 'PreModelRequest', 'PostModelRequest'])
const CODEX_STRING_FIELDS = new Set(['model', 'turn_id', 'permission_mode', 'tool_use_id', 'agent_id', 'agent_type', 'source', 'reason', 'trigger', 'prompt', 'status'])
const CODEX_NULLABLE_STRINGS = new Set(['transcript_path', 'agent_transcript_path', 'last_assistant_message', 'error'])
const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'dontAsk', 'bypassPermissions']

export class PayloadError extends Error {
  constructor(code: string, field?: string) {
    super(field === undefined ? code : `${code}:${field}`)
    this.name = 'PayloadError'
  }
}

function sessionIdentity(registration: Registration, event: NativeEvent): string {
  const identities = event.nativeSessionIDs
  if (identities === undefined) return event.sessionID
  if (!identities || typeof identities !== 'object' || Array.isArray(identities)) throw new PayloadError('PAYLOAD_INVALID', 'session_id')
  if (!Object.hasOwn(identities, registration.dialect)) return event.sessionID
  const identity = identities[registration.dialect]
  if (identity === undefined) return event.sessionID
  if (typeof identity !== 'string' || !identity || identity.length > MAX_SESSION_ID_BYTES || Buffer.byteLength(identity) > MAX_SESSION_ID_BYTES || identity.includes('\0')) throw new PayloadError('PAYLOAD_INVALID', 'session_id')
  return identity
}

function toolInput(registration: Registration, event: NativeEvent): JsonValue {
  if (event.toolInput === undefined || event.tool === undefined) throw new PayloadError('PAYLOAD_MISSING', 'tool_input')
  try { return nativeToolInput(event.host ?? 'v1', event.tool, event.toolInput) } catch { throw new PayloadError('PAYLOAD_TOOL_INPUT_AMBIGUOUS') }
}

export function buildPayload(registration: Registration, event: NativeEvent): Record<string, JsonValue> {
  if (registration.event !== event.event) throw new PayloadError('PAYLOAD_EVENT_MISMATCH')
  if (!isHookEvent(registration.dialect, event.event)) throw new PayloadError('PAYLOAD_EVENT_UNSUPPORTED')
  const data = { ...event.data, ...event.dialectData?.[registration.dialect] }
  const payload: Record<string, JsonValue> = { session_id: sessionIdentity(registration, event), cwd: event.cwd, hook_event_name: event.event }
  if (registration.dialect === 'claude-code' && (typeof data.transcript_path !== 'string' || !data.transcript_path)) {
    throw new PayloadError('PAYLOAD_MISSING', 'transcript_path')
  }
  payload.transcript_path = data.transcript_path ?? null
  if (registration.dialect === 'codex' && typeof payload.transcript_path !== 'string' && payload.transcript_path !== null) throw new PayloadError('PAYLOAD_INVALID', 'transcript_path')
  if (registration.dialect === 'claude-code' && CLAUDE_PERMISSION_EVENTS.has(event.event) && data.permission_mode === undefined) throw new PayloadError('PAYLOAD_MISSING', 'permission_mode')
  const fields = registration.dialect === 'claude-code'
    ? [...CLAUDE_COMMON, ...(CLAUDE_PERMISSION_EVENTS.has(event.event) ? ['permission_mode'] : []), ...(CLAUDE_FIELDS[event.event] ?? [])]
    : CODEX_FIELDS[event.event] ?? []
  for (const field of fields) {
    const value = data[field]
    const optional = registration.dialect === 'claude-code' || (OPTIONAL_CODEX_AGENT_EVENTS.has(event.event) && CODEX_AGENT.includes(field))
    if (value === undefined) {
      if (!optional) throw new PayloadError('PAYLOAD_MISSING', field)
    } else {
      if (registration.dialect === 'codex' && ((CODEX_STRING_FIELDS.has(field) && typeof value !== 'string') ||
          (CODEX_NULLABLE_STRINGS.has(field) && value !== null && typeof value !== 'string') ||
          (field === 'stop_hook_active' && typeof value !== 'boolean'))) throw new PayloadError('PAYLOAD_INVALID', field)
      if (field === 'permission_mode' && (typeof value !== 'string' || ![...PERMISSION_MODES, ...(registration.dialect === 'claude-code' ? ['auto'] : [])].includes(value))) throw new PayloadError('PAYLOAD_INVALID', field)
      payload[field] = structuredClone(value)
    }
  }
  if (TOOL_EVENTS.has(event.event)) {
    if (!event.tool) throw new PayloadError('PAYLOAD_MISSING', 'tool_name')
    payload.tool_name = toolIdentity(registration.dialect, event.tool, event.host)
    payload.tool_input = toolInput(registration, event)
  }
  return payload
}
