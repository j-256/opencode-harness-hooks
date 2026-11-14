import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { watch } from 'node:fs'
import { createHarnessHooks } from './helpers/isolated-v1.js'
import { BACKGROUND_REQUEST_HEADER } from '../src/hosts/background-projection-v1.js'
import { MODEL_REQUEST_HEADER } from '../src/hosts/model-v1.js'
import { PROMPT_REQUEST_HEADER } from '../src/prompt-contexts.js'

const quote = (text: string) => "'" + text.replaceAll("'", "'\"'\"'") + "'"
async function fixture(t: { after(callback: () => Promise<void>): void }) {
  const directory = await mkdtemp(join(tmpdir(), 'plugin-background-')), capture = join(directory, 'capture.jsonl'), script = join(directory, 'hook.cjs'), sourcePath = join(directory, 'hooks.json')
  t.after(() => rm(directory, { recursive: true, force: true }))
  await writeFile(script, `const fs=require('node:fs');const input=JSON.parse(fs.readFileSync(0,'utf8'));fs.appendFileSync(${JSON.stringify(capture)},JSON.stringify(input)+'\\n');process.stdout.write(JSON.stringify({continue:false,decision:'block',reason:'IGNORED_CONTROL',systemMessage:'BACKGROUND_WARNING',hookSpecificOutput:{hookEventName:'UserPromptSubmit',additionalContext:'BACKGROUND_CONTEXT'}}));`)
  const source = JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: quote(process.execPath) + ' ' + quote(script), async: true }] }] } })
  await writeFile(sourcePath, source)
  const digest = createHash('sha256').update(source).digest('hex'), sources = ['claude-code', 'codex'].map(dialect => ({ id: dialect, dialect, path: sourcePath }))
  const options = { sources, reviewedDigests: Object.fromEntries(sources.map(row => [row.id, digest])), permissionMode: 'default' }
  return { directory, capture, options }
}

test('V1 root executes selected mixed async hooks by default and delivers native channels without veto or private-header leakage', { timeout: 10000 }, async t => {
  const f = await fixture(t), forwarded: Request[] = [], history: unknown[] = [], retained = new Set<string>(), warnings: string[] = []
  let ready!: () => void, warned!: () => void
  const completion = new Promise<void>(resolve => { ready = resolve }), warning = new Promise<void>(resolve => { warned = resolve })
  const provider = { options: { fetch: async (input: RequestInfo | URL, init?: RequestInit) => { forwarded.push(new Request(input, init)); return new Response('{}') } } }
  const hooks = await createHarnessHooks({ directory: f.directory, client: { session: { get: async () => ({ data: { id: 'session' } }), messages: async () => ({ data: history }) }, tui: { showToast: async request => { warnings.push(request.body.message); assert.equal(request.body.variant, 'error'); warned(); return { data: true } } } } }, f.options, { report: () => {}, dispatchDiagnostic: () => {}, backgroundDiagnostic: row => { if (row.code === 'HOST_BACKGROUND_RETAINED') { retained.add(row.jobID!); if (retained.size === 2) ready() } } })
  t.after(() => hooks.dispose())
  const foreign = { options: { fetch: provider.options.fetch } }
  await hooks.config({ provider: { fixture: provider, foreign }, model: 'fixture/model' })
  const message = { id: 'turn', agent: 'build', model: { providerID: 'fixture', modelID: 'model' } }, prompt = { sessionID: 'session', agent: 'build', model: message.model }, parts = [{ type: 'text', text: 'Original user prompt' }]
  await hooks['chat.message'](prompt, { message, parts })
  assert.deepEqual(parts, [{ type: 'text', text: 'Original user prompt' }])
  history.push({ info: { ...message, role: 'user', sessionID: 'session', time: { created: 1700000000000 } }, parts })
  await completion; await warning
  await hooks['experimental.chat.messages.transform']({}, { messages: history })
  await hooks['chat.params']({ ...prompt, message, model: { ...message.model, api: { npm: '@ai-sdk/openai-compatible' } }, provider: { id: 'fixture', options: provider.options } })
  const headers: Record<string, string> = {}; await hooks['chat.headers']({ ...prompt, message }, { headers })
  assert.equal(typeof headers[BACKGROUND_REQUEST_HEADER], 'string')
  await provider.options.fetch('https://provider.invalid/chat/completions', { method: 'POST', headers, body: JSON.stringify({ messages: [{ role: 'user', content: 'Original user prompt' }] }) })
  const actual = await forwarded[0]!.json()
  assert.deepEqual(actual.messages, [{ role: 'user', content: [{ type: 'text', text: '<system-reminder>\nBACKGROUND_WARNING\n</system-reminder>' }, { type: 'text', text: '<system-reminder>\nBACKGROUND_CONTEXT\n</system-reminder>\n' }, { type: 'text', text: 'Original user prompt' }] }, { role: 'developer', content: 'BACKGROUND_CONTEXT' }])
  assert.deepEqual(warnings, ['BACKGROUND_WARNING']); assert.equal(JSON.stringify(actual).includes('IGNORED_CONTROL'), false)
  assert.equal([...forwarded[0]!.headers.keys()].some(key => key.startsWith('x-opencode-harness-')), false)
  const body = JSON.stringify({ messages: [{ role: 'user', content: 'Original user prompt' }] })
  await assert.rejects(foreign.options.fetch('https://provider.invalid', { method: 'POST', headers, body }), { code: 'HOST_BACKGROUND_REQUEST_UNAVAILABLE' })
  await assert.rejects(provider.options.fetch('https://provider.invalid', { method: 'POST', headers: { ...headers, [MODEL_REQUEST_HEADER]: 'foreign-evaluator' }, body }), { code: 'HOST_MODEL_REQUEST_OWNER_MISMATCH' })
  for (const token of ['', 'foreign-ticket']) await assert.rejects(provider.options.fetch('https://provider.invalid', { method: 'POST', headers: { [BACKGROUND_REQUEST_HEADER]: token }, body }))
  assert.equal(forwarded.length, 1)
  assert.equal((await readFile(f.capture, 'utf8')).trim().split('\n').length, 2)
  await hooks.dispose(); assert.equal(hooks.inspect().background!.jobs, 0)
})

test('an injected background service retains command ownership and disables the default executor', { timeout: 10000 }, async t => {
  const f = await fixture(t), submitted: unknown[] = []
  const hooks = await createHarnessHooks({ directory: f.directory, client: { session: { get: async () => ({ data: { id: 'session' } }), messages: async () => ({ data: [] }) } } }, f.options, { report: () => {}, dispatchDiagnostic: () => {}, host: { environment: process.env, background: { supportsRewake: true, enqueue: work => { submitted.push(work); return { status: 'accepted', code: 'BACKGROUND_QUEUED', id: 'custom-' + submitted.length } } } } })
  t.after(() => hooks.dispose())
  const provider = { options: {} }; await hooks.config({ provider: { fixture: provider }, model: 'fixture/model' })
  await hooks['chat.message']({ sessionID: 'session', model: { providerID: 'fixture', modelID: 'model' } }, { message: { id: 'turn' }, parts: [{ type: 'text', text: 'Original' }] })
  assert.equal(submitted.length, 2); await assert.rejects(readFile(f.capture), { code: 'ENOENT' }); assert.equal(hooks.inspect().background, undefined)
})

test('cold replay retains background context after its source is deselected without reexecuting commands', { timeout: 10000 }, async t => {
  const f = await fixture(t), history: unknown[] = [], forwarded: Request[] = [], retained = new Set<string>()
  let ready!: () => void; const completion = new Promise<void>(resolve => { ready = resolve })
  const input = { directory: f.directory, client: { session: { get: async () => ({ data: { id: 'session' } }), messages: async () => ({ data: history }) }, tui: { showToast: async () => ({ data: true }) } } }
  const first = await createHarnessHooks(input, f.options, { report: () => {}, dispatchDiagnostic: () => {}, backgroundDiagnostic: row => { if (row.code === 'HOST_BACKGROUND_RETAINED') { retained.add(row.jobID!); if (retained.size === 2) ready() } } })
  t.after(() => first.dispose())
  const provider = () => ({ options: { fetch: async (request: RequestInfo | URL, init?: RequestInit) => { forwarded.push(new Request(request, init)); return new Response('{}') } } })
  const initialProvider = provider(); await first.config({ provider: { fixture: initialProvider }, model: 'fixture/model' })
  const model = { providerID: 'fixture', modelID: 'model' }, prompt = { sessionID: 'session', model }, message = { id: 'turn', model }
  await first['chat.message'](prompt, { message, parts: [{ type: 'text', text: 'Original' }] }); history.push({ info: { ...message, role: 'user', sessionID: 'session', time: { created: 1700000000000 } }, parts: [{ type: 'text', text: 'Original' }] }); await completion
  await first['experimental.chat.messages.transform']({}, { messages: history }); await first['chat.params']({ ...prompt, message, model: { ...model, api: { npm: '@ai-sdk/openai-compatible' } }, provider: { id: 'fixture', options: initialProvider.options } })
  const firstHeaders: Record<string, string> = {}; await first['chat.headers']({ ...prompt, message }, { headers: firstHeaders })
  await initialProvider.options.fetch('https://provider.invalid', { method: 'POST', headers: firstHeaders, body: JSON.stringify({ messages: [{ role: 'user', content: 'Original' }] }) }); await first.dispose()
  const empty = JSON.stringify({ hooks: {} }), digest = createHash('sha256').update(empty).digest('hex')
  await writeFile(f.options.sources[0]!.path, empty)
  const options = { ...f.options, reviewedDigests: Object.fromEntries(f.options.sources.map(row => [row.id, digest])) }, cold = await createHarnessHooks(input, options, { report: () => {}, dispatchDiagnostic: () => {}, backgroundDiagnostic: () => {} })
  t.after(() => cold.dispose())
  const coldProvider = provider(); await cold.config({ provider: { fixture: coldProvider }, model: 'fixture/model' })
  const next = { id: 'next', model }; await cold['chat.message'](prompt, { message: next, parts: [{ type: 'text', text: 'Next real prompt' }] })
  history.push({ info: { ...next, role: 'user', sessionID: 'session', time: { created: 1700000001000 } }, parts: [{ type: 'text', text: 'Next real prompt' }] })
  await cold['experimental.chat.messages.transform']({}, { messages: history }); await cold['chat.params']({ ...prompt, message: next, model: { ...model, api: { npm: '@ai-sdk/openai-compatible' } }, provider: { id: 'fixture', options: coldProvider.options } })
  const headers: Record<string, string> = {}; await cold['chat.headers']({ ...prompt, message: next }, { headers })
  await coldProvider.options.fetch('https://provider.invalid', { method: 'POST', headers, body: JSON.stringify({ messages: [{ role: 'user', content: 'Original' }, { role: 'user', content: 'Next real prompt' }] }) })
  const initial = await forwarded[0]!.json(), replay = await forwarded[1]!.json()
  assert.deepEqual(replay.messages, [...initial.messages, { role: 'user', content: 'Next real prompt' }]); assert.equal((await readFile(f.capture, 'utf8')).trim().split('\n').length, 2)
})

for (const custom of [false, true]) test(`cold UI-only output retries on a real prompt after source deselection without a model request, custom executor ${custom}`, { timeout: 10000 }, async t => {
  const f = await fixture(t), history: unknown[] = []
  await writeFile(join(f.directory, 'hook.cjs'), `const fs=require('node:fs');const input=JSON.parse(fs.readFileSync(0,'utf8'));fs.appendFileSync(${JSON.stringify(f.capture)},JSON.stringify(input)+'\\n');process.stdout.write('{"systemMessage":"UI_ONLY_REPLAY"}');`)
  const codex = f.options.sources.find(row => row.dialect === 'codex')!, options = { ...f.options, sources: [codex], reviewedDigests: { codex: f.options.reviewedDigests.codex! } }
  let missing!: () => void; const unavailable = new Promise<void>(resolve => { missing = resolve })
  const input = { directory: f.directory, client: { session: { get: async () => ({ data: { id: 'session' } }), messages: async () => ({ data: history }) } } }
  const first = await createHarnessHooks(input, options, { report: () => {}, dispatchDiagnostic: () => {}, backgroundDiagnostic: row => { if (row.code === 'HOST_BACKGROUND_UI_UNAVAILABLE') missing() } })
  t.after(() => first.dispose())
  const model = { providerID: 'fixture', modelID: 'model' }, prompt = { sessionID: 'session', model }
  await first.config({ provider: { fixture: { options: {} } }, model: 'fixture/model' }); await first['chat.message'](prompt, { message: { id: 'turn', model }, parts: [{ type: 'text', text: 'Original' }] })
  history.push({ info: { id: 'turn', model, role: 'user', sessionID: 'session', time: { created: 1700000000000 } }, parts: [{ type: 'text', text: 'Original' }] })
  await unavailable; await first.dispose()
  const empty = JSON.stringify({ hooks: {} }), digest = createHash('sha256').update(empty).digest('hex'); await writeFile(codex.path, empty)
  const warnings: string[] = []; let warned!: () => void; const delivered = new Promise<void>(resolve => { warned = resolve })
  const cold = await createHarnessHooks({ ...input, client: { ...input.client, tui: { showToast: async request => { warnings.push(request.body.message); warned(); return { data: true } } } } }, { ...options, reviewedDigests: { codex: digest } }, { report: () => {}, dispatchDiagnostic: () => {}, backgroundDiagnostic: () => {}, ...(custom ? { host: { environment: process.env, background: { supportsRewake: true, enqueue: () => { throw new Error('Deselected commands must not execute') } } } } : {}) })
  t.after(() => cold.dispose()); await cold.config({ provider: { fixture: { options: {} } }, model: 'fixture/model' })
  await cold['chat.message'](prompt, { message: { id: 'next', model }, parts: [{ type: 'text', text: 'Next real prompt' }] }); assert.deepEqual(warnings, ['UI_ONLY_REPLAY']); await delivered
  assert.deepEqual(warnings, ['UI_ONLY_REPLAY']); assert.equal(cold.inspect().backgroundProjection.tickets, 0)
  assert.equal((await readFile(f.capture, 'utf8')).trim().split('\n').length, 1)
})

test('tool-only async sources use their own model pipeline and preserve the durable tool result', { timeout: 10000 }, async t => {
  const f = await fixture(t), command = quote(process.execPath) + ' ' + quote(join(f.directory, 'hook.cjs')), source = JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command, async: true }] }] } })
  await writeFile(f.options.sources[0]!.path, source)
  const selected = f.options.sources.find(row => row.dialect === 'claude-code')!, options = { ...f.options, sources: [selected], reviewedDigests: { 'claude-code': createHash('sha256').update(source).digest('hex') } }
  const history: unknown[] = [], forwarded: Request[] = []; let ready!: () => void; const completion = new Promise<void>(resolve => { ready = resolve })
  const hooks = await createHarnessHooks({ directory: f.directory, client: { session: { get: async () => ({ data: { id: 'session' } }), messages: async () => ({ data: history }) } } }, options, { report: () => {}, dispatchDiagnostic: () => {}, tools: { diagnostic: () => {} }, backgroundDiagnostic: row => { if (row.code === 'HOST_BACKGROUND_RETAINED') ready() } })
  t.after(() => hooks.dispose())
  const provider = { options: { fetch: async (request: RequestInfo | URL, init?: RequestInit) => { forwarded.push(new Request(request, init)); return new Response('{}') } } }, model = { providerID: 'fixture', modelID: 'model' }, message = { id: 'turn', model }, prompt = { sessionID: 'session', model }
  await hooks.config({ provider: { fixture: provider }, model: 'fixture/model' }); await hooks['chat.message'](prompt, { message, parts: [{ type: 'text', text: 'Original' }] })
  history.push({ info: { ...message, role: 'user', sessionID: 'session', time: { created: 1700000000000 } }, parts: [{ type: 'text', text: 'Original' }] })
  const send = async (messages: unknown[]) => {
    await hooks['experimental.chat.messages.transform']({}, { messages: history }); await hooks['chat.params']({ ...prompt, message, model: { ...model, api: { npm: '@ai-sdk/openai-compatible' } }, provider: { id: 'fixture', options: provider.options } })
    const headers: Record<string, string> = {}; await hooks['chat.headers']({ ...prompt, message }, { headers })
    assert.equal(headers[PROMPT_REQUEST_HEADER], undefined); assert.equal(typeof headers[BACKGROUND_REQUEST_HEADER], 'string')
    await provider.options.fetch('https://provider.invalid', { method: 'POST', headers, body: JSON.stringify({ messages }) })
  }
  await send([{ role: 'user', content: 'Original' }])
  const part = { type: 'tool', tool: 'bash', callID: 'call', state: { status: 'running', input: { command: 'true' }, output: 'Original result', time: { start: 1700000000002, end: 1700000000003 } } }
  history.push({ info: { id: 'answer', parentID: 'turn', sessionID: 'session', role: 'assistant', modelID: 'model', time: { created: 1700000000001 } }, parts: [part] })
  const input = { sessionID: 'session', tool: 'bash', callID: 'call' }, args = { command: 'true' }
  await hooks['tool.execute.before'](input, { args }); const output = { title: 'Tool result', output: 'Original result', metadata: { exit: 0 } }; await hooks['tool.execute.after']({ ...input, args }, output)
  part.state.status = 'completed'; await completion
  assert.equal(output.output, 'Original result'); assert.deepEqual(args, { command: 'true' })
  await send([{ role: 'user', content: 'Original' }, { role: 'assistant', tool_calls: [{ id: 'call' }] }, { role: 'tool', tool_call_id: 'call', content: 'Original result' }])
  const actual = await forwarded[1]!.json(); assert.equal(actual.messages[2].content, 'Original result\n\n<system-reminder>\nBACKGROUND_WARNING\n</system-reminder>\n\n<system-reminder>\nBACKGROUND_CONTEXT\n</system-reminder>'); assert.equal(part.state.output, 'Original result')
})

for (const mode of ['disabled', 'native-skip'] as const) test(`${mode} async registrations cannot grant command execution or background transport`, { timeout: 10000 }, async t => {
  const f = await fixture(t), command = quote(process.execPath) + ' ' + quote(join(f.directory, 'hook.cjs')), source = JSON.stringify({ ...(mode === 'disabled' ? { disableAllHooks: true } : {}), hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command, async: true, ...(mode === 'native-skip' ? { if: 'true' } : {}) }] }] } })
  const selected = f.options.sources.find(row => row.dialect === 'claude-code')!; await writeFile(selected.path, source)
  const history: unknown[] = [], hooks = await createHarnessHooks({ directory: f.directory, client: { session: { get: async () => ({ data: { id: 'session' } }), messages: async () => ({ data: history }) } } }, { ...f.options, sources: [selected], reviewedDigests: { 'claude-code': createHash('sha256').update(source).digest('hex') } }, { report: () => {}, dispatchDiagnostic: () => {}, backgroundDiagnostic: () => {} })
  t.after(() => hooks.dispose())
  const provider = { options: {} }, model = { providerID: 'fixture', modelID: 'model' }, message = { id: 'turn', model }, prompt = { sessionID: 'session', model }
  await hooks.config({ provider: { fixture: provider }, model: 'fixture/model' }); await hooks['chat.message'](prompt, { message, parts: [{ type: 'text', text: 'Original' }] })
  history.push({ info: { ...message, role: 'user', sessionID: 'session', time: { created: 1700000000000 } }, parts: [{ type: 'text', text: 'Original' }] })
  await hooks['experimental.chat.messages.transform']({}, { messages: history }); await hooks['chat.params']({ ...prompt, message, model: { ...model, api: { npm: '@ai-sdk/openai-compatible' } }, provider: { id: 'fixture', options: provider.options } })
  const headers: Record<string, string> = {}; await hooks['chat.headers']({ ...prompt, message }, { headers })
  assert.equal(headers[BACKGROUND_REQUEST_HEADER], undefined); assert.equal(hooks.inspect().background!.jobs, 0); await assert.rejects(readFile(f.capture), { code: 'ENOENT' })
})

test('default session deletion cancels an actual running background child and clears delivery ownership', { timeout: 5000 }, async t => {
  const f = await fixture(t), started = join(f.directory, 'started')
  await writeFile(join(f.directory, 'hook.cjs'), `require('node:fs').writeFileSync(${JSON.stringify(started)},String(process.pid));setInterval(()=>{},10000);`)
  let ready!: (pid: number) => void; const running = new Promise<number>(resolve => { ready = resolve })
  const watcher = watch(f.directory, (_type, name) => { if (String(name) === 'started') void readFile(started, 'utf8').then(text => { const pid = Number(text); if (pid > 1) ready(pid) }, () => {}) }); t.after(() => watcher.close())
  const hooks = await createHarnessHooks({ directory: f.directory, client: { session: { get: async () => ({ data: { id: 'session' } }), messages: async () => ({ data: [] }) } } }, { ...f.options, sources: f.options.sources.filter(row => row.dialect === 'claude-code') }, { report: () => {}, dispatchDiagnostic: () => {}, backgroundDiagnostic: () => {} })
  t.after(() => hooks.dispose()); await hooks.config({ provider: { fixture: { options: {} } }, model: 'fixture/model' })
  await hooks['chat.message']({ sessionID: 'session', model: { providerID: 'fixture', modelID: 'model' } }, { message: { id: 'turn' }, parts: [{ type: 'text', text: 'Original' }] })
  const pid = await running; await hooks.event({ event: { type: 'session.deleted', properties: { sessionID: 'session' } } })
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }); assert.equal(hooks.inspect().background!.jobs, 0); assert.equal(hooks.inspect().backgroundProjection.tickets, 0); assert.equal(hooks.inspect().backgroundRecords.records, 0); assert.equal(hooks.inspect().cleanup.failedSessions, 0)
})
