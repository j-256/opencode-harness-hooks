import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { ClaudeTranscript } from '../src/transcript.js'
import { Sessions } from '../src/sessions.js'
import { createRuntime } from '../src/runtime.js'
import type { StopEvent } from '../src/stop.js'

const CREATED = Date.parse('2026-01-01T00:00:00Z')
const history = (): unknown[] => [
  { type: 'user', id: 'prompt', text: 'Original', files: [], time: { created: CREATED } },
  { type: 'assistant', id: 'answer', model: { id: 'fixture' }, finish: 'stop', time: { created: CREATED + 1 }, content: [{ type: 'text', text: 'Answer' }] },
]
const event = (cwd = '/project'): StopEvent => ({ host: 'v2', event: 'Stop', sessionID: 'session', messageID: 'prompt', completionID: 'answer', cwd })
const rows = (text: string) => text.trim().split('\n').map(line => JSON.parse(line))
function fixture(t: TestContext) {
  const sessions = new Sessions()
  sessions.prompt('session', 'prompt', 'fixture')
  const records = history()
  const transcripts = new ClaudeTranscript({ host: 'v2', directory: '/project', now: () => CREATED, history: async () => ({ id: 'session', messages: records }) })
  transcripts.observeModel({ host: 'v2', sessionID: 'session', messageID: 'prompt', signal: sessions.get('session').turnSignal }, sessions.get('session'))
  t.after(async () => { sessions.dispose(); await transcripts.dispose() })
  return { sessions, records, transcripts }
}

test('a V2 Stop snapshot includes its completed assistant without inventing a current tool call', async t => {
  const f = fixture(t)
  const session = f.sessions.get('session')
  const path = await f.transcripts.prepare(event(), session, session.turnSignal)
  const text = await readFile(path, 'utf8')
  const projected = rows(text)
  assert.deepEqual(projected.map(row => row.type), ['user', 'attachment', 'assistant'])
  assert.deepEqual(projected[0].message, { role: 'user', content: 'Original' })
  assert.equal(projected[1].attachment.type, 'date')
  assert.deepEqual(projected[2].message, { id: 'answer', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Answer' }], model: 'fixture', stop_reason: 'end_turn', stop_sequence: null })
  assert.equal(projected[2].parentUuid, projected[1].uuid)
  assert.ok(projected.every(row => row.sessionId === 'session' && row.version === '2.1.318'))
  assert.equal(f.transcripts.inspect().promptTurns, 0)
  assert.equal(f.transcripts.inspect().modelTurns, 1)
  assert.equal(await f.transcripts.prepare(event(), session, session.turnSignal), path)
  assert.equal(await readFile(path, 'utf8'), text)
})

test('Stop snapshots reject stale, missing and unfinished completion identities before publishing a file', async t => {
  const f = fixture(t)
  const session = f.sessions.get('session')
  await assert.rejects(f.transcripts.prepare({ ...event(), cwd: '/foreign' }, session, session.turnSignal), { code: 'TRANSCRIPT_STOP_CWD_UNAVAILABLE' })
  await assert.rejects(f.transcripts.prepare({ ...event(), messageID: 'foreign' }, session, session.turnSignal), { code: 'TRANSCRIPT_STOP_TURN_UNAVAILABLE' })
  await assert.rejects(f.transcripts.prepare({ ...event(), completionID: 'foreign' }, session, session.turnSignal), { code: 'TRANSCRIPT_STOP_COMPLETION_UNAVAILABLE' })
  const answer = f.records[1] as Record<string, unknown>
  for (const finish of [undefined, 'tool-calls']) {
    answer.finish = finish
    await assert.rejects(f.transcripts.prepare(event(), session, session.turnSignal), { code: 'TRANSCRIPT_STOP_COMPLETION_UNAVAILABLE' })
  }
  answer.finish = 'stop'
  f.records.push({ type: 'user', id: 'next', text: 'Next', files: [], time: { created: CREATED + 2 } })
  await assert.rejects(f.transcripts.prepare(event(), session, session.turnSignal), { code: 'TRANSCRIPT_STOP_COMPLETION_UNAVAILABLE' })
  assert.equal(f.transcripts.inspect().created, false)
})

test('a new user turn cancels Stop history preparation even when the caller signal stays live', async t => {
  const sessions = new Sessions()
  sessions.prompt('session', 'prompt', 'fixture')
  let entered!: () => void
  const reading = new Promise<void>(resolve => { entered = resolve })
  let release!: () => void
  const waiting = new Promise<void>(resolve => { release = resolve })
  t.after(() => release())
  const transcripts = new ClaudeTranscript({ host: 'v2', directory: '/project', history: async () => { entered(); await waiting; return { id: 'session', messages: history() } } })
  t.after(async () => { sessions.dispose(); await transcripts.dispose() })
  transcripts.observeModel({ host: 'v2', sessionID: 'session', messageID: 'prompt', signal: sessions.get('session').turnSignal }, sessions.get('session'))
  const parent = new AbortController()
  const pending = transcripts.prepare(event(), sessions.get('session'), parent.signal)
  await reading
  sessions.prompt('session', 'next', 'fixture')
  release()
  await assert.rejects(pending, { code: 'TRANSCRIPT_CANCELLED', outcome: 'cancelled' })
  assert.equal(parent.signal.aborted, false)
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(transcripts.inspect().created, false)
})

test('completion snapshot support does not create a V1 Stop implementation', async t => {
  const sessions = new Sessions()
  sessions.prompt('session', 'prompt', 'fixture')
  const transcripts = new ClaudeTranscript({ host: 'v1', directory: '/project', history: async () => { assert.fail('V1 Stop read native history') } })
  t.after(async () => { sessions.dispose(); await transcripts.dispose() })
  await assert.rejects(transcripts.prepare({ ...event(), host: 'v1' }, sessions.get('session'), sessions.get('session').turnSignal), { code: 'TRANSCRIPT_STOP_HOST_UNSUPPORTED' })
  assert.equal(transcripts.inspect().created, false)
})

test('an unchanged Claude command consumes the completion snapshot through core Stop payload I/O', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'harness-stop-transcript-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const script = join(directory, 'hook.mjs')
  const body = `import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
let text = ''
for await (const chunk of process.stdin) text += chunk
const input = JSON.parse(text)
const transcript = readFileSync(input.transcript_path, 'utf8').trim().split('\\n').map(JSON.parse)
assert.equal(input.hook_event_name, 'Stop')
assert.equal(input.prompt_id, 'prompt')
assert.equal(input.stop_hook_active, false)
assert.equal(input.last_assistant_message, 'Answer')
assert.equal(transcript.at(-1).message.role, 'assistant')
assert.deepEqual(transcript.at(-1).message.content, [{ type: 'text', text: 'Answer' }])
assert.equal(transcript.at(-1).message.stop_reason, 'end_turn')
assert.equal(transcript.at(-1).cwd, input.cwd)
process.stdout.write(JSON.stringify({ decision: 'block', reason: 'Transcript accepted' }))
`
  await writeFile(script, body)
  const path = join(directory, 'hooks.json')
  const source = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: process.execPath, args: [script] }] }] } })
  await writeFile(path, source)
  const transcripts = new ClaudeTranscript({ host: 'v2', directory, now: () => CREATED, history: async () => ({ id: 'session', messages: history() }) })
  let feedback: readonly string[] = []
  const runtime = await createRuntime('v2', directory, { sources: [{ id: 'claude', dialect: 'claude-code', path }], reviewedDigests: { claude: createHash('sha256').update(source).digest('hex') }, permissionMode: 'default' }, {
    report: () => {}, dispatchDiagnostic: () => {}, transcripts, host: { environment: { PATH: process.env.PATH, HOME: directory, SHELL: '/bin/sh' } },
    stop: { diagnostic: () => {}, admit: async delivery => { feedback = delivery.effects.continuations.map(row => row.action.text) } },
  })
  t.after(() => runtime.dispose())
  runtime.sessions.prompt('session', 'prompt', 'fixture')
  const session = runtime.sessions.get('session')
  runtime.observeModel({ host: 'v2', sessionID: 'session', messageID: 'prompt', signal: session.turnSignal })
  const transcriptPath = await transcripts.prepare(event(directory), session, session.turnSignal)
  const receipt = await runtime.stop({ ...event(directory), data: { transcript_path: transcriptPath, last_assistant_message: 'Answer', background_tasks: [], session_crons: [] } })
  assert.equal(receipt.control, 'continue')
  assert.deepEqual(feedback, ['Transcript accepted'])
  assert.equal(await readFile(path, 'utf8'), source)
  assert.equal(await readFile(script, 'utf8'), body)
})

test('Stop history includes completed tool results and preserves their original input', async t => {
  const f = fixture(t)
  const session = f.sessions.get('session')
  f.records.splice(1, 0, { type: 'assistant', id: 'tool-answer', model: { id: 'fixture' }, finish: 'tool-calls', time: { created: CREATED }, content: [
    { type: 'tool', id: 'call', name: 'shell', time: { created: CREATED, completed: CREATED + 1 }, state: { status: 'completed', input: { command: 'effective' }, content: [{ type: 'text', text: 'Done' }] } },
  ] })
  await assert.rejects(f.transcripts.prepare(event(), session, session.turnSignal), { code: 'TRANSCRIPT_ORIGINAL_INPUT_UNAVAILABLE' })
  f.transcripts.observe({ host: 'v2', event: 'PreToolUse', sessionID: 'session', callID: 'call', tool: 'shell', toolInput: { command: 'original' }, effectiveInput: { command: 'effective' }, signal: session.turnSignal }, session)
  const projected = rows(await readFile(await f.transcripts.prepare(event(), session, session.turnSignal), 'utf8'))
  assert.deepEqual(projected.map(row => row.type), ['user', 'attachment', 'assistant', 'user', 'assistant'])
  assert.deepEqual(projected[2].message.content, [{ type: 'tool_use', id: 'call', name: 'Bash', input: { command: 'original' } }])
  assert.deepEqual(projected[3].message.content, [{ type: 'tool_result', tool_use_id: 'call', content: [{ type: 'text', text: 'Done' }] }])
  assert.equal(projected.at(-1).message.id, 'answer')
})

test('unowned synthetic history cannot be treated as a new real prompt in a Stop snapshot', async t => {
  const f = fixture(t)
  f.records.push({ type: 'synthetic', id: 'foreign', text: 'Foreign feedback', metadata: { source: 'foreign' }, time: { created: CREATED + 2 } }, { ...(history()[1] as object), id: 'second-answer' })
  await assert.rejects(f.transcripts.prepare({ ...event(), completionID: 'second-answer' }, f.sessions.get('session'), f.sessions.get('session').turnSignal), { code: 'TRANSCRIPT_CONTENT_UNSUPPORTED' })
  assert.equal(f.transcripts.inspect().created, false)
})

test('queued Stop preparation captures completion identity before caller mutation', async t => {
  const sessions = new Sessions()
  sessions.prompt('session', 'prompt', 'fixture')
  let entered!: () => void
  const reading = new Promise<void>(resolve => { entered = resolve })
  let release!: () => void
  const waiting = new Promise<void>(resolve => { release = resolve })
  t.after(() => release())
  const transcripts = new ClaudeTranscript({ host: 'v2', directory: '/project', history: async () => { entered(); await waiting; return { id: 'session', messages: history() } } })
  t.after(async () => { sessions.dispose(); await transcripts.dispose() })
  const session = sessions.get('session')
  transcripts.observeModel({ host: 'v2', sessionID: 'session', messageID: 'prompt', signal: session.turnSignal }, session)
  const frame = { ...event() }
  const pending = transcripts.prepare(frame, session, session.turnSignal)
  await reading
  frame.sessionID = 'foreign'
  frame.completionID = 'foreign'
  release()
  const projected = rows(await readFile(await pending, 'utf8'))
  assert.ok(projected.every(row => row.sessionId === 'session'))
  assert.equal(projected.at(-1).message.id, 'answer')
  assert.equal(transcripts.inspect().pending, 0)
})
