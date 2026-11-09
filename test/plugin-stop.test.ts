import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import plugin from '../src/index.js'

const CREATED = Date.parse('2026-01-01T00:00:00Z')
type Callback = (event: any) => Promise<void>
async function fixture(t: { after: (callback: () => Promise<void>) => void }, mode = 'continue', repeats = 1) {
  const directory = await mkdtemp(join(tmpdir(), 'harness-plugin-stop-'))
  const capture = join(directory, 'calls.jsonl'), script = join(directory, 'hook.cjs'), path = join(directory, 'hooks.json')
  const source = `const fs=require('node:fs');const p=JSON.parse(fs.readFileSync(0,'utf8'));const rows=fs.readFileSync(p.transcript_path,'utf8').trim().split('\\n').map(JSON.parse);fs.appendFileSync(${JSON.stringify(capture)},JSON.stringify({input:p,rows})+'\\n');if(${JSON.stringify(mode)}==='prevent')console.log(JSON.stringify({continue:false,stopReason:'Stopped'}));else if(${JSON.stringify(mode)}==='warning')console.log(JSON.stringify({systemMessage:'Warning'}));else if(!p.stop_hook_active)console.log(JSON.stringify({decision:'block',reason:'Feedback',hookSpecificOutput:{hookEventName:'Stop',additionalContext:'Context'}}));`
  await writeFile(script, source)
  const native = JSON.stringify({ hooks: { Stop: [{ hooks: Array.from({ length: repeats }, () => ({ type: 'command', command: process.execPath, args: [script] })) }] } })
  await writeFile(path, native)
  const callbacks = new Map<string, Callback>()
  const hook = (domain: string) => async (name: string, callback: Callback) => { const key = domain + '.' + name; callbacks.set(key, callback); return { dispose: () => { callbacks.delete(key) } } }
  const records: any[] = [], queued: any[] = []
  let enqueue: ((input: any) => Promise<any>) | undefined
  const context = {
    app: { version: '2.2.5' }, location: { directory },
    options: { sources: [{ id: 'claude', dialect: 'claude-code', path }], reviewedDigests: { claude: createHash('sha256').update(native).digest('hex') }, permissionMode: 'default' },
    model: { list: async () => ({ data: [{ id: 'fixture', providerID: 'fixture', package: '@opencode/ai/providers/openai-compatible' }] }) },
    session: {
      hook: hook('session'),
      get: async ({ sessionID }: { sessionID: string }) => { assert.equal(sessionID, 'session'); return { id: sessionID, model: { id: 'fixture', providerID: 'fixture' } } },
      context: async ({ sessionID }: { sessionID: string }) => { assert.equal(sessionID, 'session'); return structuredClone(records) },
      synthetic: async (input: any) => {
        assert.equal(input.sessionID, 'session'); assert.match(input.id, /^msg_/); assert.equal(input.resume, false); assert.equal(input.delivery, 'steer')
        assert.equal(input.metadata.source, 'opencode-harness-hooks')
        queued.push(structuredClone(input))
        if (enqueue) return enqueue(input)
        return acknowledge(input)
      },
    },
    tool: { hook: hook('tool') },
  }
  function acknowledge(input: any) { return { id: input.id, sessionID: input.sessionID, type: 'synthetic', payload: { text: input.text, metadata: input.metadata, ...(input.description === undefined ? {} : { description: input.description }) }, delivery: input.delivery, time: { created: CREATED + 2 } } }
  let dispose: (() => Promise<void>) | undefined
  t.after(async () => { await dispose?.(); await rm(directory, { recursive: true, force: true }) })
  const connect = async () => { dispose = await plugin.setup(context) as () => Promise<void>; return dispose }
  const prompt = async (id = 'prompt', text = 'Original') => { await callbacks.get('session.prompt')!({ sessionID: 'session', messageID: id, prompt: { text } }); records.push({ type: 'user', id, text, time: { created: CREATED } }) }
  const answer = (id = 'answer', text = 'Answer') => records.push({ type: 'assistant', id, model: { id: 'fixture' }, finish: 'stop', time: { created: CREATED + 1 }, content: [{ type: 'text', text }] })
  const model = async () => {
    const messages = records.filter(row => ['user', 'synthetic', 'assistant'].includes(row.type)).map(row => row.type === 'assistant' ? { id: row.id, role: 'assistant', content: row.content } : { id: row.id, role: 'user', content: [{ type: 'text', text: row.text }] })
    await callbacks.get('session.context')!({ sessionID: 'session', model: { id: 'fixture', providerID: 'fixture' }, messages })
    const event = { sessionID: 'session', kind: 'primary', model: { id: 'fixture', providerID: 'fixture' }, headers: {} }
    await callbacks.get('session.model.request')!(event)
    const http = { ...event, request: new Request('https://provider.invalid', { method: 'POST', headers: event.headers, body: JSON.stringify({ messages: messages.map(({ id: _id, ...row }) => row) }) }) }
    await callbacks.get('session.http.request')!(http)
    assert.equal([...http.request.headers.keys()].some(key => key.startsWith('x-opencode-harness')), false)
    return http.request.json()
  }
  const idle = (background: unknown[] = []) => callbacks.get('session.experimental.idle')!({ sessionID: 'session', background })
  const promote = () => { for (const row of queued) if (!records.some(message => message.id === row.id)) records.push({ type: 'synthetic', id: row.id, text: row.text, metadata: row.metadata, ...(row.description === undefined ? {} : { description: row.description }), time: { created: CREATED + 2 } }) }
  return { directory, path, script, context, callbacks, records, queued, connect, prompt, answer, model, idle, promote, acknowledge, setEnqueue: (value: typeof enqueue) => { enqueue = value }, calls: async () => (await readFile(capture, 'utf8')).trim().split('\n').map(row => JSON.parse(row)), unchanged: async () => { assert.equal(await readFile(path, 'utf8'), native); assert.equal(await readFile(script, 'utf8'), source) }, command: [process.execPath, script].join(' ') }
}

test('default V2 Stop continues the original turn with exact Claude input and readable retained records', async t => {
  const f = await fixture(t)
  const dispose = await f.connect()
  await f.prompt(); await f.model(); f.answer()
  await f.idle()
  assert.equal(f.queued.length, 1)
  f.promote()
  const body = await f.model()
  assert.deepEqual(body.messages, [
    { role: 'user', content: [{ type: 'text', text: 'Original' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Answer' }] },
    { role: 'user', content: [
      { type: 'text', text: `<system-reminder>\nStop hook blocking error from command: "${f.command}": Feedback\n</system-reminder>` },
      { type: 'text', text: '<system-reminder>\nStop hook additional context: Context\n</system-reminder>\n' },
      { type: 'text', text: 'Stop hook feedback:\nFeedback' },
    ] },
  ])
  f.answer('answer-2', 'Second answer'); await f.idle()
  const calls = await f.calls()
  assert.deepEqual(calls.map(row => [row.input.prompt_id, row.input.stop_hook_active, row.input.last_assistant_message]), [['prompt', false, 'Answer'], ['prompt', true, 'Second answer']])
  assert.equal(calls[1].rows.filter((row: any) => row.subtype === 'stop_hook_summary').length, 1)
  assert.equal(calls[1].rows.filter((row: any) => row.isMeta === true).length, 1)
  assert.ok(!JSON.stringify(calls[1].rows).includes(f.queued[0].text))
  assert.equal(f.queued.length, 1)
  await f.prompt('next', 'Next')
  const next = await f.model()
  assert.deepEqual(next.messages.slice(0, 3), body.messages)
  f.answer('next-answer', 'Next answer'); await f.idle(); f.promote(); await f.model()
  f.answer('next-answer-2', 'Final answer'); await f.idle()
  assert.deepEqual((await f.calls()).map(row => [row.input.prompt_id, row.input.stop_hook_active]), [['prompt', false], ['prompt', true], ['next', false], ['next', true]])
  await f.unchanged(); await dispose()
  assert.equal(f.callbacks.size, 0)
})

test('default V2 Stop preserves independent repeated registrations', async t => {
  const f = await fixture(t, 'continue', 2)
  await f.connect(); await f.prompt(); await f.model(); f.answer(); await f.idle()
  assert.equal((await f.calls()).length, 2)
  assert.equal(f.queued.length, 1)
  f.promote()
  const body = await f.model()
  assert.equal(body.messages.at(-1).content.filter((part: any) => part.text.startsWith('Stop hook feedback:')).length, 2)
  f.answer('answer-2'); await f.idle()
  assert.equal((await f.calls()).length, 4)
})

test('V2 Stop checks host capabilities and foreground metadata before command side effects', async t => {
  const f = await fixture(t)
  f.context.app.version = 'unknown'
  await assert.rejects(f.connect(), { code: 'HOST_STOP_HOST_VERSION_UNAVAILABLE' })
  assert.equal(f.callbacks.size, 0)
  f.context.app.version = '2.2.5'
  await f.connect(); await f.prompt(); await f.model(); f.answer()
  await assert.rejects(f.idle([{ kind: 'shell', command: 'Unmapped' }]), { code: 'HOST_STOP_BACKGROUND_UNAVAILABLE' })
  await assert.rejects(f.calls(), { code: 'ENOENT' })
})

test('V2 Stop rejects unavailable SDK mutation and Codex rollout capabilities before activation', async t => {
  const f = await fixture(t)
  const synthetic = f.context.session.synthetic
  Object.defineProperty(f.context.session, 'synthetic', { value: undefined, configurable: true })
  await assert.rejects(f.connect(), { code: 'HOST_STOP_HOST_UNAVAILABLE' })
  assert.equal(f.callbacks.size, 0)
  Object.defineProperty(f.context.session, 'synthetic', { value: synthetic })
  const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'"
  const source = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: [process.execPath, f.script].map(quote).join(' ') }] }] } })
  await writeFile(f.path, source)
  f.context.options.sources[0]!.dialect = 'codex'
  f.context.options.reviewedDigests.claude = createHash('sha256').update(source).digest('hex')
  await assert.rejects(f.connect(), { code: 'HOST_STOP_DIALECT_UNAVAILABLE' })
  assert.equal(f.callbacks.size, 0)
  await assert.rejects(f.calls(), { code: 'ENOENT' })
})

test('a bad queued acknowledgement or missing readback cannot reach the model', async t => {
  for (const mode of ['ack', 'readback'] as const) {
    const f = await fixture(t)
    if (mode === 'ack') f.setEnqueue(async input => ({ ...f.acknowledge(input), id: 'msg_foreign' }))
    await f.connect(); await f.prompt(); await f.model(); f.answer()
    if (mode === 'ack') await assert.rejects(f.idle(), { code: 'HOST_STOP_ACK_INVALID' })
    else { await f.idle(); await assert.rejects(f.model(), { code: 'HOST_STOP_READBACK_UNAVAILABLE' }) }
    await assert.rejects(f.prompt('next', 'Next'))
  }
})

test('V2 Stop prevention ends completion without enqueuing a corrective prompt', async t => {
  const f = await fixture(t, 'prevent')
  await f.connect(); await f.prompt(); await f.model(); f.answer(); await f.idle()
  assert.equal(f.queued.length, 0)
  assert.equal((await f.calls()).length, 1)
  await assert.rejects(f.prompt('next', 'Next'), { code: 'HOST_STOP_HISTORY_PROJECTION_UNAVAILABLE' })
})

test('unmapped V2 Stop warning effects reject instead of disappearing', async t => {
  const f = await fixture(t, 'warning')
  await f.connect(); await f.prompt(); await f.model(); f.answer()
  await assert.rejects(f.idle(), { code: 'HOST_STOP_EFFECT_UNAVAILABLE' })
  assert.equal(f.queued.length, 0)
})

test('late SDK admission after a real prompt replacement remains quarantined from model delivery', async t => {
  const f = await fixture(t)
  let entered!: () => void, release!: () => void
  const started = new Promise<void>(resolve => { entered = resolve }), waiting = new Promise<void>(resolve => { release = resolve })
  f.setEnqueue(async input => { entered(); await waiting; return f.acknowledge(input) })
  await f.connect(); await f.prompt(); await f.model(); f.answer()
  const idle = f.idle()
  const cancelled = assert.rejects(idle, { code: 'HOST_STOP_CANCELLED' })
  try {
    await started
    await assert.rejects(f.prompt('next', 'Next'), { code: 'HOST_STOP_CANCELLED' })
    await cancelled
  } finally { release() }
  f.promote()
  await assert.rejects(f.model(), { code: 'HOST_STOP_CANCELLED' })
  assert.equal((await f.calls()).length, 1)
})

test('failed V2 Stop disposal keeps guards until the raw SDK operation actually drains', { timeout: 15000 }, async t => {
  const f = await fixture(t)
  let entered!: () => void, release!: () => void
  const started = new Promise<void>(resolve => { entered = resolve }), waiting = new Promise<void>(resolve => { release = resolve })
  f.setEnqueue(async input => { entered(); await waiting; return f.acknowledge(input) })
  const dispose = await f.connect()
  await f.prompt(); await f.model(); f.answer()
  const idle = f.idle()
  const cancelled = assert.rejects(idle, { code: 'HOST_STOP_CANCELLED' })
  try {
    await started
    await assert.rejects(dispose(), { code: 'HOST_STOP_ADMISSION_DRAIN_FAILED' })
    assert.equal(f.callbacks.has('session.context'), true)
    await assert.rejects(f.model(), { code: 'SESSION_DISPOSED' })
    await cancelled
  } finally { release() }
  await dispose()
  assert.equal(f.callbacks.size, 0)
})
