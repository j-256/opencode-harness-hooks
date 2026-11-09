import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import plugin from '../src/index.js'

const CREATED = Date.parse('2026-01-01T00:00:00Z')
const COMMAND_DELAY_MS = 1000
const HOOK_START_MS = 3000
const HOOK_POLL_MS = 10
const historyCases = JSON.parse(readFileSync(new URL('./fixtures/claude-stop-history-oracle.json', import.meta.url), 'utf8')).cases
type Callback = (event: any) => Promise<void>
async function fixture(t: { after: (callback: () => Promise<void>) => void }, mode = 'continue', repeats = 1) {
  const directory = await mkdtemp(join(tmpdir(), 'harness-plugin-stop-'))
  const capture = join(directory, 'calls.jsonl'), script = join(directory, 'hook.cjs'), path = join(directory, 'hooks.json')
  const history = historyCases.find((row: any) => row.name === mode)
  const source = `const fs=require('node:fs');const p=JSON.parse(fs.readFileSync(0,'utf8'));const rows=fs.readFileSync(p.transcript_path,'utf8').trim().split('\\n').map(JSON.parse);fs.appendFileSync(${JSON.stringify(capture)},JSON.stringify({input:p,rows})+'\\n');if(${JSON.stringify(mode)}==='prevent')console.log(JSON.stringify({continue:false,stopReason:'Stopped'}));else if(${JSON.stringify(mode)}==='warning')console.log(JSON.stringify({systemMessage:'Warning'}));else if(!p.stop_hook_active)console.log(JSON.stringify({decision:'block',reason:'Feedback',hookSpecificOutput:{hookEventName:'Stop',additionalContext:'Context'}}));`
  const executable = history ? `const fs=require('node:fs');const p=JSON.parse(fs.readFileSync(0,'utf8'));if(p.hook_event_name==='UserPromptSubmit'){if(p.prompt==='Blocked')console.log(JSON.stringify({decision:'block',reason:'Rejected'}));else if(p.prompt==='LATER_NEXT_PROMPT')console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'UserPromptSubmit',additionalContext:${JSON.stringify(history.promptContext ?? '')}}}));return}const rows=fs.readFileSync(p.transcript_path,'utf8').trim().split('\\n').map(JSON.parse);fs.appendFileSync(${JSON.stringify(capture)},JSON.stringify({input:p,rows})+'\\n');console.log(JSON.stringify(${JSON.stringify(history.output)}));` : source
  const scriptSource = mode === 'during-hook' ? `const fs=require('node:fs');const p=JSON.parse(fs.readFileSync(0,'utf8'));const rows=fs.readFileSync(p.transcript_path,'utf8').trim().split('\\n').map(JSON.parse);fs.appendFileSync(${JSON.stringify(capture)},JSON.stringify({input:p,rows,pid:process.pid})+'\\n');if(p.prompt_id==='prompt')setTimeout(()=>{fs.writeFileSync(${JSON.stringify(join(directory, 'finished'))},'finished');console.log(JSON.stringify({decision:'block',reason:'Late output'}))},${COMMAND_DELAY_MS});` : mode === 'after-feedback' ? `const fs=require('node:fs');const p=JSON.parse(fs.readFileSync(0,'utf8'));const rows=fs.readFileSync(p.transcript_path,'utf8').trim().split('\\n').map(JSON.parse);fs.appendFileSync(${JSON.stringify(capture)},JSON.stringify({input:p,rows})+'\\n');if(p.prompt_id==='prompt'&&!p.stop_hook_active)console.log(JSON.stringify({decision:'block',reason:'Feedback',hookSpecificOutput:{hookEventName:'Stop',additionalContext:'Context'}}));` : executable
  await writeFile(script, scriptSource)
  const hooks = Array.from({ length: repeats }, () => ({ type: 'command', command: process.execPath, args: [script] }))
  const native = JSON.stringify({ hooks: { Stop: [{ hooks }], ...(history?.promptContext ? { UserPromptSubmit: [{ hooks }] } : {}) } })
  await writeFile(path, native)
  const callbacks = new Map<string, Callback>()
  const hook = (domain: string) => async (name: string, callback: Callback) => { const key = domain + '.' + name; callbacks.set(key, callback); return { dispose: () => { callbacks.delete(key) } } }
  const records: any[] = [], queued: any[] = []
  const eventQueue: { raw: unknown; done: () => void }[] = []
  let eventReturnGate: Promise<void> | undefined
  let wake: (() => void) | undefined, subscribed = false, eventStopped = false, executing = false, sequence = 0
  const delivered = new Set<string>()
  const emit = (type: string, data: Record<string, unknown> = {}) => {
    if (!subscribed || eventStopped) return Promise.resolve()
    const seq = ++sequence
    return new Promise<void>(done => { eventQueue.push({ raw: { id: 'event-' + seq, created: CREATED + seq, type: 'session.' + type, durable: { aggregateID: 'session', seq, version: 1 }, data: { sessionID: 'session', ...data } }, done }); wake?.() })
  }
  let enqueue: ((input: any) => Promise<any>) | undefined
  const context = {
    app: { version: '2.2.5' }, location: { directory },
    options: { sources: [{ id: 'claude', dialect: 'claude-code', path }], reviewedDigests: { claude: createHash('sha256').update(native).digest('hex') }, permissionMode: 'default' },
    model: { list: async () => ({ data: [{ id: 'fixture', providerID: 'fixture', package: '@opencode/ai/providers/openai-compatible' }] }) },
    event: { subscribe: async function* ({ signal }: { signal: AbortSignal }) {
      subscribed = true
      const abort = () => { eventStopped = true; wake?.() }
      signal.addEventListener('abort', abort, { once: true })
      try {
        while (!signal.aborted) {
          if (!eventQueue.length) await new Promise<void>(resolve => { wake = resolve })
          const item = eventQueue.shift()
          if (item) { try { yield item.raw } finally { item.done() } }
        }
      } finally { signal.removeEventListener('abort', abort); eventStopped = true; for (const item of eventQueue.splice(0)) item.done(); await eventReturnGate }
    } },
    session: {
      hook: hook('session'),
      get: async ({ sessionID }: { sessionID: string }) => ({ id: sessionID, model: { id: 'fixture', providerID: 'fixture' } }),
      context: async ({ sessionID }: { sessionID: string }) => { assert.equal(sessionID, 'session'); return structuredClone(records) },
      synthetic: async (input: any) => {
        assert.equal(input.sessionID, 'session'); assert.match(input.id, /^msg_/); assert.equal(input.resume, false); assert.equal(input.delivery, 'steer')
        assert.equal(input.metadata.source, 'opencode-harness-hooks')
        await emit('inbox.enqueued', { inboxID: input.id, item: { type: 'synthetic', payload: { text: input.text, metadata: input.metadata }, delivery: input.delivery } })
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
  const prompt = async (id = 'prompt', text = 'Original') => {
    await emit('inbox.enqueued', { inboxID: id, item: { type: 'user', payload: { text, files: [] }, delivery: 'steer' } })
    await callbacks.get('session.prompt')!({ sessionID: 'session', messageID: id, prompt: { text } })
    records.push({ type: 'user', id, text, time: { created: CREATED } })
    if (!executing) { await emit('execution.started'); executing = true }
    await emit('inbox.delivered', { inboxID: id }); delivered.add(id)
  }
  const answer = (id = 'answer', text = 'Answer') => records.push({ type: 'assistant', id, model: { id: 'fixture' }, finish: 'stop', time: { created: CREATED + 1 }, content: [{ type: 'text', text }] })
  const deliver = async (id: string) => { await emit('inbox.delivered', { inboxID: id }); delivered.add(id) }
  const model = async () => {
    for (const row of records) if (row.type === 'synthetic' && !delivered.has(row.id)) await deliver(row.id)
    const messages = records.filter(row => ['user', 'synthetic', 'assistant'].includes(row.type)).map(row => row.type === 'assistant' ? { id: row.id, role: 'assistant', content: row.content } : { id: row.id, role: 'user', content: [{ type: 'text', text: row.text }] })
    const frame = { sessionID: 'session', model: { id: 'fixture', providerID: 'fixture' }, messages }
    await callbacks.get('session.context')!(frame)
    const event = { sessionID: 'session', kind: 'primary', model: { id: 'fixture', providerID: 'fixture' }, headers: {} }
    await callbacks.get('session.model.request')!(event)
    const http = { ...event, request: new Request('https://provider.invalid', { method: 'POST', headers: event.headers, body: JSON.stringify({ messages: frame.messages.map(({ id: _id, ...row }) => row) }) }) }
    await callbacks.get('session.http.request')!(http)
    assert.equal([...http.request.headers.keys()].some(key => key.startsWith('x-opencode-harness')), false)
    return http.request.json()
  }
  const idle = async (background: unknown[] = []) => { const before = queued.length; await callbacks.get('session.experimental.idle')!({ sessionID: 'session', background }); if (executing && queued.length === before) { await emit('execution.succeeded'); executing = false } }
  const promote = () => { for (const row of queued) if (!records.some(message => message.id === row.id)) records.push({ type: 'synthetic', id: row.id, text: row.text, metadata: row.metadata, ...(row.description === undefined ? {} : { description: row.description }), time: { created: CREATED + 2 } }) }
  const interrupt = async () => { await emit('execution.interrupted', { reason: 'user' }); executing = false }
  const abortFeedback = async () => {
    const model = { id: 'fixture', providerID: 'fixture', variant: 'default' }, error = { type: 'aborted', message: 'Step interrupted' }
    await emit('step.started', { assistantMessageID: 'aborted', agent: 'build', model, started: CREATED + 2 })
    records.push({ id: 'aborted', type: 'assistant', agent: 'build', model, time: { created: CREATED + 2, completed: CREATED + sequence + 1 }, content: [], finish: 'error', error })
    await emit('step.failed', { assistantMessageID: 'aborted', error })
    await interrupt()
  }

  const calls = async () => (await readFile(capture, 'utf8')).trim().split('\n').map(row => JSON.parse(row))
  const waitForHook = async () => {
    const deadline = performance.now() + HOOK_START_MS
    while (true) { try { if ((await calls()).length) return } catch {} if (performance.now() >= deadline) throw new Error('Hook did not start'); await new Promise(resolve => setTimeout(resolve, HOOK_POLL_MS)) }
  }
  return { directory, path, script, context, callbacks, records, queued, connect, prompt, answer, deliver, model, idle, promote, acknowledge, emit, setEventReturnGate: (gate: Promise<void>) => { eventReturnGate = gate }, interrupt, abortFeedback, setEnqueue: (value: typeof enqueue) => { enqueue = value }, calls, waitForHook, unchanged: async () => { assert.equal(await readFile(path, 'utf8'), native); assert.equal(await readFile(script, 'utf8'), scriptSource) }, command: [process.execPath, script].join(' ') }
}

test('default V2 user interruption cancels a running Stop and retains native interruption history', async t => {
  const f = await fixture(t, 'during-hook')
  await f.connect(); await f.prompt(); await f.model(); f.answer()
  const idle = f.idle()
  await f.waitForHook()
  await f.interrupt(); await idle
  const originalPID = (await f.calls())[0].pid
  assert.ok(Number.isSafeInteger(originalPID) && originalPID > 0)
  assert.throws(() => process.kill(originalPID, 0), { code: 'ESRCH' })
  await assert.rejects(readFile(join(f.directory, 'finished')), { code: 'ENOENT' })
  assert.equal(f.queued.length, 0)
  await f.prompt('next', 'Next')
  const body = await f.model()
  assert.deepEqual(body.messages.at(-1), { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]\n' }, { type: 'text', text: 'Next' }] })
  f.answer('answer-next', 'Next answer'); await f.idle()
  const calls = await f.calls(), interruption = calls[1].rows.find((row: any) => row.userType === 'external')
  assert.equal(interruption.promptId, 'prompt')
  assert.equal(interruption.entrypoint, 'sdk-cli')
  assert.equal(calls[1].rows.filter((row: any) => row.subtype === 'stop_hook_summary').length, 0)
  assert.deepEqual(calls.map(row => [row.input.prompt_id, row.input.stop_hook_active]), [['prompt', false], ['next', false]])
  await f.unchanged()
})

test('default V2 after-feedback interruption retains native output and retires only its unanswered owned input', async t => {
  const f = await fixture(t, 'after-feedback')
  await f.connect(); await f.prompt(); await f.model(); f.answer(); await f.idle(); f.promote()
  const feedback = await f.model()
  assert.ok(feedback.messages.at(-1).content.some((part: any) => part.text === 'Stop hook feedback:\nFeedback'))
  await f.abortFeedback()
  await f.prompt('next', 'Next')
  const body = await f.model()
  assert.deepEqual(body.messages.map((row: any) => row.role), ['user', 'assistant', 'user'])
  assert.deepEqual(body.messages[2].content, [
    `<system-reminder>\nStop hook blocking error from command: "${f.command}": Feedback\n</system-reminder>`,
    '<system-reminder>\nStop hook additional context: Context\n</system-reminder>',
    'Stop hook feedback:\nFeedback\n', '[Request interrupted by user]\n', 'Next',
  ].map(text => ({ type: 'text', text })))
  f.answer('next-answer', 'Next answer'); await f.idle()
  const calls = await f.calls(), rows = calls[1].rows
  assert.equal(rows.filter((row: any) => row.subtype === 'stop_hook_summary').length, 1)
  assert.equal(rows.find((row: any) => row.userType === 'external').promptId, 'prompt')
  assert.ok(!JSON.stringify(rows).includes(f.queued[0].text) && !JSON.stringify(rows).includes('Step interrupted'))
  assert.deepEqual(calls.map(row => [row.input.prompt_id, row.input.stop_hook_active]), [['prompt', false], ['next', false]])
  await f.prompt('third', 'Third')
  assert.deepEqual((await f.model()).messages[2], body.messages[2])
  assert.equal(f.queued.length, 1)
  await f.unchanged()
})

test('reconciled V2 interruption rejects changed or missing native ownership before a later model', async t => {
  const f = await fixture(t, 'after-feedback')
  await f.connect(); await f.prompt(); await f.model(); f.answer(); await f.idle(); f.promote(); await f.model(); await f.abortFeedback(); await f.prompt('next', 'Next'); await f.model()
  const stable = structuredClone(f.records)
  for (const change of ['input', 'assistant', 'pruned', 'moved']) {
    f.records.splice(0, f.records.length, ...structuredClone(stable))
    if (change === 'input') f.records[2].metadata.token = 'foreign'
    else if (change === 'assistant') f.records[3].error.message = 'Changed'
    else if (change === 'pruned') f.records.splice(3, 1)
    else f.records.push(f.records.splice(2, 1)[0])
    await assert.rejects(f.model(), { code: 'HOST_STOP_INTERRUPTION_HISTORY_CHANGED' })
  }
  f.records.splice(0, f.records.length, ...stable)
  await f.model()
  await f.unchanged()
})

test('a new real prompt waits for session-owned reconciliation without being cancelled by the old owner', async t => {
  const f = await fixture(t, 'after-feedback')
  await f.connect(); await f.prompt(); await f.model(); f.answer(); await f.idle(); f.promote(); await f.model()
  const history = f.context.session.context
  let entered!: () => void, release!: () => void
  const started = new Promise<void>(resolve => { entered = resolve }), waiting = new Promise<void>(resolve => { release = resolve })
  f.context.session.context = async input => { entered(); await waiting; return history(input) }
  try {
    await f.abortFeedback(); await started; await f.prompt('next', 'Next')
    let settled = false
    const model = f.model().finally(() => { settled = true })
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(settled, false)
    release()
    const body = await model
    assert.equal(body.messages.at(-1).content.at(-1).text, 'Next')
    assert.ok(body.messages.at(-1).content.some((part: any) => part.text === '[Request interrupted by user]\n'))
  } finally { release() }
})

test('V2 disposal tracks the raw cancelled-turn reconciliation read until actual settlement', { timeout: 15000 }, async t => {
  const f = await fixture(t, 'after-feedback'), dispose = await f.connect()
  await f.prompt(); await f.model(); f.answer(); await f.idle(); f.promote(); await f.model()
  const history = f.context.session.context
  let entered!: () => void, release!: () => void
  const started = new Promise<void>(resolve => { entered = resolve }), waiting = new Promise<void>(resolve => { release = resolve })
  f.context.session.context = async input => { entered(); await waiting; return history(input) }
  try {
    await f.abortFeedback(); await started
    await assert.rejects(dispose(), { code: 'HOST_STOP_ADMISSION_DRAIN_FAILED' })
    assert.equal(f.callbacks.has('session.context'), true)
  } finally { release() }
  await dispose()
  assert.equal(f.callbacks.size, 0)
})

for (const phase of ['idle', 'queued-context', 'rejected-sibling', 'transcript']) test(`V2 disposal retains guards while the ${phase} native history read remains unresolved`, { timeout: 15000 }, async t => {
  const f = await fixture(t), dispose = await f.connect()
  await f.prompt(); await f.model(); f.answer()
  if (phase === 'queued-context') { await f.idle(); f.promote() }
  const history = f.context.session.context
  let entered!: () => void, release!: () => void
  const started = new Promise<void>(resolve => { entered = resolve }), waiting = new Promise<void>(resolve => { release = resolve })
  let reads = 0
  f.context.session.context = async input => { if (phase === 'transcript' && ++reads === 1) return history(input); entered(); await waiting; return history(input) }
  if (phase === 'rejected-sibling') f.context.session.get = async (_input, options?: { signal: AbortSignal }) => new Promise<never>((_resolve, reject) => {
    const signal = options!.signal
    if (signal.aborted) reject(new Error('Metadata read aborted'))
    else signal.addEventListener('abort', () => reject(new Error('Metadata read aborted')), { once: true })
  })
  const operation = (phase === 'queued-context' ? f.model() : f.idle()).catch(error => error)
  try {
    await started
    await assert.rejects(dispose(), { code: 'HOST_STOP_ADMISSION_DRAIN_FAILED' })
    assert.equal(f.callbacks.has('session.context'), true)
    assert.equal((await operation).outcome, 'cancelled')
  } finally { release() }
  await dispose()
  assert.equal(f.callbacks.size, 0)
})

test('malformed V2 session events block their model without waiting for iterator return or blocking another session', async t => {
  const f = await fixture(t)
  await f.connect(); await f.prompt(); await f.model()
  let release!: () => void
  f.setEventReturnGate(new Promise<void>(resolve => { release = resolve }))
  try {
    await f.emit('execution.interrupted', { reason: 'invented' })
    await assert.rejects(f.model(), { code: 'HOST_STOP_EVENT_INVALID' })
    await assert.rejects(f.calls(), { code: 'ENOENT' })
    await f.callbacks.get('session.prompt')!({ sessionID: 'other', messageID: 'other-prompt', prompt: { text: 'Other' } })
  } finally { release() }
})

test('a delayed native interruption keeps its original Stop owner after another prompt callback', async t => {
  const f = await fixture(t, 'during-hook')
  await f.connect(); await f.prompt(); await f.model(); f.answer()
  const idle = f.idle().catch(error => { assert.equal(error.code, 'HOST_STOP_CANCELLED') })
  await f.waitForHook()
  await f.callbacks.get('session.prompt')!({ sessionID: 'session', messageID: 'next', prompt: { text: 'Next' } })
  f.records.push({ type: 'user', id: 'next', text: 'Next', time: { created: CREATED + 3 } })
  await f.interrupt(); await idle
  const body = await f.model()
  assert.deepEqual(body.messages.at(-1).content, [{ type: 'text', text: '[Request interrupted by user]\n' }, { type: 'text', text: 'Next' }])
  f.answer('next-answer'); await f.idle()
  const calls = await f.calls(), rows = calls[1].rows
  assert.throws(() => process.kill(calls[0].pid, 0), { code: 'ESRCH' })
  assert.equal(rows.find((row: any) => row.userType === 'external').promptId, 'prompt')
  await assert.rejects(readFile(join(f.directory, 'finished')), { code: 'ENOENT' })
  await f.unchanged()
})

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
  const subscribe = f.context.event.subscribe
  Object.defineProperty(f.context.event, 'subscribe', { value: undefined, configurable: true })
  await assert.rejects(f.connect(), { code: 'HOST_STOP_HOST_UNAVAILABLE' })
  assert.equal(f.callbacks.size, 0)
  Object.defineProperty(f.context.event, 'subscribe', { value: subscribe })
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
  await f.prompt('next', 'Next')
  const body = await f.model()
  assert.deepEqual(body.messages.at(-1).content, [{ type: 'text', text: '<system-reminder>\nStop hook stopped continuation: Stopped\n</system-reminder>' }, { type: 'text', text: 'Next' }])
})

for (const scenario of historyCases) test(`default V2 retained Stop history agrees with native ${scenario.name}`, async t => {
  const f = await fixture(t, scenario.name)
  await f.connect(); await f.prompt('prompt', 'LATER_ORIGINAL_PROMPT'); await f.model(); f.answer('answer', 'NATIVE_STOP_ANSWER_1'); await f.idle()
  assert.equal(f.queued.length, 0)
  if (scenario.promptContext) await assert.rejects(f.prompt('blocked', 'Blocked'), { code: 'HOOK_PROMPT_BLOCKED' })
  await f.prompt('next', 'LATER_NEXT_PROMPT')
  const body = await f.model()
  const expected = scenario.nextUser.map((text: string) => ({ type: 'text', text: text.replaceAll('FIXTURE_COMMAND', f.command) }))
  assert.deepEqual(body.messages.at(-1), { role: 'user', content: expected })
  f.answer('answer-next', 'Next answer'); await f.idle()
  await f.prompt('third', 'Third')
  const third = await f.model()
  assert.deepEqual(third.messages[2], body.messages[2])
  assert.equal(f.queued.length, 0)
  const calls = await f.calls()
  assert.deepEqual(calls.map(row => [row.input.prompt_id, row.input.stop_hook_active]), [['prompt', false], ['next', false]])
  assert.ok(calls[1].rows.some((row: any) => row.attachment?.type === 'hook_stopped_continuation'))
  await f.unchanged()
})

test('retained Stop history rejects changed, moved and pruned native assistant ownership', async t => {
  for (const change of ['text', 'id', 'position', 'pruned', 'duplicate']) {
    const f = await fixture(t, 'prevent')
    await f.connect(); await f.prompt(); await f.model(); f.answer(); await f.idle(); await f.prompt('next', 'Next')
    if (change === 'text') f.records[1].content[0].text = 'Changed'
    else if (change === 'id') f.records[1].id = 'foreign'
    else if (change === 'position') f.records.push(f.records.splice(1, 1)[0])
    else if (change === 'pruned') f.records.splice(1, 1)
    else f.records.push(structuredClone(f.records[1]))
    await assert.rejects(f.model(), { code: 'HOST_STOP_HISTORY_UNAVAILABLE' })
  }
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

for (const concurrent of [false, true]) test(`a native interruption before feedback acknowledgement retains output with overlapping contexts ${concurrent}`, async t => {
  const f = await fixture(t, 'after-feedback')
  let entered!: () => void, release!: () => void
  const started = new Promise<void>(resolve => { entered = resolve }), waiting = new Promise<void>(resolve => { release = resolve })
  f.setEnqueue(async input => { entered(); await waiting; return f.acknowledge(input) })
  await f.connect(); await f.prompt(); await f.model()
  await f.emit('step.started', { assistantMessageID: 'answer', agent: 'build', model: { id: 'fixture', providerID: 'fixture' }, started: CREATED + 1 })
  f.answer()
  await f.emit('step.ended', { assistantMessageID: 'answer', finish: 'stop' })
  const idle = f.idle().catch(error => error)
  try {
    await started
    await f.interrupt()
    assert.equal(await idle, undefined)
    await f.prompt('next', 'Next')
    release()
    f.promote()
    if (concurrent) {
      await f.deliver(f.queued[0].id)
      const messages = f.records.filter(row => ['user', 'synthetic', 'assistant'].includes(row.type)).map(row => ({ id: row.id, role: row.type === 'assistant' ? 'assistant' : 'user', content: row.type === 'assistant' ? row.content : [{ type: 'text', text: row.text }] }))
      const frames = [0, 1].map(() => ({ sessionID: 'session', model: { id: 'fixture', providerID: 'fixture' }, messages: structuredClone(messages) }))
      await Promise.all(frames.map(frame => f.callbacks.get('session.context')!(frame)))
      assert.deepEqual(frames.map(frame => frame.messages.map(row => row.id)), [['prompt', 'answer', 'next'], ['prompt', 'answer', 'next']])
    }
    const body = await f.model()
    assert.deepEqual(body.messages.map((row: any) => row.role), ['user', 'assistant', 'user'])
    assert.deepEqual(body.messages[2].content, [
      `<system-reminder>\nStop hook blocking error from command: "${f.command}": Feedback\n</system-reminder>`,
      '<system-reminder>\nStop hook additional context: Context\n</system-reminder>',
      'Stop hook feedback:\nFeedback\n', '[Request interrupted by user]\n', 'Next',
    ].map(text => ({ type: 'text', text })))
    f.answer('next-answer', 'Next answer'); await f.idle()
    const calls = await f.calls(), records = calls[1].rows
    assert.equal(records.filter((row: any) => row.subtype === 'stop_hook_summary').length, 1)
    assert.equal(records.filter((row: any) => row.userType === 'external').length, 1)
    assert.equal(records.find((row: any) => row.userType === 'external').promptId, 'prompt')
    assert.ok(!JSON.stringify(records).includes(f.queued[0].text))
    assert.deepEqual(calls.map(row => [row.input.prompt_id, row.input.stop_hook_active]), [['prompt', false], ['next', false]])
    await f.prompt('third', 'Third')
    assert.deepEqual((await f.model()).messages[2], body.messages[2])
    await f.unchanged()
  } finally { release(); await idle }
})

for (const scenario of ['changed-ack', 'missing-readback', 'changed-marker'] as const) test(`pending acknowledgement interruption rejects ${scenario} before model transport`, async t => {
  const f = await fixture(t, 'after-feedback')
  let entered!: () => void, release!: () => void
  const started = new Promise<void>(resolve => { entered = resolve }), waiting = new Promise<void>(resolve => { release = resolve })
  f.setEnqueue(async input => {
    entered(); await waiting
    const ack = f.acknowledge(input)
    return scenario === 'changed-ack' ? { ...ack, payload: { ...ack.payload, metadata: { ...input.metadata, token: 'changed' } } } : ack
  })
  await f.connect(); await f.prompt(); await f.model()
  await f.emit('step.started', { assistantMessageID: 'answer', agent: 'build', model: { id: 'fixture', providerID: 'fixture' }, started: CREATED + 1 })
  f.answer()
  await f.emit('step.ended', { assistantMessageID: 'answer', finish: 'stop' })
  const idle = f.idle().catch(error => error)
  try {
    await started; await f.interrupt(); assert.equal(await idle, undefined)
    await f.prompt('next', 'Next')
    release()
    await new Promise<void>(resolve => setImmediate(resolve))
    if (scenario !== 'missing-readback') f.promote()
    if (scenario === 'changed-marker') f.records.find(row => row.type === 'synthetic').metadata.token = 'changed'
    let transports = 0
    const http = f.callbacks.get('session.http.request')!
    f.callbacks.set('session.http.request', async event => { transports++; return http(event) })
    const code = scenario === 'changed-ack' ? 'HOST_STOP_ACK_INVALID' : scenario === 'missing-readback' ? 'HOST_STOP_READBACK_UNAVAILABLE' : 'TRANSCRIPT_STOP_CONTINUATION_CHANGED'
    await assert.rejects(f.model(), { code })
    assert.equal(transports, 0)
    await f.unchanged()
  } finally { release(); await idle }
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
