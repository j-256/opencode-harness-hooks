import { z } from 'zod'
import { HostHookError } from './host-errors.js'
import { snapshotCopy } from './session-snapshot.js'
import type { JsonValue } from './types.js'
import { MCP_TOOL_ERROR_TEXT, MCP_PROMPT_SUCCESS_TEXT } from './mcp-artifact.js'

const MAX_EXIT = 255
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
const START_NAME = /^SessionStart:(startup|resume|clear|compact)$/
const duration = z.number().finite().nonnegative()
const common = { hookName: z.string(), toolUseID: z.string(), hookEvent: z.enum(['SessionStart', 'UserPromptSubmit']) }
const attachment = z.union([
  z.object({ type: z.literal('hook_success'), ...common, content: z.string(), stdout: z.string(), stderr: z.string(), exitCode: z.number().int().min(0).max(MAX_EXIT), command: z.string(), durationMs: duration }).strict(),
  z.object({ type: z.literal('hook_success'), ...common, content: z.string(), stdout: z.string(), stderr: z.string(), command: z.string(), durationMs: duration }).strict(),
  z.object({ type: z.literal('hook_non_blocking_error'), ...common, stdout: z.string(), stderr: z.string(), exitCode: z.number().int().min(1).max(MAX_EXIT), command: z.string().optional(), durationMs: duration.optional() }).strict(),
  z.object({ type: z.literal('hook_cancelled'), ...common, command: z.string(), durationMs: duration, timedOut: z.literal(true), timeoutMs: z.number().finite().positive() }).strict(),
  z.object({ type: z.literal('hook_additional_context'), ...common, content: z.array(z.string()).length(1) }).strict(),
  z.object({ type: z.literal('hook_system_message'), ...common, content: z.string() }).strict(),
])
const schema = z.object({ id: z.string().regex(UUID), created: z.number().finite(), handler: z.literal('mcp_tool').optional(), body: z.object({ type: z.literal('attachment'), attachment, rendered: z.array(z.object({ content: z.string() }).strict()).length(1).optional(), renderedRole: z.literal('system').optional() }).strict() }).strict()
export interface NativeHookRecord { readonly id: string; readonly created: number; readonly handler?: 'mcp_tool'; readonly body: { readonly type: 'attachment'; readonly attachment: Readonly<Record<string, JsonValue>>; readonly rendered?: readonly { readonly content: string }[]; readonly renderedRole?: 'system' } }
function fail(): never { throw new HostHookError('SESSION_SNAPSHOT_SCHEMA_INVALID', 'unsupported') }
function freeze<T>(value: T): T { if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value) } return value }

export function nativeHookRecord(input: unknown, event: 'SessionStart' | 'UserPromptSubmit'): NativeHookRecord {
  const value = snapshotCopy(input), parsed = schema.safeParse(value)
  if (!parsed.success || Number.isNaN(new Date(parsed.data.created).getTime())) fail()
  const row = parsed.data, item = row.body.attachment
  const additional = item.type === 'hook_additional_context'
  if (item.hookEvent !== event || (additional ? item.hookName !== event || !item.toolUseID.startsWith('hook-') || !UUID.test(item.toolUseID.slice('hook-'.length)) : !UUID.test(item.toolUseID) || (event === 'SessionStart' ? !START_NAME.test(item.hookName) : item.hookName !== event))) fail()
  if (event === 'SessionStart' && item.type === 'hook_system_message') fail()
  if (row.handler === 'mcp_tool') {
    if (event !== 'UserPromptSubmit' || item.type === 'hook_cancelled') fail()
    if (item.type === 'hook_success' && ('exitCode' in item || item.content !== MCP_PROMPT_SUCCESS_TEXT || item.stderr !== '' || !item.command.includes('/'))) fail()
    if (item.type === 'hook_non_blocking_error' && (item.exitCode !== 1 || item.stderr !== (item.stdout || MCP_TOOL_ERROR_TEXT) || item.command !== undefined || item.durationMs !== undefined)) fail()
  } else {
    if (event === 'UserPromptSubmit' && item.type === 'hook_non_blocking_error' && (item.exitCode === 2 || item.command === undefined || item.durationMs === undefined)) fail()
    if (item.type === 'hook_success' && (!('exitCode' in item) || item.exitCode !== 0 && (event === 'UserPromptSubmit' || item.content !== ''))) fail()
  }
  const rendered = additional ? `<system-reminder>\n${event} hook additional context: ${item.content[0]}\n</system-reminder>` : item.type === 'hook_success' && (event === 'UserPromptSubmit' || item.content) ? `<system-reminder>\n${item.hookName} hook success: ${item.content}\n</system-reminder>` : undefined
  if (rendered === undefined ? row.body.rendered !== undefined || row.body.renderedRole !== undefined : row.body.renderedRole !== 'system' || row.body.rendered?.[0]?.content !== rendered) fail()
  return freeze(JSON.parse(JSON.stringify(value)) as NativeHookRecord)
}
