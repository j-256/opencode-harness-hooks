import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EXECUTION_LIMITS } from '../src/runner.js'
import { mcpInvocation } from '../src/hosts/mcp-protocol-v1.js'
import { mcpResponse } from '../src/hosts/mcp-transport-v1.js'

const input = { model: 'tool', tools: [{ type: 'function', function: { name: 'fixture_check' } }] }
const invocation = mcpInvocation('fixture', 'check', { value: 'Owned input' })
const request = (value: unknown) => new Request('https://private.invalid/chat/completions', { method: 'POST', body: JSON.stringify(value) })

test('the private response contains only the owned call and copied arguments with no model usage', async () => {
  const response = await mcpResponse(request(input), new AbortController().signal, invocation, 'call_owned')
  const frames = (await response.text()).split('\n').filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)))
  assert.deepEqual(frames[0].choices[0].delta.tool_calls, [{ index: 0, id: 'call_owned', type: 'function', function: { name: 'fixture_check', arguments: '{"value":"Owned input"}' } }])
  assert.deepEqual(frames[1].usage, { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 })
})

test('missing, foreign or additional offered tools cannot authorize a private call', async () => {
  for (const value of [{ ...input, model: 'foreign' }, { model: 'tool', tools: [] }, { ...input, tools: [...input.tools, input.tools[0]] }, { model: 'tool', tools: [{ type: 'function', function: { name: 'bash' } }] }]) await assert.rejects(mcpResponse(request(value), new AbortController().signal, invocation, 'call_owned'), { code: 'HOST_MCP_CATALOG_UNAVAILABLE' })
})

test('cancellation closes a pending request reader and cannot publish a partial response', async () => {
  const controller = new AbortController(); let cancelled = false
  const body = new ReadableStream<Uint8Array>({ pull() {}, cancel() { cancelled = true } })
  const stream = new Request('https://private.invalid', { method: 'POST', body, duplex: 'half' } as RequestInit)
  const pending = mcpResponse(stream, controller.signal, invocation, 'call_owned')
  controller.abort()
  await assert.rejects(pending, { code: 'EXECUTION_CANCELLED' }); assert.equal(cancelled, true)
})

test('oversized request streams and synthetic outputs fail inside their byte budgets', async () => {
  const signal = new AbortController().signal
  const oversized = new Request('https://private.invalid', { method: 'POST', body: 'x'.repeat(EXECUTION_LIMITS.inputBytes + 1) })
  await assert.rejects(mcpResponse(oversized, signal, invocation, 'call_owned'), { code: 'EXECUTION_INPUT_LIMIT' })
  const large = mcpInvocation('fixture', 'check', { value: 'x'.repeat(EXECUTION_LIMITS.outputBytes) }, EXECUTION_LIMITS.outputBytes + 1024)
  await assert.rejects(mcpResponse(request(input), signal, large, 'call_owned'), { code: 'EXECUTION_OUTPUT_LIMIT' })
})
