import { snapshotJsonObject } from '../bounded-json.js'
import { runService, UnsupportedServiceError } from '../service-execution.js'

const MAX_RULES = 4096
const MAX_AGENTS = 1024
const MAX_ID_BYTES = 4096
const POLICY_BYTES = 256 * 1024
const TOOL_MASK_BYTES = 64 * 1024
const MAX_TOOL_MASK = 1024
const EXCLUDED_TOOLS = Object.freeze(['task', 'question'])
const READ_PERMISSIONS = Object.freeze(['read', 'glob', 'grep', 'external_directory'])
export const AGENT_VERDICT_TOOL = 'harness_hook_verdict'
export interface V1PermissionRule { readonly permission: string; readonly pattern: string; readonly action: 'allow' | 'ask' | 'deny' }
interface PolicyClient { readonly app?: { readonly agents?: (options: { readonly query: { readonly directory: string }; readonly signal: AbortSignal }) => Promise<{ readonly data?: unknown; readonly error?: unknown }> } }
interface Options { readonly directory: string; readonly client?: PolicyClient | undefined; readonly parent: Record<string, unknown>; readonly agent?: string; readonly tools?: Readonly<Record<string, boolean>>; readonly signal: AbortSignal }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function id(value: unknown): value is string { return typeof value === 'string' && !!value && Buffer.byteLength(value) <= MAX_ID_BYTES && !value.includes('\0') }
function fail(): never { throw new UnsupportedServiceError('HOST_AGENT_PERMISSION_POLICY_UNAVAILABLE') }
function rules(value: unknown): readonly V1PermissionRule[] {
  const copied = snapshotJsonObject({ rules: value }, POLICY_BYTES, fail).value.rules
  if (!Array.isArray(copied) || copied.length > MAX_RULES || copied.some(row => !record(row) || !id(row.permission) || !id(row.pattern) || !['allow', 'ask', 'deny'].includes(String(row.action)) || Object.keys(row).some(key => !['permission', 'pattern', 'action'].includes(key)))) fail()
  return copied as unknown as readonly V1PermissionRule[]
}

export function snapshotAgentTools(value: unknown): Readonly<Record<string, boolean>> {
  const copied = snapshotJsonObject(value, TOOL_MASK_BYTES, fail).value
  if (Object.keys(copied).length > MAX_TOOL_MASK || Object.entries(copied).some(([name, enabled]) => !id(name) || typeof enabled !== 'boolean')) fail()
  return Object.freeze(copied as Record<string, boolean>)
}

export async function inheritAgentPolicy(input: Options): Promise<readonly V1PermissionRule[]> {
  const agent = input.agent ?? input.parent.agent, app = input.client?.app
  if (!id(agent) || input.agent !== undefined && input.parent.agent !== undefined && input.parent.agent !== input.agent || !app?.agents) fail()
  const response = await runService(null, input.signal, signal => app.agents!({ query: { directory: input.directory }, signal }))
  if (response.error || !Array.isArray(response.data) || response.data.length > MAX_AGENTS) fail()
  const selected = response.data.filter(row => record(row) && row.name === agent)
  if (selected.length !== 1 || !record(selected[0])) fail()
  const inherited = [...rules(selected[0].permission)]
  const tools = input.tools ? snapshotAgentTools(input.tools) : undefined
  if (tools && Object.keys(tools).length) inherited.push(...Object.entries(tools).map(([permission, enabled]) => ({ permission, pattern: '*', action: enabled ? 'allow' as const : 'deny' as const })))
  else if (input.parent.permission !== undefined) inherited.push(...rules(input.parent.permission))
  const result: V1PermissionRule[] = []
  for (const rule of inherited) {
    if (rule.action !== 'allow' || READ_PERMISSIONS.includes(rule.permission)) result.push(Object.freeze({ ...rule }))
    else {
      result.push(Object.freeze({ ...rule, action: 'ask' }))
      if (rule.permission === '*') for (const permission of READ_PERMISSIONS) result.push(Object.freeze({ ...rule, permission }))
    }
  }
  for (const permission of EXCLUDED_TOOLS) result.push(Object.freeze({ permission, pattern: '*', action: 'deny' }))
  result.push(Object.freeze({ permission: AGENT_VERDICT_TOOL, pattern: '*', action: 'allow' }))
  if (result.length > MAX_RULES) fail()
  return Object.freeze(result)
}
