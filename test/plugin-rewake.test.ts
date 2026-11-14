import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { createHarnessHooks } from './helpers/isolated-v1.js'

const quote = (text: string) => "'" + text.replaceAll("'", "'\"'\"'") + "'"
for (const mixed of [false, true]) test(`the assembled default plugin preserves owned idle notification context and cold replay, mixed callbacks ${mixed}`, { timeout: 10000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'plugin-rewake-')), sourcePath = join(directory, 'hooks.json'), helper = join(directory, 'hook.cjs'), capture = join(directory, 'source.jsonl'), release = join(directory, 'release')
  t.after(() => rm(directory, { recursive: true, force: true }))
  await writeFile(helper, `const fs=require('node:fs');const p=JSON.parse(fs.readFileSync(0,'utf8'));if(process.argv[2]==='wake'){if(p.prompt!=='GENUINE')return;const finish=()=>{fs.writeSync(2,'WAKE');process.exit(2)};if(fs.existsSync(${JSON.stringify(release)}))finish();else{const w=fs.watch(${JSON.stringify(directory)},()=>{if(fs.existsSync(${JSON.stringify(release)})){w.close();finish()}})}return}fs.appendFileSync(${JSON.stringify(capture)},JSON.stringify({prompt:p.prompt,promptID:p.prompt_id??p.turn_id,dialect:process.argv[2],transcript:fs.existsSync(p.transcript_path)?fs.readFileSync(p.transcript_path,'utf8'):null})+'\\n');process.stdout.write(JSON.stringify({...(process.argv[2]==='record'&&p.prompt!=='GENUINE'?{systemMessage:'CALLBACK_UI'}:{}),hookSpecificOutput:{hookEventName:'UserPromptSubmit',additionalContext:p.prompt==='GENUINE'?'GENUINE_CONTEXT':'CALLBACK_CONTEXT'}}));`)
  const command = [process.execPath, helper].map(quote).join(' '), source = JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: command + ' record' }, { type: 'command', command: command + ' wake', asyncRewake: true, timeout: 5 }] }] } })
  await writeFile(sourcePath, source)
  const codexPath = join(directory, 'codex-hooks.json'), codex = JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: command + ' codex' }] }] } })
  await writeFile(codexPath, codex)
  const history: unknown[] = [], forwarded: Request[] = [], requests: unknown[] = [], diagnostics: unknown[] = [], warnings: string[] = []
  let retained!: () => void; const received = new Promise<void>(resolve => { retained = resolve })
  const provider = { options: { fetch: async (input: RequestInfo | URL, init?: RequestInit) => { forwarded.push(new Request(input, init)); return new Response('{}') } } }, model = { providerID: 'fixture', modelID: 'model' }, genuine = { id: 'turn', sessionID: 'session', role: 'user', agent: 'build', model, time: { created: 1700000000000 } }
  const transport = provider.options.fetch
  let hooks!: Awaited<ReturnType<typeof createHarnessHooks>>
  const send = async (message: typeof genuine) => {
    await hooks['experimental.chat.messages.transform']({}, { messages: history })
    await hooks['chat.params']({ sessionID: 'session', model: { ...model, api: { npm: '@ai-sdk/openai-compatible' } }, message, provider: { id: 'fixture', options: provider.options } })
    const headers: Record<string, string> = {}; await hooks['chat.headers']({ sessionID: 'session', model, message }, { headers })
    const messages = history.map(raw => { const row = raw as { info: { role: string }; parts: { text: string }[] }; return { role: row.info.role, content: row.parts.map(part => part.text).join('') } })
    await provider.options.fetch('https://provider.invalid', { method: 'POST', headers, body: JSON.stringify({ messages }) })
  }
  hooks = await createHarnessHooks({ directory, client: { session: {
    get: async () => ({ data: { id: 'session' } }), messages: async () => ({ data: history }),
    prompt: async request => {
      requests.push(request.body)
      const info = { ...genuine, id: 'system', time: { created: 1700000000002 } }, parts = request.body.parts.map(part => ({ ...part, id: 'system-part' }))
      await hooks['chat.message']({ sessionID: 'session', model }, { message: info, parts })
      const index = history.findIndex(raw => (raw as { info: { id: string } }).info.id === info.id), row = { info, parts }
      if (index < 0) history.push(row); else history[index] = row
      if (request.body.noReply) return { data: row }
      await send(info); return { data: { info: { role: 'assistant' }, parts: [{ type: 'text', text: 'WAKE_DONE' }] } }
    },
  }, tui: { showToast: async request => { warnings.push(request.body.message); return { data: true } } } } }, { sources: [{ id: 'claude', dialect: 'claude-code', path: sourcePath }, ...(mixed ? [{ id: 'codex', dialect: 'codex', path: codexPath }] : [])], reviewedDigests: { claude: createHash('sha256').update(source).digest('hex'), ...(mixed ? { codex: createHash('sha256').update(codex).digest('hex') } : {}) }, permissionMode: 'default' }, { report: () => {}, dispatchDiagnostic: () => {}, backgroundDiagnostic: row => { diagnostics.push(row); if (row.code === 'HOST_WAKE_RETAINED') retained() } })
  t.after(() => hooks.dispose())
  await hooks.config({ provider: { fixture: provider }, model: 'fixture/model' })
  await hooks['chat.message']({ sessionID: 'session', model }, { message: genuine, parts: [{ type: 'text', text: 'GENUINE' }] })
  history.push({ info: genuine, parts: [{ type: 'text', text: 'GENUINE' }] }); await send(genuine)
  history.push({ info: { id: 'answer', sessionID: 'session', role: 'assistant', parentID: 'turn', modelID: 'model', time: { created: 1700000000001 } }, parts: [{ type: 'text', text: 'FIRST_DONE' }] })
  await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'session' } } }); await writeFile(release, 'release'); await received
  await hooks.settleWake('session')
  assert.equal(requests.length, 2, JSON.stringify(diagnostics)); assert.equal(forwarded.length, 2); assert.deepEqual(warnings, ['CALLBACK_UI'])
  const body = await forwarded[1]!.json(), last = body.messages.findLast((row: { role: string }) => row.role === 'user')
  assert.equal(JSON.stringify(body).includes('CALLBACK_UI'), false)
  assert.equal(last.role, 'user'); assert.ok(last.content.some((part: { text: string }) => part.text.includes('NOT USER INPUT')))
  assert.ok(last.content.some((part: { text: string }) => part.text.includes('CALLBACK_CONTEXT')))
  assert.equal(body.messages[0].content[0].text.includes('GENUINE_CONTEXT'), true)
  assert.equal([...forwarded[1]!.headers.keys()].some(key => key.startsWith('x-opencode-harness-')), false)
  const sourceRows = (await readFile(capture, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  const claudeRows = sourceRows.filter(row => row.dialect === 'record'), codexRows = sourceRows.filter(row => row.dialect === 'codex')
  assert.equal(sourceRows.length, mixed ? 4 : 2); assert.equal(claudeRows[0].promptID, 'turn'); assert.equal(claudeRows[1].promptID, 'system'); assert.ok(claudeRows[1].transcript.includes('FIRST_DONE'))
  if (mixed) { assert.equal(codexRows.length, 2); assert.ok(codexRows.every(row => row.transcript !== null)); assert.notEqual(codexRows[0].promptID, codexRows[1].promptID); assert.ok(body.messages.some((row: { role: string; content: unknown }) => row.role === 'developer' && row.content === 'CALLBACK_CONTEXT')) }
  assert.equal(hooks.inspect().prompts.prompts, 1); assert.equal(hooks.inspect().wakeInputs.inputs, 1)
  await hooks.dispose()
  const empty = JSON.stringify({ hooks: {} }); await writeFile(sourcePath, empty)
  hooks = await createHarnessHooks({ directory, client: { session: { get: async () => ({ data: { id: 'session' } }), messages: async () => ({ data: history }), prompt: async () => { throw new Error('Deselected source must not resume') } } } }, { sources: [{ id: 'claude', dialect: 'claude-code', path: sourcePath }], reviewedDigests: { claude: createHash('sha256').update(empty).digest('hex') } }, { report: () => {}, dispatchDiagnostic: () => {}, backgroundDiagnostic: row => { diagnostics.push(row) } })
  provider.options.fetch = transport; await hooks.config({ provider: { fixture: provider }, model: 'fixture/model' })
  const next = { ...genuine, id: 'future', time: { created: 1700000000003 } }
  await hooks['chat.message']({ sessionID: 'session', model }, { message: next, parts: [{ type: 'text', text: 'FUTURE_GENUINE' }] })
  history.push({ info: next, parts: [{ type: 'text', text: 'FUTURE_GENUINE' }] }); await send(next)
  assert.deepEqual((await forwarded[2]!.json()).messages, [...body.messages, { role: 'user', content: 'FUTURE_GENUINE' }])
  assert.equal((await readFile(capture, 'utf8')).trim().split('\n').length, mixed ? 4 : 2); assert.equal(requests.length, 2)
  assert.equal(hooks.inspect().prompts.prompts, 2); assert.equal(hooks.inspect().wakeInputs.inputs, 1)
})
