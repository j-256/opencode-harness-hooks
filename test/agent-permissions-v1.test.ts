import assert from 'node:assert/strict'
import { test } from 'node:test'
import { V1AgentPermissions, readOnlyShell } from '../src/hosts/agent-permissions-v1.js'

function fixture(response?: () => Promise<Response>) {
  const controller = new AbortController(), calls: { url: string; init: RequestInit }[] = [], diagnostics: unknown[] = []
  const execution = { parentID: 'parent', turnID: 'turn', sessionID: 'child', signal: controller.signal, context: { host: 'v1' as const, dialect: 'claude-code' as const, event: 'UserPromptSubmit', sourceID: 'source', registrationID: 'agent', nativeInput: {} } }
  const permissions = new V1AgentPermissions({ serverUrl: new URL('http://127.0.0.1:4096'), directory: '/owned/project', environment: { OPENCODE_SERVER_USERNAME: 'operator', OPENCODE_SERVER_PASSWORD: 'PRIVATE_SERVER_SECRET' }, owner: input => { if (input.sessionID !== 'child' || input.tool.callID !== 'call' || input.tool.messageID !== 'answer') throw new Error('FOREIGN_OWNER'); return execution }, diagnostic: value => { diagnostics.push(value) }, fetch: async (input, init) => { calls.push({ url: String(input), init: init! }); return response ? response() : new Response('true', { headers: { 'content-type': 'application/json' } }) } })
  const call = { sessionID: 'child', callID: 'call', tool: 'bash' }, request = { id: 'permission', sessionID: 'child', permission: 'bash', tool: { callID: 'call', messageID: 'answer' }, patterns: ['cat owned.txt'] }
  return { permissions, controller, execution, call, request, calls, diagnostics }
}

test('a literal readonly Bash permission receives one owned reply without leaking server credentials', async () => {
  const f = fixture(); f.permissions.capture(f.execution, f.call, { command: 'cat owned.txt' })
  await f.permissions.reply(f.request)
  assert.equal(f.calls.length, 1); assert.equal(JSON.parse(String(f.calls[0]!.init.body)).reply, 'once')
  assert.equal(new Headers(f.calls[0]!.init.headers).get('authorization'), 'Basic ' + Buffer.from('operator:PRIVATE_SERVER_SECRET').toString('base64'))
  assert.equal(f.calls[0]!.init.redirect, 'error'); assert.equal(new URL(f.calls[0]!.url).searchParams.get('directory'), '/owned/project')
  assert.ok(!JSON.stringify(f.diagnostics).includes('PRIVATE_SERVER_SECRET'))
  await f.permissions.reply(f.request); assert.equal(f.calls.length, 1)
  await f.permissions.dispose()
})

test('unapproved effectful Bash calls receive a corrective denial while source preapproval stays scoped to the actual call', async () => {
  const f = fixture(); f.permissions.capture(f.execution, f.call, { command: 'printf x > owned.txt' }); await f.permissions.reply(f.request)
  assert.deepEqual(JSON.parse(String(f.calls[0]!.init.body)), { reply: 'reject', message: 'Agent hook permission denied in dontAsk mode' })
  await f.permissions.dispose()
  const g = fixture(); g.permissions.approve(g.execution, g.call); g.permissions.capture(g.execution, g.call, { command: 'printf x > owned.txt' }); await g.permissions.reply(g.request)
  assert.equal(JSON.parse(String(g.calls[0]!.init.body)).reply, 'once')
  await g.permissions.dispose()
})

test('readonly classification cannot approve external-directory or unrelated tool permissions', async () => {
  const f = fixture(); f.permissions.capture(f.execution, f.call, { command: 'cat ../outside.txt' })
  await f.permissions.reply({ ...f.request, permission: 'external_directory' })
  assert.equal(JSON.parse(String(f.calls[0]!.init.body)).reply, 'reject'); await f.permissions.dispose()
})

test('foreign permission callbacks and completed or cancelled calls never send a reply', async () => {
  const f = fixture(); f.permissions.capture(f.execution, f.call, { command: 'cat owned.txt' })
  await assert.rejects(f.permissions.reply({ ...f.request, sessionID: 'foreign' })); assert.equal(f.calls.length, 0)
  f.permissions.complete(f.call); await assert.rejects(f.permissions.reply(f.request)); assert.equal(f.calls.length, 0)
  await f.permissions.dispose()
  const g = fixture(); g.permissions.capture(g.execution, g.call, { command: 'cat owned.txt' }); g.controller.abort()
  await assert.rejects(g.permissions.reply(g.request)); assert.equal(g.calls.length, 0); await g.permissions.dispose()
})

test('readonly shell recognition rejects composition, expansions, redirects and arbitrary executables', () => {
  for (const text of ['cat owned.txt', "cat 'owned file.txt'", '/bin/cat owned.txt', 'head -n 3 owned.txt', 'wc -l owned.txt']) assert.equal(readOnlyShell(text), true, text)
  for (const text of ['cat owned.txt > written.txt', 'cat owned.txt; touch written', 'cat $(touch written)', 'cat `touch written`', 'cat owned.txt | sh', 'cat "$COMMAND"', 'cat owned.txt\ntouch written', 'env cat owned.txt', '/tmp/cat owned.txt', 'sed -e "1e touch written" owned.txt']) assert.equal(readOnlyShell(text), false, text)
})


test('permission ownership failures produce one private structured diagnostic', async () => {
  const f = fixture(); f.permissions.capture(f.execution, f.call, { command: 'cat owned.txt' })
  await assert.rejects(f.permissions.reply({ ...f.request, sessionID: 'foreign' }))
  assert.equal(f.diagnostics.length, 1)
  const value = f.diagnostics[0] as { code: string; outcome: string }
  assert.equal(value.code, 'HOST_AGENT_PERMISSION_FAILED'); assert.equal(value.outcome, 'failed')
  assert.ok(!JSON.stringify(f.diagnostics).includes('PRIVATE_SERVER_SECRET')); await f.permissions.dispose()
})

test('negative permission receipts fail and rejected HTTP responses cancel their bodies', async () => {
  const f = fixture(async () => new Response('false')); f.permissions.capture(f.execution, f.call, { command: 'cat owned.txt' })
  await assert.rejects(f.permissions.reply(f.request), { code: 'HOST_AGENT_PERMISSION_REPLY_FAILED' }); await f.permissions.dispose()
  let cancelled = false
  const g = fixture(async () => new Response(new ReadableStream({ pull() {}, cancel() { cancelled = true } }), { status: 500 }))
  g.permissions.capture(g.execution, g.call, { command: 'cat owned.txt' })
  await assert.rejects(g.permissions.reply(g.request), { code: 'HOST_AGENT_PERMISSION_REPLY_FAILED' })
  assert.equal(cancelled, true); assert.equal(g.diagnostics.length, 1); await g.permissions.dispose()
})
