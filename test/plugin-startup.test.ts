import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createHarnessHooks } from '../src/hosts/plugin-v1.js'

const quote = (text: string) => "'" + text.replaceAll("'", "'\"'\"'") + "'"
for (const dialect of ['claude-code', 'codex'] as const) test(`default V1 delivers owned startup context once before its first prompt (${dialect})`, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'plugin-startup-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const capture = join(directory, 'capture.jsonl'), script = join(directory, 'hook.cjs')
  await writeFile(script, `const fs=require('node:fs');const p=JSON.parse(fs.readFileSync(0,'utf8'));fs.appendFileSync(${JSON.stringify(capture)},JSON.stringify(p)+'\\n');console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'SessionStart',additionalContext:'START_CONTEXT'}}))`)
  const source = JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: quote(process.execPath) + ' ' + quote(script) }] }] } })
  await writeFile(join(directory, 'hooks.json'), source)
  let messages: readonly unknown[] = []
  const forwarded: Request[] = []
  const config = { model: 'fixture/model', shell: '/bin/bash', provider: { fixture: { options: { fetch: async (input: RequestInfo | URL, init?: RequestInit) => { forwarded.push(new Request(input, init)); return new Response('{}') } } } } }
  const hooks = await createHarnessHooks({ directory, client: { session: { get: async () => ({ data: { id: 'session' } }), messages: async () => ({ data: messages }) }, config: { get: async () => ({ data: config }) } } }, { sources: [{ id: dialect, dialect, path: 'hooks.json' }], reviewedDigests: { [dialect]: createHash('sha256').update(source).digest('hex') }, permissionMode: 'default' }, { host: { environment: { PATH: process.env.PATH, HOME: directory, XDG_STATE_HOME: join(directory, 'state'), SHELL: '/bin/bash' } }, report: () => {}, dispatchDiagnostic: () => {} })
  t.after(() => hooks.dispose())
  await hooks.config(config)
  const configuredShell = config.shell
  await hooks.config(config)
  assert.equal(config.shell, configuredShell)
  await hooks.event({ event: { type: 'session.created', properties: { sessionID: 'session', info: { id: 'session' } } } })
  assert.equal((await readFile(capture, 'utf8')).trim().split('\n').length, 1)
  const message = { id: 'turn', agent: 'build', model: { providerID: 'fixture', modelID: 'model' } }
  await hooks['chat.message']({ sessionID: 'session', agent: 'build', model: message.model }, { message, parts: [{ type: 'text', text: 'Original' }] })
  const payloads = (await readFile(capture, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.equal(payloads.length, 1)
  assert.equal(payloads[0].hook_event_name, 'SessionStart')
  assert.equal(payloads[0].source, 'startup')
  assert.equal(payloads[0].cwd, directory)
  assert.equal(Object.hasOwn(payloads[0], 'turn_id'), false)
  if (dialect === 'codex') { assert.match(payloads[0].session_id, /^[a-f0-9-]{36}$/); assert.equal(payloads[0].model, 'model'); assert.equal(payloads[0].permission_mode, 'default') }
  messages = [{ info: { id: 'turn', sessionID: 'session', role: 'user', time: { created: Date.now() } }, parts: [{ type: 'text', text: 'Original' }] }]
  await hooks['experimental.chat.messages.transform']({}, { messages })
  const model = { ...message.model, api: { npm: '@ai-sdk/openai-compatible' } }, input = { sessionID: 'session', agent: 'build', model, message }
  await hooks['chat.params']({ ...input, provider: { id: 'fixture', options: config.provider.fixture.options } })
  const headers: Record<string, string> = {}
  await hooks['chat.headers'](input, { headers })
  const request = new Request('https://provider.invalid/v1/chat/completions', { method: 'POST', headers, body: JSON.stringify({ messages: [{ role: 'user', content: 'Original' }] }) })
  const projected = await config.provider.fixture.options.fetch(request)
  assert.equal(projected.status, 200)
  const body = await forwarded[0]!.json()
  if (dialect === 'claude-code') assert.deepEqual(body.messages[0].content, [{ type: 'text', text: '<system-reminder>\nSessionStart hook additional context: START_CONTEXT\n</system-reminder>' }, { type: 'text', text: 'Original' }])
  else assert.deepEqual(body.messages.map((row: any) => row.role), ['developer', 'user'])
  assert.equal((await readFile(capture, 'utf8')).trim().split('\n').length, 1)
})

for (const dialect of ['claude-code', 'codex'] as const) test(`startup survives a rejected first prompt and session deletion cancels further admission (${dialect})`, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'plugin-startup-reject-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const capture = join(directory, 'calls'), script = join(directory, 'hook.cjs')
  await writeFile(script, `const fs=require('node:fs');const p=JSON.parse(fs.readFileSync(0,'utf8'));fs.appendFileSync(${JSON.stringify(capture)},p.hook_event_name+'\\n');if(p.hook_event_name==='SessionStart')console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'SessionStart',additionalContext:'START_AFTER_BLOCK'}}));else if(p.prompt==='Blocked'){console.error('Expected blocked prompt');process.exit(2)}`)
  const handler = { hooks: [{ type: 'command', command: quote(process.execPath) + ' ' + quote(script) }] }
  const source = JSON.stringify({ hooks: { SessionStart: [handler], UserPromptSubmit: [handler] } })
  await writeFile(join(directory, 'hooks.json'), source)
  const config = { model: 'fixture/model', shell: '/bin/bash', provider: { fixture: { options: {} } } }
  const hooks = await createHarnessHooks({ directory, client: { session: { get: async () => ({ data: { id: 'session' } }), messages: async () => ({ data: [] }) } } }, { sources: [{ id: dialect, dialect, path: 'hooks.json' }], reviewedDigests: { [dialect]: createHash('sha256').update(source).digest('hex') }, permissionMode: 'default' }, { host: { environment: { PATH: process.env.PATH, HOME: directory, XDG_STATE_HOME: join(directory, 'state') } }, report: () => {}, promptDiagnostic: () => {}, dispatchDiagnostic: () => {} })
  t.after(() => hooks.dispose())
  await hooks.config(config)
  const prompt = { sessionID: 'session', agent: 'build', model: { providerID: 'fixture', modelID: 'model' } }
  await hooks.event({ event: { type: 'session.created', properties: { sessionID: 'session', info: { id: 'session' } } } })
  await assert.rejects(hooks['chat.message'](prompt, { message: { id: 'blocked', agent: 'build', model: prompt.model }, parts: [{ type: 'text', text: 'Blocked' }] }), { code: 'HOOK_PROMPT_BLOCKED' })
  await hooks['chat.message'](prompt, { message: { id: 'accepted', agent: 'build', model: prompt.model }, parts: [{ type: 'text', text: 'Accepted' }] })
  assert.deepEqual((await readFile(capture, 'utf8')).trim().split('\n'), ['SessionStart', 'UserPromptSubmit', 'UserPromptSubmit'])
  assert.equal(hooks.inspect().prompts.prompts, 1)
  await hooks.event({ event: { type: 'session.deleted', properties: { sessionID: 'session', info: { id: 'session' } } } })
  await assert.rejects(hooks['chat.message'](prompt, { message: { id: 'after-delete', agent: 'build', model: prompt.model }, parts: [{ type: 'text', text: 'No' }] }), { code: 'SESSION_CLOSED' })
})

for (const dialect of ['claude-code', 'codex'] as const) test(`replaced prompt cancels only its waiter and joins the same pending startup (${dialect})`, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'plugin-startup-replace-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const capture = join(directory, 'count')
  const source = JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'printf tick >> ' + quote(capture) }] }] } })
  await writeFile(join(directory, 'hooks.json'), source)
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve }), started = new Promise<void>(resolve => { entered = resolve })
  const hooks = await createHarnessHooks({ directory, client: { session: { get: async () => { entered(); await gate; return { data: { id: 'session' } } }, messages: async () => ({ data: [] }) } } }, { sources: [{ id: dialect, dialect, path: 'hooks.json' }], reviewedDigests: { [dialect]: createHash('sha256').update(source).digest('hex') }, permissionMode: 'default' }, { host: { environment: { PATH: process.env.PATH, HOME: directory, XDG_STATE_HOME: join(directory, 'state') } }, report: () => {}, promptDiagnostic: () => {}, dispatchDiagnostic: () => {} })
  t.after(() => hooks.dispose())
  await hooks.config({ provider: { fixture: { options: {} } } })
  const prompt = { sessionID: 'session', agent: 'build', model: { providerID: 'fixture', modelID: 'model' } }
  const first = hooks['chat.message'](prompt, { message: { id: 'replaced', model: prompt.model }, parts: [{ type: 'text', text: 'First' }] })
  const cancelled = assert.rejects(first, { code: 'EXECUTION_CANCELLED' })
  await started
  const second = hooks['chat.message'](prompt, { message: { id: 'accepted', model: prompt.model }, parts: [{ type: 'text', text: 'Second' }] })
  await cancelled
  release()
  await second
  assert.equal(await readFile(capture, 'utf8'), 'tick')
  assert.equal(hooks.inspect().prompts.prompts, 1)
})

for (const dialect of ['claude-code', 'codex'] as const) test(`session-created observer survives a prompt arriving during startup (${dialect})`, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'plugin-startup-observer-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const diagnostics: string[] = []
  t.mock.method(console, 'error', (...values: unknown[]) => { diagnostics.push(values.join(' ')) })
  const source = JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: ':' }] }] } })
  await writeFile(join(directory, 'hooks.json'), source)
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve }), started = new Promise<void>(resolve => { entered = resolve })
  const hooks = await createHarnessHooks({ directory, client: { session: { get: async () => { entered(); await gate; return { data: { id: 'session' } } }, messages: async () => ({ data: [] }) } } }, { sources: [{ id: dialect, dialect, path: 'hooks.json' }], reviewedDigests: { [dialect]: createHash('sha256').update(source).digest('hex') }, permissionMode: 'default' }, { host: { environment: { PATH: process.env.PATH, HOME: directory, XDG_STATE_HOME: join(directory, 'state') } }, report: () => {}, promptDiagnostic: () => {}, dispatchDiagnostic: () => {} })
  t.after(() => hooks.dispose())
  await hooks.config({ model: 'fixture/model', provider: { fixture: { options: {} } } })
  const observed = hooks.event({ event: { type: 'session.created', properties: { sessionID: 'session', info: { id: 'session' } } } })
  await started
  const admitted = hooks['chat.message']({ sessionID: 'session', model: { providerID: 'fixture', modelID: 'model' } }, { message: { id: 'turn' }, parts: [{ type: 'text', text: 'Original' }] })
  release()
  await Promise.all([observed, admitted])
  assert.equal(diagnostics.some(value => value.includes('HOST_STARTUP_ACTIVATION_FAILED')), false)
  assert.equal(hooks.inspect().runtime.sessionStarts?.retained, 1)
})
