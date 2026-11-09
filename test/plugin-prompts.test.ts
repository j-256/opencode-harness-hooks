import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createHarnessHooks, setupHarnessHooks } from '../src/plugin.js'
import type { PromptDiagnostic } from '../src/prompt-types.js'

const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'"
async function fixture(t: { after: (callback: () => Promise<void>) => void }) {
  const directory = await mkdtemp(join(tmpdir(), 'harness-prompt-plugin-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const capture = join(directory, 'capture.jsonl')
  const script = join(directory, 'hook.cjs')
  await writeFile(script, `const fs=require('node:fs');const input=JSON.parse(fs.readFileSync(0,'utf8'));fs.appendFileSync(${JSON.stringify(capture)},JSON.stringify({...input,exists:input.transcript_path?fs.existsSync(input.transcript_path):null})+'\\n');console.log(JSON.stringify(input.prompt==='Block'?{decision:'block',reason:'PRIVATE_PROMPT_REASON'}:{hookSpecificOutput:{hookEventName:'UserPromptSubmit',additionalContext:typeof input.turn_id==='string'?'CODEX_CONTEXT':'CLAUDE_CONTEXT'}}));`)
  const source = JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: quote(process.execPath) + ' ' + quote(script) }] }] } })
  const path = join(directory, 'hooks.json')
  await writeFile(path, source)
  const sources = ['claude-code', 'codex'].map(dialect => ({ id: dialect, dialect, path }))
  const digest = createHash('sha256').update(source).digest('hex')
  return { directory, capture, options: { sources, reviewedDigests: Object.fromEntries(sources.map(source => [source.id, digest])), permissionMode: 'default' } }
}
const observed = async (path: string) => (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line))

test('V1 root runs unchanged mixed prompt sources and projects their distinct native contexts', async t => {
  const f = await fixture(t)
  let forwarded: Request | undefined
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => { forwarded = new Request(input, init); return new Response('{}') }
  const provider = { npm: '@ai-sdk/openai-compatible', options: { fetch } }
  const diagnostics: PromptDiagnostic[] = []
  const hooks = await createHarnessHooks({ directory: f.directory, client: { session: { get: async () => ({ data: { id: 'session' } }), messages: async () => ({ data: [] }) } } }, f.options, { report: () => {}, dispatchDiagnostic: () => {}, promptDiagnostic: value => { diagnostics.push(value) } })
  t.after(() => hooks.dispose())
  await hooks.config({ provider: { fixture: provider }, model: 'fixture/model' })
  const prompt = { sessionID: 'session', model: { modelID: 'model', providerID: 'fixture' } }
  const message = { id: 'turn', model: prompt.model }
  const output = { message, parts: [{ type: 'text', text: 'Original' }] }
  await hooks['chat.message'](prompt, output)
  const rows = await observed(f.capture)
  assert.equal(rows.length, 2)
  assert.equal(rows.find(row => row.turn_id === undefined).exists, false)
  assert.ok(rows.every(row => row.prompt === 'Original'))
  assert.deepEqual(output.parts, [{ type: 'text', text: 'Original' }])
  await hooks['experimental.chat.messages.transform']({}, { messages: [{ info: { ...message, role: 'user', sessionID: 'session' }, parts: output.parts }] })
  await hooks['chat.params']({ ...prompt, message, model: { ...prompt.model, api: { npm: provider.npm } }, provider: { id: 'fixture', options: provider.options } })
  const headers: Record<string, string> = {}
  await hooks['chat.headers']({ ...prompt, message }, { headers })
  await provider.options.fetch('https://provider.invalid/v1/chat/completions', { method: 'POST', headers, body: JSON.stringify({ messages: [{ role: 'user', content: 'Original' }] }) })
  const body = await forwarded!.json()
  assert.equal(body.messages[0].role, 'user')
  assert.match(body.messages[0].content[0].text, /hook additional context: CLAUDE_CONTEXT/)
  assert.deepEqual(body.messages[1], { role: 'developer', content: 'CODEX_CONTEXT' })
  assert.equal([...forwarded!.headers.keys()].some(key => key.startsWith('x-opencode-harness-')), false, JSON.stringify([...forwarded!.headers.keys()]))
  await assert.rejects(hooks['chat.message'](prompt, { message: { ...message, id: 'blocked' }, parts: [{ type: 'text', text: 'Block' }] }), { code: 'HOOK_PROMPT_BLOCKED' })
  assert.deepEqual(diagnostics.map(({ host, event, phase, sessionID, messageID, code, outcome }) => ({ host, event, phase, sessionID, messageID, code, outcome })), [{ host: 'v1', event: 'UserPromptSubmit', phase: 'admission', sessionID: 'session', messageID: 'blocked', code: 'HOOK_PROMPT_BLOCKED', outcome: 'denied' }])
  assert.ok(!JSON.stringify(diagnostics).includes('PRIVATE_PROMPT_REASON'))
})

test('V1 rejects an overwritten provider fetch before context can reach the wrong transport', async t => {
  const f = await fixture(t)
  const diagnostics: PromptDiagnostic[] = []
  const hooks = await createHarnessHooks({ directory: f.directory }, f.options, { report: () => {}, dispatchDiagnostic: () => {}, promptDiagnostic: value => { diagnostics.push(value) } })
  t.after(() => hooks.dispose())
  const provider = { options: { fetch: async () => new Response('{}') } }
  await hooks.config({ provider: { fixture: provider } })
  provider.options.fetch = async () => new Response('{}')
  await assert.rejects(hooks['chat.params']({ sessionID: 'session', message: { id: 'turn' }, model: { api: { npm: '@ai-sdk/openai' } }, provider: { id: 'fixture', options: provider.options } }), { code: 'HOST_PROMPT_TRANSPORT_UNAVAILABLE' })
  assert.equal(diagnostics[0]?.phase, 'parameters')
})

test('tool-only V1 metadata failures are not mislabeled as prompt hook failures', async t => {
  const f = await fixture(t)
  const text = JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'true' }] }] } })
  await writeFile(join(f.directory, 'hooks.json'), text)
  const options = { ...f.options, reviewedDigests: Object.fromEntries(f.options.sources.map(source => [source.id, createHash('sha256').update(text).digest('hex')])) }
  const diagnostics: PromptDiagnostic[] = []
  const hooks = await createHarnessHooks({ directory: f.directory }, options, { report: () => {}, promptDiagnostic: value => { diagnostics.push(value) } })
  t.after(() => hooks.dispose())
  await assert.rejects(hooks['chat.message']({ sessionID: 'session' }, { message: { id: '' } }), { code: 'SESSION_TURN_INVALID' })
  assert.deepEqual(diagnostics, [])
})

test('V1 concurrent sessions keep provider protocol selection tied to their own user message', async t => {
  const f = await fixture(t)
  let forwarded: Request | undefined
  const provider = { options: { fetch: async (input: RequestInfo | URL, init?: RequestInit) => { forwarded = new Request(input, init); return new Response('{}') } } }
  const hooks = await createHarnessHooks({ directory: f.directory }, { ...f.options, sources: f.options.sources.filter(source => source.dialect === 'codex') }, { report: () => {}, dispatchDiagnostic: () => {}, promptDiagnostic: () => {} })
  t.after(() => hooks.dispose())
  await hooks.config({ provider: { fixture: provider } })
  const prompts = ['first', 'second'].map(sessionID => ({ sessionID, model: { modelID: 'model', providerID: 'fixture' }, message: { id: sessionID + '-turn', model: { modelID: 'model', providerID: 'fixture' } } }))
  for (const prompt of prompts) {
    const parts = [{ type: 'text', text: 'Original' }]
    await hooks['chat.message'](prompt, { message: prompt.message, parts })
    await hooks['experimental.chat.messages.transform']({}, { messages: [{ info: { ...prompt.message, sessionID: prompt.sessionID, role: 'user' }, parts }] })
    await hooks['chat.params']({ ...prompt, model: { ...prompt.model, api: { npm: prompt.sessionID === 'first' ? '@ai-sdk/openai' : '@ai-sdk/anthropic' } }, provider: { id: 'fixture', options: provider.options } })
  }
  const headers: Record<string, string> = {}
  await hooks['chat.headers'](prompts[0]!, { headers })
  await provider.options.fetch('https://provider.invalid', { method: 'POST', headers, body: JSON.stringify({ messages: [{ role: 'user', content: 'Original' }] }) })
  assert.deepEqual((await forwarded!.json()).messages[1], { role: 'developer', content: 'CODEX_CONTEXT' })
})

test('V2 root binds prompt identity, native model metadata and HTTP projection then unregisters on disposal', async t => {
  const f = await fixture(t)
  const callbacks = new Map<string, (event: any) => Promise<void>>()
  const hook = (domain: string) => async (name: string, callback: (event: any) => Promise<void>) => { const key = domain + '.' + name; callbacks.set(key, callback); return { dispose: () => { callbacks.delete(key) } } }
  const dispose = await setupHarnessHooks({ location: { directory: f.directory }, options: f.options, model: { list: async () => ({ data: [{ id: 'model', providerID: 'fixture', package: '@opencode/ai/providers/openai-compatible' }] }) }, session: { hook: hook('session'), get: async () => ({ id: 'session', model: { id: 'model', providerID: 'fixture' } }), context: async () => [] }, tool: { hook: hook('tool') } }, { report: () => {}, dispatchDiagnostic: () => {} })
  t.after(dispose)
  await callbacks.get('session.prompt')!({ sessionID: 'session', messageID: 'turn', prompt: { text: 'Original' } })
  await callbacks.get('session.context')!({ sessionID: 'session', model: { id: 'model', providerID: 'fixture' }, messages: [{ id: 'turn', role: 'user', content: [{ type: 'text', text: 'Original' }] }] })
  const model = { sessionID: 'session', kind: 'primary', model: { id: 'model', providerID: 'fixture' }, headers: {} }
  await callbacks.get('session.model.request')!(model)
  const http = { ...model, request: new Request('https://provider.invalid/v1/chat/completions', { method: 'POST', headers: model.headers, body: JSON.stringify({ messages: [{ role: 'user', content: 'Original' }] }) }) }
  await callbacks.get('session.http.request')!(http)
  const body = await http.request.json()
  assert.match(body.messages[0].content[0].text, /CLAUDE_CONTEXT/)
  assert.deepEqual(body.messages[1], { role: 'developer', content: 'CODEX_CONTEXT' })
  assert.equal([...http.request.headers.keys()].some(key => key.startsWith('x-opencode-harness-')), false, JSON.stringify([...http.request.headers.keys()]))
  assert.equal((await observed(f.capture)).length, 2)
  await dispose()
  assert.equal(callbacks.size, 0)
})
