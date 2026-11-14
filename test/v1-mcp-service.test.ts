import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Sessions } from '../src/sessions.js'
import { V1McpTools, MCP_PROVIDER_ID, MCP_MODEL_ID } from '../src/hosts/mcp-v1.js'
import type { McpHookRequest } from '../src/host-services.js'
import type { V1McpClient } from '../src/hosts/mcp-v1.js'

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'v1-mcp-service-'))), sessions = new Sessions()
  sessions.prompt('parent', 'turn', 'parent-model')
  let service!: V1McpTools, status = 'connected', network = 0, failDelete = false, missingPolicy = false, wrongTool = false, wrongArgs = false, foreignResult = false, wrongFence = false, failedConnect = false, permission = false
  let statusHold: (() => Promise<void>) | undefined
  let connectHold: ((signal: AbortSignal) => Promise<void>) | undefined
  let servers = ['fixture']
  let creating: (() => void) | undefined, completed: (() => void) | undefined
  let rawOutput: unknown = { content: [{ type: 'text', text: '{"continue":false}' }] }
  const children = new Set<string>(), calls: { phase: string; value?: unknown }[] = [], diagnostics: unknown[] = []
  const client: V1McpClient = { mcp: {
    status: async () => { calls.push({ phase: 'status' }); if (statusHold) await statusHold(); return { data: Object.fromEntries(servers.map(name => [name, { status }])) } },
    connect: async request => { calls.push({ phase: 'connect' }); if (connectHold) await connectHold(request.signal); if (failedConnect) throw new Error('PRIVATE_CONNECTION_ERROR'); status = 'connected'; return { data: true } },
  }, session: {
    get: async () => ({ data: { id: 'parent', directory } }),
    create: async request => { calls.push({ phase: 'create', value: request.body }); const info = { id: 'child', directory, title: request.body.title, parentID: request.body.parentID, ...(missingPolicy ? {} : { permission: request.body.permission }) }; children.add(info.id); service.event('session.created', { info }); creating?.(); return { data: info } },
    prompt: async request => {
      calls.push({ phase: 'prompt', value: request.body })
      const sessionID = request.path.id, message = { id: request.body.messageID, agent: request.body.agent }, model = request.body.model, input = { sessionID, message, model, agent: message.agent }
      service.message(input, { message, parts: request.body.parts })
      const system = { system: ['PRIVATE_PARENT_INSTRUCTION'] }; service.system(input, system); assert.ok(!JSON.stringify(system).includes('PRIVATE_PARENT_INSTRUCTION'))
      service.parameters(input); service.headers(input)
      service.event('message.updated', { info: { id: 'answer', sessionID, parentID: message.id, role: 'assistant' } })
      if (permission) service.event('permission.asked', { sessionID, permission: 'fixture_check' })
      const headers: Record<string, string> = {}; service.requestHeaders(input, headers)
      const response = await service.fetch(MCP_PROVIDER_ID, async () => { network++; throw new Error('NETWORK_MUST_NOT_RUN') }, 'https://private.invalid/chat/completions', { method: 'POST', headers, body: JSON.stringify({ model: MCP_MODEL_ID, messages: [{ role: 'user', content: request.body.parts[0]!.text }], tools: [{ type: 'function', function: { name: 'fixture_check', parameters: { type: 'object', properties: {} } } }] }) })
      const frames = (await response.text()).split('\n').filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)))
      const tool = frames.flatMap(row => row.choices?.[0]?.delta?.tool_calls ?? [])[0]
      assert.equal(tool.function.name, 'fixture_check'); assert.deepEqual(JSON.parse(tool.function.arguments), { value: 'Owned input' })
      const call = { sessionID, callID: tool.id, tool: wrongTool ? 'bash' : tool.function.name }, args = wrongArgs ? { value: 'Changed input' } : JSON.parse(tool.function.arguments)
      await service.beforeTool(call, { args }); calls.push({ phase: 'delegated' })
      await service.afterTool({ ...call, args }, rawOutput)
      assert.throws(() => service.headers(input), { code: 'HOST_MCP_RESULT_CAPTURED' })
      service.event('message.updated', { info: { id: 'fenced', sessionID, parentID: message.id, role: 'assistant' } })
      completed?.()
      return { data: { info: { id: 'fenced', sessionID: foreignResult ? 'foreign' : sessionID, parentID: message.id, role: 'assistant', providerID: model.providerID, modelID: model.modelID, error: { name: 'UnknownError', data: { message: wrongFence ? 'UNRELATED_ERROR' : 'HOST_MCP_RESULT_CAPTURED' } } }, parts: [] } }
    },
    abort: async request => { calls.push({ phase: 'abort', value: request.signal.aborted }); return { data: true } },
    delete: async () => { if (failDelete) return { data: false }; children.delete('child'); return { data: true } },
    children: async () => ({ data: [] }),
  } }
  service = await V1McpTools.create({ directory, client, diagnostic: value => { diagnostics.push(value) } })
  service.attach(sessions)
  const config = { model: 'fixture/parent', agent: {} as Record<string, unknown>, provider: {} as Record<string, { options?: { fetch?: typeof fetch } }> }
  service.configure(config)
  const request = (signal = sessions.get('parent').turnSignal): McpHookRequest => ({ dialect: 'claude-code', event: 'PreToolUse', sourceID: 'source', sessionID: 'parent', cwd: directory, server: 'fixture', tool: 'check', input: { value: 'Owned input' }, signal, timeoutMs: 1000, allowAuthentication: false, connectionPolicy: 'wait-or-connect-cached' })
  t.after(async () => { failDelete = false; await service.dispose(); sessions.dispose(); await rm(directory, { recursive: true, force: true }) })
  return { holdConnect: (fn: (signal: AbortSignal) => Promise<void>) => { connectHold = fn }, servers: (values: string[]) => { servers = values }, holdStatus: (fn: () => Promise<void>) => { statusHold = fn }, permission: () => { permission = true }, failConnect: () => { failedConnect = true }, service, sessions, calls, diagnostics, children, config, request, network: () => network, status: (value: string) => { status = value }, raw: (value: unknown) => { rawOutput = value }, missingPolicy: () => { missingPolicy = true }, wrongTool: () => { wrongTool = true }, wrongArgs: () => { wrongArgs = true }, foreignResult: () => { foreignResult = true }, wrongFence: () => { wrongFence = true }, creating: (fn: () => void) => { creating = fn }, completed: (fn: () => void) => { completed = fn }, failDelete: (value: boolean) => { failDelete = value } }
}

test('owned MCP execution emits only the exact deterministic tool request and returns its raw policy without network calls', async t => {
  const f = await fixture(t), result = await f.service.execute(f.request())
  assert.deepEqual(result, { text: '{"continue":false}' }); assert.equal(f.network(), 0); assert.equal(f.children.size, 0)
  const body = f.calls.find(row => row.phase === 'create')!.value as { permission: unknown }
  assert.deepEqual(body.permission, [{ permission: '*', pattern: '*', action: 'deny' }, { permission: 'fixture_check', pattern: '*', action: 'allow' }])
  assert.ok(!JSON.stringify(f.diagnostics).includes('Owned input'))
  assert.ok(f.diagnostics.some(value => (value as { code: string }).code === 'MCP_TOOL_EXECUTED'))
})

test('missing child policy receipts and altered tool identity or arguments prevent any tool delegation', async t => {
  for (const mode of ['missingPolicy', 'wrongTool', 'wrongArgs'] as const) {
    const f = await fixture(t); f[mode]()
    await assert.rejects(f.service.execute(f.request()))
    assert.equal(f.calls.some(row => row.phase === 'delegated'), false); assert.equal(f.children.size, 0); assert.equal(f.network(), 0)
  }
})

test('foreign SDK results and unrelated errors cannot publish a captured MCP policy', async t => {
  for (const mode of ['foreignResult', 'wrongFence'] as const) {
    const f = await fixture(t); f[mode]()
    await assert.rejects(f.service.execute(f.request())); assert.equal(f.children.size, 0)
  }
})

test('raw structured-output ambiguity remains explicit after child cleanup', async t => {
  const f = await fixture(t); f.raw({ content: [{ type: 'text', text: '{"continue":false}' }], structuredContent: { continue: false } })
  await assert.rejects(f.service.execute(f.request()), { code: 'HOST_MCP_RAW_OUTPUT_UNAVAILABLE' }); assert.equal(f.children.size, 0)
})

test('ordinary requests cannot use the private provider as an execution authority', async t => {
  const f = await fixture(t)
  await assert.rejects(f.service.fetch(MCP_PROVIDER_ID, async () => { throw new Error('PRIVATE_NETWORK') }, 'https://private.invalid', { method: 'POST', body: '{}' }), { code: 'HOST_MCP_REQUEST_OWNER_MISMATCH' })
  const transport = f.config.provider[MCP_PROVIDER_ID]!.options!.fetch!
  await assert.rejects(transport('https://private.invalid'), { code: 'HOST_MCP_REQUEST_OWNER_MISMATCH' })
  assert.equal(f.network(), 0)
})

test('required native request metadata is rejected before connection work or child creation', async t => {
  const f = await fixture(t)
  await assert.rejects(f.service.execute({ ...f.request(), dialect: 'codex', metadata: { threadId: 'native-thread' }, connectionPolicy: 'connected-only' }), { code: 'HOST_MCP_REQUEST_METADATA_UNAVAILABLE' })
  assert.deepEqual(f.calls, [])
})

test('disabled or authentication-required servers never trigger connection or authentication work', async t => {
  for (const status of ['disabled', 'needs_auth', 'needs_client_registration']) {
    const f = await fixture(t); f.status(status)
    await assert.rejects(f.service.execute(f.request()), { code: 'MCP_SERVER_NOT_READY' })
    assert.equal(f.calls.some(row => row.phase === 'connect' || row.phase === 'create'), false)
  }
})

test('failed cached servers can reconnect for Claude while connected-only requests never reconnect', async t => {
  const f = await fixture(t); f.status('failed'); await f.service.execute(f.request())
  assert.equal(f.calls.filter(row => row.phase === 'connect').length, 1)
  const g = await fixture(t); g.status('failed')
  await assert.rejects(g.service.execute({ ...g.request(), connectionPolicy: 'connected-only' }), { code: 'MCP_SERVER_NOT_READY' })
  assert.equal(g.calls.some(row => row.phase === 'connect'), false)
})

test('cancellation during creation or after capture fences the result and uses a fresh cleanup signal', async t => {
  for (const phase of ['creating', 'completed'] as const) {
    const f = await fixture(t), controller = new AbortController(); f[phase](() => controller.abort())
    await assert.rejects(f.service.execute(f.request(controller.signal)), { code: 'EXECUTION_CANCELLED' })
    await f.service.dispose(); assert.equal(f.children.size, 0)
    assert.ok(f.calls.filter(row => row.phase === 'abort').every(row => row.value === false))
  }
})

test('negative deletion receipts remain inspectable and disposal retries the owned child', async t => {
  const f = await fixture(t); f.failDelete(true); await f.service.execute(f.request())
  assert.equal(f.service.inspect().cleanupFailed, 1)
  f.failDelete(false); await f.service.dispose()
  assert.equal(f.children.size, 0); assert.equal(f.service.inspect().cleanupFailed, 0)
})

test('missing configured servers fail without inventing a tool-identity capability error', async t => {
  const f = await fixture(t)
  await assert.rejects(f.service.execute({ ...f.request(), server: 'missing' }), { code: 'MCP_SERVER_NOT_FOUND' })
  assert.equal(f.calls.some(row => row.phase === 'create' || row.phase === 'connect'), false)
})


test('observational cached connection failures remain diagnosable without disclosing server errors', async t => {
  const f = await fixture(t); f.status('failed'); f.failConnect()
  await assert.rejects(f.service.execute({ ...f.request(), connectionPolicy: 'connect-cached-without-waiting' }), { code: 'MCP_SERVER_NOT_READY' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.service.inspect().connectionFailures, 1)
  assert.ok(f.diagnostics.some(value => (value as { code: string }).code === 'MCP_CONNECTION_FAILED'))
  assert.ok(!JSON.stringify(f.diagnostics).includes('PRIVATE_CONNECTION_ERROR'))
  assert.equal(f.children.size, 0)
})


test('an unexpected permission request aborts the child without granting or delegating the call', async t => {
  const f = await fixture(t); f.permission()
  await assert.rejects(f.service.execute(f.request()), { code: 'HOST_MCP_PERMISSION_UNAVAILABLE' })
  assert.equal(f.calls.some(row => row.phase === 'delegated'), false)
  assert.equal(f.children.size, 0); assert.equal(f.network(), 0)
})


test('late status responses cannot start cached reconnection after the handler was cancelled', async t => {
  for (const connectionPolicy of ['wait-or-connect-cached', 'connect-cached-without-waiting'] as const) {
    const f = await fixture(t), controller = new AbortController(); f.status('failed')
    let release!: () => void, entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve }), held = new Promise<void>(resolve => { release = resolve })
    f.holdStatus(async () => { entered(); await held })
    const running = f.service.execute({ ...f.request(controller.signal), connectionPolicy })
    await started; controller.abort(); await assert.rejects(running, { code: 'EXECUTION_CANCELLED' })
    release(); await new Promise(resolve => setImmediate(resolve))
    assert.equal(f.calls.some(row => row.phase === 'connect' || row.phase === 'create'), false)
  }
})

test('private provider admission preserves the caller allowlist and respects explicit provider disablement', async t => {
  const f = await fixture(t), allowed = ['fixture'], config = Object.assign(f.config, { enabled_providers: allowed })
  f.service.configure(config)
  assert.deepEqual(config.enabled_providers, ['fixture', MCP_PROVIDER_ID]); assert.deepEqual(allowed, ['fixture'])
  f.service.configure(config); assert.deepEqual(config.enabled_providers, ['fixture', MCP_PROVIDER_ID])
  await f.service.dispose(); assert.equal(config.enabled_providers, allowed)
  const g = await fixture(t)
  assert.throws(() => g.service.configure(Object.assign(g.config, { disabled_providers: [MCP_PROVIDER_ID] })), { code: 'HOST_MCP_PROVIDER_DISABLED' })
})


test('repeated observational hooks coalesce one held reconnect and disposal cancels it', async t => {
  const f = await fixture(t); f.status('failed')
  let cancelled = 0
  f.holdConnect(signal => new Promise(resolve => signal.addEventListener('abort', () => { cancelled++; resolve() }, { once: true })))
  for (let index = 0; index < 40; index++) await assert.rejects(f.service.execute({ ...f.request(), connectionPolicy: 'connect-cached-without-waiting' }), { code: 'MCP_SERVER_NOT_READY' })
  assert.equal(f.calls.filter(row => row.phase === 'connect').length, 1)
  assert.equal(f.service.inspect().connections, 1)
  await f.service.dispose(); assert.equal(cancelled, 1); assert.equal(f.service.inspect().connections, 0)
})

test('distinct observational servers cannot create an unbounded set of held reconnects', async t => {
  const f = await fixture(t), names = Array.from({ length: 80 }, (_, index) => 'server' + index); f.status('failed'); f.servers(names)
  let cancelled = 0
  f.holdConnect(signal => new Promise(resolve => signal.addEventListener('abort', () => { cancelled++; resolve() }, { once: true })))
  const outcomes: string[] = []
  for (const server of names) {
    await assert.rejects(f.service.execute({ ...f.request(), server, connectionPolicy: 'connect-cached-without-waiting' }), (error: unknown) => {
      assert.ok(error && typeof error === 'object' && 'code' in error)
      const code = String(error.code); assert.ok(['MCP_SERVER_NOT_READY', 'MCP_CONNECTION_LIMIT'].includes(code)); outcomes.push(code); return true
    })
  }
  assert.ok(outcomes.includes('MCP_CONNECTION_LIMIT'))
  const started = f.calls.filter(row => row.phase === 'connect').length
  assert.ok(started > 0 && started <= 32); assert.equal(f.service.inspect().connections, started)
  await f.service.dispose(); assert.equal(cancelled, started); assert.equal(f.service.inspect().connections, 0)
})
