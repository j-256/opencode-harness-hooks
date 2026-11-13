import assert from 'node:assert/strict'
import { test } from 'node:test'
import { modelApiFailure, ModelResponse } from '../src/hosts/model-response.js'

const sse = (rows: readonly unknown[]) => rows.map(row => 'data: ' + JSON.stringify(row) + '\r\n\r\n').join('') + 'data: [DONE]\r\n\r\n'
const raw = ' \n {"ok":"wrong"} \n'
const rows = {
  chat: [{ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: 'StructuredOutput', arguments: ' \n {"ok":' } }] } }] }, { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"wrong"} \n' } }] } }] }],
  anthropic: [{ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tool', name: 'StructuredOutput', input: {} } }, { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: raw } }],
  responses: [{ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'tool', name: 'StructuredOutput', arguments: '' } }, { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'tool', delta: raw }, { type: 'response.function_call_arguments.done', output_index: 0, item_id: 'tool', arguments: raw }],
}
for (const [family, events] of Object.entries(rows)) test(family + ' streaming capture preserves exact collector argument bytes across chunk boundaries', async () => {
  const bytes = new TextEncoder().encode(sse(events)), capture = new ModelResponse()
  const input = new Response(new ReadableStream({ start(controller) { for (let index = 0; index < bytes.length; index += 7) controller.enqueue(bytes.slice(index, index + 7)); controller.close() } }), { status: 201, headers: { 'content-type': 'text/event-stream', 'x-fixture': 'retained' } })
  const output = capture.wrap(input, new AbortController().signal)
  assert.equal(await output.text(), sse(events))
  assert.equal(output.status, 201)
  assert.equal(output.headers.get('x-fixture'), 'retained')
  assert.equal(capture.raw(), raw)
})

test('raw text is retained without exposing private model content in parse errors', async () => {
  const capture = new ModelResponse(), input = sse([{ choices: [{ index: 0, delta: { content: 'PRIVATE_MALFORMED' } }] }])
  await capture.wrap(new Response(input, { headers: { 'content-type': 'text/event-stream' } }), new AbortController().signal).text()
  assert.equal(capture.raw(), 'PRIVATE_MALFORMED')
  const invalid = new ModelResponse()
  await assert.rejects(invalid.wrap(new Response('data: PRIVATE_BROKEN\n\n', { headers: { 'content-type': 'text/event-stream' } }), new AbortController().signal).text(), error => error instanceof Error && !error.message.includes('PRIVATE_BROKEN'))
})

test('nonstreaming capture rejects foreign tools and ambiguous multiple collector verdicts', async () => {
  const capture = new ModelResponse()
  await capture.wrap(new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ function: { name: 'StructuredOutput', arguments: raw } }] } }] }), { headers: { 'content-type': 'application/json' } }), new AbortController().signal).text()
  assert.equal(capture.raw(), raw)
  for (const tools of [[{ function: { name: 'bash', arguments: 'PRIVATE' } }], [{ function: { name: 'StructuredOutput', arguments: raw } }, { function: { name: 'StructuredOutput', arguments: raw } }]]) {
    await assert.rejects(new ModelResponse().wrap(new Response(JSON.stringify({ choices: [{ message: { tool_calls: tools } }] }), { headers: { 'content-type': 'application/json' } }), new AbortController().signal).text())
  }
})

test('capture bounds response bytes, cancels its reader and cannot retain a cancelled verdict', async () => {
  let cancelled = false
  const input = new Response(new ReadableStream({ pull(controller) { controller.enqueue(new TextEncoder().encode('x'.repeat(128))) }, cancel() { cancelled = true } }), { headers: { 'content-type': 'text/event-stream' } })
  const capture = new ModelResponse(256)
  await assert.rejects(capture.wrap(input, new AbortController().signal).text(), { code: 'EXECUTION_OUTPUT_LIMIT' })
  assert.equal(cancelled, true)
  const controller = new AbortController(), pending = new ModelResponse()
  const output = pending.wrap(new Response(new ReadableStream({ pull() {} })), controller.signal)
  const read = output.text(); controller.abort()
  await assert.rejects(read, { code: 'EXECUTION_CANCELLED' })
  assert.throws(() => pending.raw(), { code: 'EXECUTION_CANCELLED' })
})

test('provider API failure evidence retains only the bounded native error summary', async () => {
  const error = await modelApiFailure(new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'OWNED_PROVIDER_ERROR' }, privateMetadata: 'UNRELATED_SECRET' }), { status: 400 }), new AbortController().signal)
  assert.equal(error.code, 'MODEL_REQUEST_FAILED')
  assert.equal(error.stderr, 'Hook evaluator API error: API Error: 400 OWNED_PROVIDER_ERROR')
  assert.equal(error.message, 'MODEL_REQUEST_FAILED')
})
