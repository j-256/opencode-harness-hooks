import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { getEventListeners } from 'node:events'
import { readFileSync } from 'node:fs'
import type { JsonValue, NativeEvent, Registration } from '../src/types.js'

async function server(t: TestContext, handle: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
  const service = createServer(handle)
  service.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => service.once('listening', resolve))
  t.after(async () => { service.closeAllConnections(); await new Promise<void>(resolve => service.close(() => resolve())) })
  const address = service.address()
  assert.ok(address && typeof address === 'object')
  return `http://127.0.0.1:${address.port}/hook`
}

function hook(url: string, extra: Record<string, JsonValue> = {}): Registration {
  return { id: 'http:fixture', sourceID: 'http', dialect: 'claude-code', event: 'PreToolUse', groupIndex: 0, handlerIndex: 0, handler: { type: 'http', url, ...extra } }
}
const event: NativeEvent = { event: 'PreToolUse', sessionID: 'session', cwd: '/project', tool: 'bash', toolInput: { command: 'original' }, data: { transcript_path: '/artifacts/claude.jsonl', permission_mode: 'default', tool_use_id: 'call' } }
const host = { environment: { TOKEN: 'LOCAL_TEST_TOKEN', PRIVATE: 'PRIVATE_SENTINEL' }, projectRoot: '/project' }

test('HTTP sends the native POST payload, filters header expansion, and interprets JSON decisions', async t => {
  const { executeRegistration } = await import('../src/handlers.js')
  let captured: { method?: string; headers: IncomingMessage['headers']; payload: Record<string, JsonValue> } | undefined
  const url = await server(t, (req, res) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      captured = { ...(req.method ? { method: req.method } : {}), headers: req.headers, payload: JSON.parse(Buffer.concat(chunks).toString()) }
      res.end(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'HTTP decision' } }))
    })
  })
  const effect = await executeRegistration(hook(url, { headers: { Authorization: 'Bearer ${TOKEN}', 'X-Filters': '$PRIVATE:${MISSING}:$TOKEN' }, allowedEnvVars: ['TOKEN'] }), event, host)
  assert.equal(effect.status, 'success')
  assert.deepEqual(effect.actions, [{ kind: 'permission', decision: 'deny', reason: 'HTTP decision' }])
  assert.equal(captured?.method, 'POST')
  assert.equal(captured?.headers['content-type'], 'application/json')
  assert.equal(captured?.headers.authorization, 'Bearer LOCAL_TEST_TOKEN')
  assert.equal(captured?.headers['x-filters'], '::LOCAL_TEST_TOKEN')
  assert.equal(captured?.payload.tool_name, 'Bash')
  assert.deepEqual(captured?.payload.tool_input, { command: 'original' })
  assert.equal(JSON.stringify(effect.diagnostic).includes('LOCAL_TEST_TOKEN'), false)
})

test('HTTP accepts empty 2xx output and rejects non-object output without treating it as command text', async t => {
  const { executeRegistration } = await import('../src/handlers.js')
  let response = ''
  const url = await server(t, (_req, res) => res.end(response))
  assert.equal((await executeRegistration(hook(url), event, host)).status, 'success')
  for (const body of ['plain text', '[]', 'null', '"text"', '{"continue":"wrong"}']) {
    response = body
    const effect = await executeRegistration(hook(url), event, host)
    assert.equal(effect.status, 'failed', body)
    assert.deepEqual(effect.actions, [])
    const blocked = await executeRegistration(hook(url, { onFailure: 'block' }), event, host)
    assert.equal(blocked.actions[0]?.kind, 'permission')
  }
})

test('HTTP failures discard their response body and follow the native failure policy', async t => {
  const { executeRegistration } = await import('../src/handlers.js')
  const url = await server(t, (_req, res) => { res.statusCode = 500; res.end('PRIVATE_RESPONSE') })
  const result = await executeRegistration(hook(url), event, host)
  assert.equal(result.status, 'failed')
  assert.deepEqual(result.actions, [])
  assert.equal(JSON.stringify(result).includes('PRIVATE_RESPONSE'), false)
  const blocked = await executeRegistration(hook(url, { onFailure: 'block' }), event, host)
  assert.deepEqual(blocked.actions.map(action => action.kind), ['permission'])
})

test('HTTP deadlines cover streaming bodies; cancellation releases listeners and discards partial controls', async t => {
  const { executeRegistration } = await import('../src/handlers.js')
  let requestStarted!: () => void
  requestStarted = () => {}
  const url = await server(t, (_req, res) => { res.write('{"continue":false'); requestStarted() })
  const timedOut = await executeRegistration(hook(url, { timeout: 0.03 }), event, host)
  assert.equal(timedOut.code, 'EXECUTION_TIMEOUT')
  assert.deepEqual(timedOut.actions, [])
  const controller = new AbortController()
  const activeRequest = new Promise<void>(resolve => { requestStarted = resolve })
  const running = executeRegistration(hook(url), event, { ...host, signal: controller.signal })
  await activeRequest
  controller.abort()
  const cancelled = await running
  assert.equal(cancelled.code, 'EXECUTION_CANCELLED')
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
})

test('HTTP byte limits prevent requests with oversized input and discard oversized output', async t => {
  const { executeRegistration } = await import('../src/handlers.js')
  let calls = 0
  const url = await server(t, (_req, res) => { calls++; res.end(JSON.stringify({ systemMessage: 'x'.repeat(500) })) })
  const input = await executeRegistration(hook(url), event, { ...host, maxInputBytes: 4 })
  assert.equal(input.code, 'EXECUTION_INPUT_LIMIT')
  assert.equal(calls, 0)
  const output = await executeRegistration(hook(url), event, { ...host, maxOutputBytes: 40 })
  assert.equal(output.code, 'EXECUTION_OUTPUT_LIMIT')
  assert.deepEqual(output.actions, [])
  assert.equal(calls, 1)
})

test('HTTP redirects follow the independently observed native no-follow behavior', async t => {
  const { executeRegistration } = await import('../src/handlers.js')
  const oracle = JSON.parse(readFileSync(new URL('./fixtures/claude-http-oracle.json', import.meta.url), 'utf8'))
  assert.equal(oracle.version, '2.1.318')
  let followed = 0
  const destination = await server(t, (_req, res) => { followed++; res.end('{}') })
  let status = 302
  let location = destination
  const url = await server(t, (_req, res) => { res.writeHead(status, { Location: location }); res.end() })
  for (const observed of oracle.redirects) {
    assert.equal(observed.followed, false)
    for (status of observed.statuses) {
      location = observed.location === 'absolute' ? destination : '/relative-destination'
      const result = await executeRegistration(hook(url), event, host)
      assert.equal(result.status, 'failed')
      assert.equal(result.code, 'HTTP_STATUS_FAILED')
      assert.deepEqual(result.actions, [])
    }
  }
  assert.equal(followed, 0)
  const blocked = await executeRegistration(hook(url, { onFailure: 'block' }), event, host)
  assert.equal(blocked.actions[0]?.kind, 'permission')
})

test('HTTP cancellation before execution prevents a request and UTF-8 bodies retain multibyte content', async t => {
  const { executeRegistration } = await import('../src/handlers.js')
  let calls = 0
  const url = await server(t, (_req, res) => {
    calls++
    const bytes = Buffer.from(JSON.stringify({ systemMessage: 'café 日本語' }))
    for (const byte of bytes) res.write(Buffer.from([byte]))
    res.end()
  })
  const controller = new AbortController()
  controller.abort()
  const cancelled = await executeRegistration(hook(url), event, { ...host, signal: controller.signal })
  assert.equal(cancelled.code, 'EXECUTION_CANCELLED')
  assert.equal(calls, 0)
  const result = await executeRegistration(hook(url), event, host)
  assert.deepEqual(result.actions, [{ kind: 'warning', text: 'café 日本語' }])
})
