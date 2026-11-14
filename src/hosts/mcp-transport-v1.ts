import { HookServiceError, UnsupportedServiceError } from '../service-execution.js'
import { EXECUTION_LIMITS } from '../runner.js'
import type { mcpInvocation } from './mcp-protocol-v1.js'

export const MCP_PROVIDER_ID = 'opencode-harness-hooks-mcp'
export const MCP_MODEL_ID = 'tool'
export const MCP_AGENT_ID = 'opencode-harness-hooks-mcp'
export const MCP_SYSTEM = 'Execute only the requested MCP tool and retain its result'
export const MCP_RESULT_FENCE = 'HOST_MCP_RESULT_CAPTURED'
export const MCP_REQUEST_LIMIT = 1
export const MCP_MESSAGE_LIMIT = MCP_REQUEST_LIMIT + 1
export const MCP_AGENT_CONFIG = Object.freeze({ mode: 'subagent', hidden: true, steps: MCP_MESSAGE_LIMIT, permission: { '*': 'deny' }, prompt: MCP_SYSTEM })
export const mcpCallID = (operationID: string) => 'call_mcp_' + operationID.replaceAll('-', '')
function fail(code: string): never { throw new UnsupportedServiceError(code) }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }

export async function mcpResponse(request: Request, signal: AbortSignal, invocation: ReturnType<typeof mcpInvocation>, callID: string): Promise<Response> {
  if (request.method !== 'POST' || !request.body) fail('HOST_MCP_REQUEST_INVALID')
  const reader = request.body.getReader(), chunks: Uint8Array[] = []
  let bytes = 0
  const cancel = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener('abort', cancel, { once: true })
  if (signal.aborted) cancel()
  try { while (true) { const next = await reader.read(); if (signal.aborted) throw new HookServiceError('EXECUTION_CANCELLED'); if (next.done) break; bytes += next.value.byteLength; if (bytes > EXECUTION_LIMITS.inputBytes) throw new HookServiceError('EXECUTION_INPUT_LIMIT'); chunks.push(next.value) } }
  finally { signal.removeEventListener('abort', cancel); cancel() }
  let body: unknown
  try { body = JSON.parse(Buffer.concat(chunks).toString()) } catch { fail('HOST_MCP_REQUEST_INVALID') }
  if (!record(body) || body.model !== MCP_MODEL_ID || !Array.isArray(body.tools) || body.tools.length !== 1 || !record(body.tools[0]) || !record(body.tools[0].function) || body.tools[0].function.name !== invocation.hostTool) fail('HOST_MCP_CATALOG_UNAVAILABLE')
  const chunk = (delta: unknown, finish: string | null) => ({ id: 'chatcmpl_mcp_' + callID, object: 'chat.completion.chunk', created: 0, model: MCP_MODEL_ID, choices: [{ index: 0, delta, finish_reason: finish }] })
  const delta = { role: 'assistant', tool_calls: [{ index: 0, id: callID, type: 'function', function: { name: invocation.hostTool, arguments: JSON.stringify(invocation.input) } }] }
  const text = 'data: ' + JSON.stringify(chunk(delta, null)) + '\n\ndata: ' + JSON.stringify({ ...chunk({}, 'tool_calls'), usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } }) + '\n\ndata: [DONE]\n\n'
  if (Buffer.byteLength(text) > EXECUTION_LIMITS.outputBytes) throw new HookServiceError('EXECUTION_OUTPUT_LIMIT')
  if (signal.aborted) throw new HookServiceError('EXECUTION_CANCELLED')
  return new Response(text, { headers: { 'content-type': 'text/event-stream' } })
}
