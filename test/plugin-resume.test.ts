import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createHarnessHooks } from '../src/hosts/plugin-v1.js'

const CREATED = Date.parse('2026-01-01T12:00:00Z')
const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'"
test('a Codex startup-only source captures original tool input for later model history', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'v1-startup-originals-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const capture = join(directory, 'capture.json'), script = join(directory, 'hook.cjs')
  await writeFile(script, `const fs=require('node:fs');const p=JSON.parse(fs.readFileSync(0,'utf8'));fs.writeFileSync(${JSON.stringify(capture)},JSON.stringify(p));console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'SessionStart',additionalContext:'START'}}))`)
  const source = JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: quote(process.execPath) + ' ' + quote(script) }] }] } })
  await writeFile(join(directory, 'hooks.json'), source)
  let messages: unknown[] = []
  const hooks = await createHarnessHooks({ directory, client: { session: { get: async () => ({ data: { id: 'session' } }), messages: async () => ({ data: messages }) } } }, { sources: [{ id: 'codex', dialect: 'codex', path: 'hooks.json' }], reviewedDigests: { codex: createHash('sha256').update(source).digest('hex') }, permissionMode: 'default' }, { host: { environment: { PATH: process.env.PATH, HOME: directory, XDG_STATE_HOME: join(directory, 'state') } }, report: () => {}, dispatchDiagnostic: () => {} })
  t.after(() => hooks.dispose())
  const provider = { options: {} }, model = { modelID: 'model', providerID: 'fixture', api: { npm: '@ai-sdk/openai-compatible' } }, message = { id: 'turn', agent: 'build', model }, prompt = { sessionID: 'session', agent: 'build', model, message }
  await hooks.config({ model: 'fixture/model', provider: { fixture: provider } })
  await hooks.event({ event: { type: 'session.created', properties: { info: { id: 'session' } } } })
  await hooks['chat.message'](prompt, { message, parts: [{ type: 'text', text: 'Original user' }] })
  messages = [{ info: { ...message, sessionID: 'session', role: 'user', time: { created: CREATED } }, parts: [{ type: 'text', text: 'Original user' }] }]
  await hooks['experimental.chat.messages.transform']({}, { messages })
  await hooks['chat.params']({ ...prompt, provider: { id: 'fixture', options: provider.options } })
  await hooks['chat.headers'](prompt, { headers: {} })
  await hooks['tool.execute.before']({ sessionID: 'session', callID: 'call', tool: 'bash' }, { args: { command: 'original' } })
  messages.push({ info: { id: 'answer', parentID: 'turn', sessionID: 'session', role: 'assistant', modelID: 'model', time: { created: CREATED + 1 } }, parts: [{ type: 'tool', tool: 'bash', callID: 'call', state: { status: 'running', input: { command: 'effective' }, time: { start: CREATED + 2 } } }] })
  await hooks['chat.headers'](prompt, { headers: {} })
  const payload = JSON.parse(await readFile(capture, 'utf8')), text = await readFile(payload.transcript_path, 'utf8')
  const call = text.trim().split('\n').map(line => JSON.parse(line)).find(row => row.payload.type === 'function_call')
  assert.ok(call, 'the startup journal must include the observed tool call')
  assert.deepEqual(JSON.parse(call.payload.arguments), { cmd: 'original' })
})

test('default V1 cold resume retains original rewritten input, native records and mixed historical context', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'v1-cold-resume-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const capture = join(directory, 'events.jsonl'), script = join(directory, 'hook.cjs')
  await writeFile(script, `const fs=require('node:fs');const p=JSON.parse(fs.readFileSync(0,'utf8'));const dialect=process.argv[2];fs.appendFileSync(${JSON.stringify(capture)},JSON.stringify({dialect,...p})+'\\n');if(p.hook_event_name==='PreToolUse'){if(dialect==='codex'&&p.tool_input.command==='original')console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'allow',updatedInput:{command:'effective'}}}));}else console.log(JSON.stringify({hookSpecificOutput:{hookEventName:p.hook_event_name,additionalContext:dialect+':'+p.hook_event_name+':'+(p.source||p.prompt)}}));`)
  const sources: { id: string; dialect: string; path: string }[] = [], reviewedDigests: Record<string, string> = {}
  for (const dialect of ['claude-code', 'codex']) {
    const source = JSON.stringify({ hooks: Object.fromEntries(['SessionStart', 'UserPromptSubmit', 'PreToolUse'].map(event => [event, [{ ...(event === 'PreToolUse' ? { matcher: 'Bash' } : {}), hooks: [{ type: 'command', command: quote(process.execPath) + ' ' + quote(script) + ' ' + quote(dialect) }] }]])) })
    const path = dialect + '.json'; await writeFile(join(directory, path), source)
    sources.push({ id: dialect, dialect, path }); reviewedDigests[dialect] = createHash('sha256').update(source).digest('hex')
  }
  let messages: any[] = []
  const forwarded: Request[] = [], instances: Awaited<ReturnType<typeof createHarnessHooks>>[] = []
  t.after(async () => { for (const hooks of instances) await hooks.dispose() })
  const services = { host: { environment: { PATH: process.env.PATH, HOME: directory, XDG_STATE_HOME: join(directory, 'state') } }, report: () => {}, dispatchDiagnostic: () => {} }
  const make = async (selected = false) => {
    const hooks = await createHarnessHooks({ directory, client: { session: { get: async () => ({ data: { id: 'session' } }), messages: async () => ({ data: messages }) } } }, { sources: sources.map(source => selected ? { ...source, selection: { events: ['SessionStart', 'UserPromptSubmit'] } } : source), reviewedDigests, permissionMode: 'default' }, services)
    instances.push(hooks)
    const config = { model: 'fixture/model', shell: '/bin/bash', provider: { fixture: { options: { fetch: async (input: RequestInfo | URL, init?: RequestInit) => { forwarded.push(new Request(input, init)); return new Response('{}') } } } } }
    await hooks.config(config)
    return { hooks, config }
  }
  const prompt = (id: string) => { const model = { modelID: 'model', providerID: 'fixture', api: { npm: '@ai-sdk/openai-compatible' } }; return { sessionID: 'session', agent: 'build', model, message: { id, agent: 'build', model } } }
  const user = (id: string, text: string, created: number) => ({ info: { id, role: 'user', sessionID: 'session', time: { created } }, parts: [{ type: 'text', text }] })
  const model = async (f: Awaited<ReturnType<typeof make>>, id: string, rows: unknown[]) => {
    const input = prompt(id)
    await f.hooks['experimental.chat.messages.transform']({}, { messages })
    await f.hooks['chat.params']({ ...input, provider: { id: 'fixture', options: f.config.provider.fixture.options } })
    const headers: Record<string, string> = {}; await f.hooks['chat.headers'](input, { headers })
    await f.config.provider.fixture.options.fetch('https://provider.invalid/v1/chat/completions', { method: 'POST', headers, body: JSON.stringify({ messages: rows }) })
  }
  const first = await make()
  await first.hooks.event({ event: { type: 'session.created', properties: { info: { id: 'session' } } } })
  await first.hooks['chat.message'](prompt('first'), { message: prompt('first').message, parts: [{ type: 'text', text: 'First' }] })
  messages = [user('first', 'First', CREATED)]
  await model(first, 'first', [{ role: 'user', content: 'First' }])
  const initialBody = await forwarded[0]!.clone().json()
  messages.push({ info: { id: 'answer', parentID: 'first', sessionID: 'session', role: 'assistant', modelID: 'model', time: { created: CREATED + 1 } }, parts: [{ type: 'tool', tool: 'bash', callID: 'call', state: { status: 'running', input: { command: 'original' }, time: { start: CREATED + 2 } } }] })
  const args = { command: 'original' }, call = { sessionID: 'session', callID: 'call', tool: 'bash' }
  await first.hooks['tool.execute.before'](call, { args })
  assert.equal(args.command, 'effective', JSON.stringify((await readFile(capture, 'utf8')).trim().split('\n').map(line => { const row = JSON.parse(line); return { dialect: row.dialect, event: row.hook_event_name, name: row.tool_name, input: row.tool_input } })))
  messages[1].parts[0].state.input = { ...args }
  await first.hooks['tool.execute.after']({ ...call, args }, { title: 'Result', output: 'Tool result', metadata: { exit: 0 } })
  messages[1].parts[0].state = { ...messages[1].parts[0].state, status: 'completed', output: 'Tool result', time: { start: CREATED + 2, end: CREATED + 3 } }
  await model(first, 'first', [{ role: 'user', content: 'First' }])
  const events = async () => (await readFile(capture, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  const initial = await events(), nativeBefore: Record<string, string> = {}
  for (const dialect of ['claude-code', 'codex']) nativeBefore[dialect] = await readFile(initial.find(row => row.dialect === dialect && row.hook_event_name === 'SessionStart').transcript_path, 'utf8')
  await first.hooks.dispose()
  const second = await make(true)
  await second.hooks['chat.message'](prompt('second'), { message: prompt('second').message, parts: [{ type: 'text', text: 'Second' }] })
  const resumed = (await events()).filter(row => row.hook_event_name === 'SessionStart' && row.source === 'resume')
  assert.equal(resumed.length, 2)
  for (const row of resumed) {
    const text = await readFile(row.transcript_path, 'utf8')
    assert.ok(text.startsWith(nativeBefore[row.dialect]!))
    const records = text.trim().split('\n').map(line => JSON.parse(line))
    if (row.dialect === 'codex') assert.deepEqual(JSON.parse(records.find(record => record.payload.type === 'function_call').payload.arguments), { cmd: 'original' })
    else assert.deepEqual(records.find(record => record.type === 'assistant').message.content.find((part: any) => part.type === 'tool_use').input, { command: 'original' })
  }
  messages.push(user('second', 'Second', CREATED + 4))
  await model(second, 'second', [{ role: 'user', content: 'First' }, { role: 'assistant', content: 'Earlier' }, { role: 'user', content: 'Second' }])
  const body = await forwarded.at(-1)!.json()
  assert.deepEqual(body.messages.slice(0, initialBody.messages.length), initialBody.messages)
  const all = await events()
  for (const dialect of ['claude-code', 'codex']) assert.equal(all.filter(row => row.dialect === dialect && row.hook_event_name === 'UserPromptSubmit' && row.prompt === 'First').length, 1)
  await second.hooks.event({ event: { type: 'session.deleted', properties: { info: { id: 'session' } } } })
  await second.hooks.dispose()
  const deleted = await make(true)
  await assert.rejects(deleted.hooks['chat.message'](prompt('third'), { message: prompt('third').message, parts: [{ type: 'text', text: 'Third' }] }), { code: 'SESSION_STORE_DELETED' })
})

for (const dialect of ['claude-code', 'codex'] as const) for (const admission of ['blocked', 'unsaved'] as const) test(`cold resume binds retained startup context after a ${admission} first prompt (${dialect})`, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'v1-unbound-startup-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const script = join(directory, 'hook.cjs')
  await writeFile(script, `const fs=require('node:fs');const p=JSON.parse(fs.readFileSync(0,'utf8'));if(p.hook_event_name==='SessionStart')console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'SessionStart',additionalContext:p.source==='startup'?'ORIGINAL_STARTUP':'RESUME_STARTUP'}}));else if(p.prompt==='Blocked'){console.error('Blocked');process.exit(2)}else if(p.prompt==='Unsaved')console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'UserPromptSubmit',additionalContext:'UNSAVED_PROMPT_CONTEXT'}}))`)
  const source = JSON.stringify({ hooks: Object.fromEntries(['SessionStart', 'UserPromptSubmit'].map(event => [event, [{ hooks: [{ type: 'command', command: quote(process.execPath) + ' ' + quote(script) }] }]])) })
  await writeFile(join(directory, 'hooks.json'), source)
  const instances: Awaited<ReturnType<typeof createHarnessHooks>>[] = [], forwarded: Request[] = []
  let messages: unknown[] = []
  t.after(async () => { for (const hooks of instances) await hooks.dispose() })
  const make = async () => {
    const hooks = await createHarnessHooks({ directory, client: { session: { get: async () => ({ data: { id: 'session' } }), messages: async () => ({ data: messages }) } } }, { sources: [{ id: dialect, dialect, path: 'hooks.json' }], reviewedDigests: { [dialect]: createHash('sha256').update(source).digest('hex') }, permissionMode: 'default' }, { host: { environment: { PATH: process.env.PATH, HOME: directory, XDG_STATE_HOME: join(directory, 'state') } }, report: () => {}, promptDiagnostic: () => {}, dispatchDiagnostic: () => {} })
    instances.push(hooks)
    const provider = { options: { fetch: async (input: RequestInfo | URL, init?: RequestInit) => { forwarded.push(new Request(input, init)); return new Response('{}') } } }
    await hooks.config({ model: 'fixture/model', shell: '/bin/bash', provider: { fixture: provider } })
    return { hooks, provider }
  }
  const model = { modelID: 'model', providerID: 'fixture', api: { npm: '@ai-sdk/openai-compatible' } }, prompt = { sessionID: 'session', agent: 'build', model }
  const first = await make()
  await first.hooks.event({ event: { type: 'session.created', properties: { info: { id: 'session' } } } })
  if (admission === 'blocked') await assert.rejects(first.hooks['chat.message'](prompt, { message: { id: 'blocked', agent: 'build', model }, parts: [{ type: 'text', text: 'Blocked' }] }), { code: 'HOOK_PROMPT_BLOCKED' })
  else await first.hooks['chat.message'](prompt, { message: { id: 'unsaved', agent: 'build', model }, parts: [{ type: 'text', text: 'Unsaved' }] })
  await first.hooks.dispose()
  const second = await make(), message = { id: 'accepted', agent: 'build', model }
  await second.hooks['chat.message'](prompt, { message, parts: [{ type: 'text', text: 'Accepted' }] })
  messages = [{ info: { ...message, sessionID: 'session', role: 'user', time: { created: CREATED } }, parts: [{ type: 'text', text: 'Accepted' }] }]
  await second.hooks['experimental.chat.messages.transform']({}, { messages })
  await second.hooks['chat.params']({ ...prompt, message, provider: { id: 'fixture', options: second.provider.options } })
  const headers: Record<string, string> = {}; await second.hooks['chat.headers']({ ...prompt, message }, { headers })
  await second.provider.options.fetch('https://provider.invalid/v1/chat/completions', { method: 'POST', headers, body: JSON.stringify({ messages: [{ role: 'user', content: 'Accepted' }] }) })
  const text = JSON.stringify(await forwarded[0]!.json())
  for (const marker of ['ORIGINAL_STARTUP', 'RESUME_STARTUP']) assert.equal(text.split(marker).length - 1, 1)
  assert.ok(text.indexOf('ORIGINAL_STARTUP') < text.indexOf('RESUME_STARTUP'))
  assert.ok(!text.includes('UNSAVED_PROMPT_CONTEXT'))
})
