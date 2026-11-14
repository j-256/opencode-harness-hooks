import { snapshotJsonObject } from '../bounded-json.js'
import { EXECUTION_LIMITS } from '../runner.js'
import { HookServiceError, UnsupportedServiceError } from '../service-execution.js'
import type { McpHookOutput } from '../host-services.js'
import type { JsonValue } from '../types.js'

const MAX_ID_BYTES = 4096
const MAX_SERVERS = 4096
const INJECTIVE_NAME = /^[A-Za-z0-9-]+$/
const TEXT_SEPARATOR = '\n\n'
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function id(value: string): boolean { return typeof value === 'string' && !!value && !value.includes('\0') && Buffer.byteLength(value) <= MAX_ID_BYTES }
function identity(value: string): boolean { return id(value) && INJECTIVE_NAME.test(value) }
const sanitize = (value: string) => value.replace(/[^A-Za-z0-9_-]/g, '_')

export function mcpInvocation(server: string, tool: string, input: unknown, maxBytes = EXECUTION_LIMITS.inputBytes, knownServers?: readonly string[]) {
  if (!id(server) || !identity(tool)) throw new UnsupportedServiceError('HOST_MCP_TOOL_IDENTITY_UNAVAILABLE')
  const hostTool = sanitize(server) + '_' + tool
  const verifiedServer = knownServers ? knownServers.length <= MAX_SERVERS && knownServers.every(id) && new Set(knownServers).size === knownServers.length && knownServers.includes(server) && knownServers.filter(name => hostTool.startsWith(sanitize(name) + '_')).length === 1 : identity(server)
  if (!verifiedServer) throw new UnsupportedServiceError('HOST_MCP_TOOL_IDENTITY_UNAVAILABLE')
  const copied = snapshotJsonObject(input, maxBytes, kind => { throw new HookServiceError(kind === 'size' ? 'EXECUTION_INPUT_LIMIT' : 'MCP_INPUT_INVALID') }).value as Readonly<Record<string, JsonValue>>
  return Object.freeze({ server, tool, hostTool, input: copied })
}

export function mcpOutput(value: unknown, maxBytes = EXECUTION_LIMITS.outputBytes): McpHookOutput {
  const copied = snapshotJsonObject(value, maxBytes, kind => { throw new HookServiceError(kind === 'size' ? 'EXECUTION_OUTPUT_LIMIT' : 'MCP_OUTPUT_INVALID') }).value
  if (!Array.isArray(copied.content) || copied.isError !== undefined && typeof copied.isError !== 'boolean' || copied.content.some(item => !record(item) || typeof item.type !== 'string' || item.type === 'text' && typeof item.text !== 'string')) throw new HookServiceError('MCP_OUTPUT_INVALID')
  if (copied.isError === true) return Object.freeze({ text: '', isError: true })
  if (copied.structuredContent !== undefined && copied.structuredContent !== null && (copied.content.length === 0 || copied.content.length === 1 && record(copied.content[0]) && copied.content[0].type === 'text' && copied.content[0].text === JSON.stringify(copied.structuredContent))) throw new UnsupportedServiceError('HOST_MCP_RAW_OUTPUT_UNAVAILABLE')
  const text = copied.content.filter(item => record(item) && item.type === 'text').map(item => (item as { text: string }).text).join(TEXT_SEPARATOR)
  if (Buffer.byteLength(text) > maxBytes) throw new HookServiceError('EXECUTION_OUTPUT_LIMIT')
  return Object.freeze({ text })
}
