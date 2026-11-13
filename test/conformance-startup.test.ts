import assert from 'node:assert/strict'
import { test } from 'node:test'

const library = () => import(new URL('../scripts/lib/conformance-startup.mjs', import.meta.url).href)
const reminder = '<system-reminder>\nSessionStart:startup hook success: START_CONTEXT\n</system-reminder>'

test('startup model oracle rejects wrong text, role, order, duplication and missing context', async () => {
  const { startupModelView } = await library()
  const user = { role: 'user', content: [{ type: 'text', text: 'CONFORMANCE_CASE:allow' }] }
  const context = { role: 'user', content: [{ type: 'text', text: reminder }] }
  assert.equal(startupModelView([context, user], 'claude-code'), true)
  for (const rows of [[user], [user, context], [context, context, user], [{ ...context, role: 'system' }, user], [{ ...context, content: [{ type: 'text', text: 'START_CONTEXT' }] }, user]]) assert.equal(startupModelView(rows, 'claude-code'), false)
  const codex = { role: 'developer', content: [{ type: 'input_text', text: 'START_CONTEXT' }] }
  assert.equal(startupModelView([codex, user], 'codex'), true)
  assert.equal(startupModelView([{ ...codex, role: 'user' }, user], 'codex'), false)
})

test('startup comparison requires each independent native and host observable', async () => {
  const { evaluateStartupObservations } = await library()
  const make = () => ({ sourceDigest: 'a'.repeat(64), hookDigest: 'b'.repeat(64), controls: ['deny', 'allow'].map(id => ({ id, hookInvocations: 1, event: 'PreToolUse', tool: 'Bash', cwdMatches: true, commandMatches: true, identityValid: true, transcriptExists: true, resultOwned: true, reasonDelivered: id === 'deny', sideEffect: id === 'allow', primaryModelCalls: 2, startupInvocations: 1, startupMetadataValid: true, startupContextValid: true })) })
  assert.equal(evaluateStartupObservations(make(), make()).status, 'passed')
  for (const backend of ['native', 'host']) for (const field of ['startupInvocations', 'startupMetadataValid', 'startupContextValid', 'sideEffect']) {
    const native = make(), host = make(), trace = backend === 'native' ? native : host
    Object.assign(trace.controls[1]!, { [field]: field === 'startupInvocations' ? 0 : false })
    assert.equal(evaluateStartupObservations(native, host).status, 'failed')
  }
})

test('the fixture waits for configured project readiness before creating sessions', async t => {
  const { createServer } = await import('node:http')
  const { initializeHost } = await import(new URL('../scripts/lib/conformance-pretool.mjs', import.meta.url).href)
  let calls = 0, valid = true
  const server = createServer((request, response) => {
    calls++
    assert.equal(new URL(request.url!, 'http://loopback').pathname, '/config')
    assert.equal(new URL(request.url!, 'http://loopback').searchParams.get('directory'), '/fixture project')
    assert.equal(request.headers.authorization, 'Basic ' + Buffer.from('opencode:synthetic').toString('base64'))
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ model: valid ? 'fixture/fixture' : 'foreign/model' }))
  })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
  const address = server.address() as { port: number }
  assert.ok(await initializeHost('http://127.0.0.1:' + address.port, '/fixture project', 'synthetic') >= 0)
  valid = false
  await assert.rejects(initializeHost('http://127.0.0.1:' + address.port, '/fixture project', 'synthetic'), /HOST_CONFIGURATION_INVALID/)
  assert.equal(calls, 2)
})
