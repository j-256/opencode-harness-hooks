import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Sessions } from '../src/sessions.js'
import type { HostToolEvent } from '../src/tool-types.js'

const CREATED = Date.parse('2026-01-01T00:00:00Z')
const library = () => import(new URL('../src/codex-transcript.ts', import.meta.url).href)
const event = (callID = 'call'): HostToolEvent => ({ host: 'v1', event: 'PreToolUse', sessionID: 'host-session', callID, tool: 'bash', toolInput: { command: 'original' }, effectiveInput: { command: 'effective' }, signal: new AbortController().signal })
function history(): any {
  return { id: 'host-session', messages: [
    { id: 'turn', turnID: 'turn', role: 'user', created: CREATED, content: ['User prompt'] },
    { id: 'answer', turnID: 'turn', role: 'assistant', created: CREATED + 1, content: ['Before tool', { id: 'call', name: 'bash', status: 'completed', created: CREATED + 2, output: 'Tool result', completed: CREATED + 3 }] },
  ] }
}

test('Codex transcript rejects invalid storage parents and missing history services before allocation', async () => {
  const { CodexTranscript } = await library()
  for (const invalid of [{ directory: 'relative' }, { temporaryParent: '' }, { temporaryParent: 'relative' }, { history: undefined }]) assert.throws(() => new CodexTranscript({ host: 'v1', directory: '/project', history: async () => history(), ...invalid }), { code: 'CODEX_TRANSCRIPT_OPTIONS_INVALID' })
})

test('Codex transcript exposes consistent identities, prompt and original function input before the hook', async t => {
  const { CodexTranscript } = await library()
  const sessions = new Sessions(); sessions.prompt('host-session', 'turn', 'fixture')
  const transcript = new CodexTranscript({ host: 'v1', directory: '/project', history: async () => history() })
  t.after(async () => { await transcript.dispose(); sessions.dispose() })
  transcript.observe(event(), sessions.get('host-session'))
  const view = await transcript.prepare(event(), sessions.get('host-session'), event().signal)
  const rows = (await readFile(view.transcriptPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.match(view.sessionID, /^[a-f0-9-]{36}$/)
  assert.notEqual(view.sessionID, 'host-session')
  assert.equal(rows[0].type, 'session_meta')
  assert.equal(rows[0].payload.id, view.sessionID)
  assert.equal(rows[0].payload.originator, 'opencode-harness-hooks')
  assert.equal(rows.find(row => row.payload.type === 'task_started').payload.turn_id, view.turnID)
  assert.ok(rows.some(row => row.type === 'response_item' && row.payload.role === 'user' && row.payload.content[0].text === 'User prompt'))
  assert.ok(rows.some(row => row.type === 'event_msg' && row.payload.type === 'user_message' && row.payload.message === 'User prompt'))
  assert.ok(rows.some(row => row.type === 'event_msg' && row.payload.type === 'agent_message' && row.payload.message === 'Before tool'))
  const call = rows.find(row => row.payload.type === 'function_call')
  assert.equal(call.payload.name, 'exec_command')
  assert.equal(call.payload.call_id, 'call')
  assert.deepEqual(JSON.parse(call.payload.arguments), { cmd: 'original' })
  assert.equal(call.payload.internal_chat_message_metadata_passthrough.turn_id, view.turnID)
  assert.ok(!rows.some(row => row.payload.type === 'function_call_output'))
  assert.equal((await stat(view.transcriptPath)).mode & 0o777, 0o600)
  assert.deepEqual(await transcript.prepare({ ...event(), event: 'PostToolUse' }, sessions.get('host-session'), event().signal), view)
  await transcript.dispose()
  await assert.rejects(access(view.transcriptPath), { code: 'ENOENT' })
})

test('completed results appear at the next call without rewriting the published prefix', async t => {
  const { CodexTranscript } = await library()
  const records = history()
  const sessions = new Sessions(); sessions.prompt('host-session', 'turn', 'fixture')
  const transcript = new CodexTranscript({ host: 'v1', directory: '/project', history: async () => records })
  t.after(async () => { await transcript.dispose(); sessions.dispose() })
  transcript.observe(event(), sessions.get('host-session'))
  const view = await transcript.prepare(event(), sessions.get('host-session'), event().signal)
  const before = await readFile(view.transcriptPath, 'utf8')
  records.messages[1].content[1].created = CREATED + 3
  records.messages.push({ id: 'next-answer', turnID: 'turn', role: 'assistant', created: CREATED + 4, content: [{ id: 'next', name: 'bash', status: 'running', created: CREATED + 4 }] })
  transcript.observe(event('next'), sessions.get('host-session'))
  const next = await transcript.prepare(event('next'), sessions.get('host-session'), event().signal)
  assert.equal(next.transcriptPath, view.transcriptPath)
  const after = await readFile(next.transcriptPath, 'utf8')
  assert.ok(after.startsWith(before))
  const output = after.trim().split('\n').map(line => JSON.parse(line)).find(row => row.payload.type === 'function_call_output')
  assert.equal(output.payload.call_id, 'call')
  assert.equal(output.payload.output, 'Tool result')
})

test('foreign, reset, unobserved and cancelled histories cannot publish fabricated Codex records', async t => {
  const { CodexTranscript } = await library()
  const parent = await mkdtemp(join(tmpdir(), 'codex-transcript-tests-'))
  const sessions = new Sessions(); sessions.prompt('host-session', 'turn', 'fixture')
  let records = history()
  const transcript = new CodexTranscript({ host: 'v1', directory: '/project', temporaryParent: parent, history: async () => records })
  t.after(async () => { try { await transcript.dispose() } finally { sessions.dispose(); await rm(parent, { recursive: true, force: true }) } })
  await assert.rejects(transcript.prepare(event(), sessions.get('host-session'), event().signal), { code: 'CODEX_TRANSCRIPT_ORIGINAL_INPUT_UNAVAILABLE' })
  transcript.observe(event(), sessions.get('host-session'))
  const view = await transcript.prepare(event(), sessions.get('host-session'), event().signal)
  const before = await readFile(view.transcriptPath)
  records = { ...history(), id: 'foreign' }
  await assert.rejects(transcript.prepare(event(), sessions.get('host-session'), event().signal), { code: 'CODEX_TRANSCRIPT_SESSION_MISMATCH' })
  records = { ...history(), messages: [] }
  await assert.rejects(transcript.prepare(event(), sessions.get('host-session'), event().signal), { code: 'CODEX_TRANSCRIPT_HISTORY_RESET_UNVERIFIED' })
  assert.deepEqual(await readFile(view.transcriptPath), before)
  const cancelled = AbortSignal.abort()
  await assert.rejects(transcript.prepare(event(), sessions.get('host-session'), cancelled), { code: 'CODEX_TRANSCRIPT_CANCELLED' })
})

test('interleaved assistant text and tool calls preserve the native journal prefix', async t => {
  const { CodexTranscript } = await library()
  const records = history()
  const sessions = new Sessions(); sessions.prompt('host-session', 'turn', 'fixture')
  const transcript = new CodexTranscript({ host: 'v1', directory: '/project', history: async () => records })
  t.after(async () => { await transcript.dispose(); sessions.dispose() })
  transcript.observe(event(), sessions.get('host-session'))
  const view = await transcript.prepare(event(), sessions.get('host-session'), event().signal)
  const before = await readFile(view.transcriptPath, 'utf8')
  records.messages[1].content.push('After first tool', { id: 'next', name: 'bash', status: 'running', created: CREATED + 4 })
  transcript.observe(event('next'), sessions.get('host-session'))
  await transcript.prepare(event('next'), sessions.get('host-session'), event().signal)
  const after = await readFile(view.transcriptPath, 'utf8')
  assert.ok(after.startsWith(before))
  const types = after.trim().split('\n').map(line => JSON.parse(line)).filter(row => row.type === 'response_item').map(row => row.payload.type)
  assert.deepEqual(types, ['message', 'message', 'function_call', 'function_call_output', 'message', 'function_call'])
})

test('pending sibling calls enter the journal only after their original input is observed', async t => {
  const { CodexTranscript } = await library()
  const records = history()
  records.messages[1].content[1].status = 'running'
  records.messages[1].content.push({ id: 'sibling', name: 'bash', status: 'running', created: CREATED + 4 })
  const sessions = new Sessions(); sessions.prompt('host-session', 'turn', 'fixture')
  const transcript = new CodexTranscript({ host: 'v1', directory: '/project', history: async () => records })
  t.after(async () => { await transcript.dispose(); sessions.dispose() })
  transcript.observe(event('sibling'), sessions.get('host-session'))
  const view = await transcript.prepare(event('sibling'), sessions.get('host-session'), event().signal)
  const before = await readFile(view.transcriptPath, 'utf8')
  assert.deepEqual(before.trim().split('\n').map(line => JSON.parse(line)).filter(row => row.payload.type === 'function_call').map(row => row.payload.call_id), ['sibling'])
  transcript.observe(event(), sessions.get('host-session'))
  await transcript.prepare(event(), sessions.get('host-session'), event().signal)
  await transcript.prepare({ ...event('sibling'), event: 'PostToolUse' }, sessions.get('host-session'), event().signal)
  const after = await readFile(view.transcriptPath, 'utf8')
  assert.ok(after.startsWith(before))
  assert.deepEqual(after.trim().split('\n').map(line => JSON.parse(line)).filter(row => row.payload.type === 'function_call').map(row => row.payload.call_id), ['sibling', 'call'])
})

test('parallel completion appends prior results without changing published calls or accepting history changes', async t => {
  const { CodexTranscript } = await library()
  const records = history()
  records.messages[1].content[1].status = 'running'
  records.messages[1].content.push({ id: 'sibling', name: 'bash', status: 'running', created: CREATED + 4 })
  const sessions = new Sessions(); sessions.prompt('host-session', 'turn', 'fixture')
  const transcript = new CodexTranscript({ host: 'v1', directory: '/project', history: async () => records })
  t.after(async () => { await transcript.dispose(); sessions.dispose() })
  transcript.observe(event(), sessions.get('host-session'))
  transcript.observe(event('sibling'), sessions.get('host-session'))
  const [view] = await Promise.all([transcript.prepare(event(), sessions.get('host-session'), event().signal), transcript.prepare(event('sibling'), sessions.get('host-session'), event().signal)])
  const before = await readFile(view.transcriptPath, 'utf8')
  records.messages[1].content[1].status = 'completed'
  await transcript.prepare({ ...event(), event: 'PostToolUse' }, sessions.get('host-session'), event().signal)
  await transcript.prepare(event('sibling'), sessions.get('host-session'), event().signal)
  const after = await readFile(view.transcriptPath, 'utf8')
  assert.ok(after.startsWith(before))
  const items = after.trim().split('\n').map(line => JSON.parse(line)).filter(row => row.type === 'response_item').map(row => row.payload)
  assert.deepEqual(items.slice(-3).map(item => [item.type, item.call_id]), [['function_call', 'call'], ['function_call', 'sibling'], ['function_call_output', 'call']])
  records.messages[1].content[1].output = 'Changed result'
  await assert.rejects(transcript.prepare(event('sibling'), sessions.get('host-session'), event().signal), { code: 'CODEX_TRANSCRIPT_HISTORY_RESET_UNVERIFIED' })
  records.messages[1].content[1].output = 'Tool result'
  records.messages[1].content.reverse()
  await assert.rejects(transcript.prepare(event('sibling'), sessions.get('host-session'), event().signal), { code: 'CODEX_TRANSCRIPT_HISTORY_RESET_UNVERIFIED' })
  assert.equal(await readFile(view.transcriptPath, 'utf8'), after)
})

test('V1 Codex history rejects foreign sessions and preserves host message and tool relationships', async () => {
  const { codexHistoryV1 } = await import(new URL('../src/hosts/codex-history-v1.ts', import.meta.url).href)
  const messages = [
    { info: { id: 'turn', role: 'user', sessionID: 'host-session', time: { created: CREATED } }, parts: [{ type: 'text', text: 'Question' }] },
    { info: { id: 'answer', role: 'assistant', sessionID: 'host-session', parentID: 'turn', time: { created: CREATED + 1 } }, parts: [{ type: 'step-start' }, { type: 'tool', callID: 'call', tool: 'bash', state: { status: 'running', input: { command: 'effective' }, time: { start: CREATED + 2 } } }] },
  ]
  const projected = codexHistoryV1({ id: 'host-session' }, messages)
  assert.equal(projected.messages[1].turnID, 'turn')
  assert.equal(projected.messages[1].content[0].id, 'call')
  assert.equal(projected.messages[1].content[0].status, 'running')
  assert.throws(() => codexHistoryV1({ id: 'other' }, messages), /CODEX_TRANSCRIPT_SESSION_MISMATCH/)
  assert.throws(() => codexHistoryV1({ id: 'host-session' }, [{ ...messages[0], parts: [{ type: 'file' }] }]), /CODEX_TRANSCRIPT_CONTENT_UNSUPPORTED/)
})

test('concurrent preparation shares one artifact and disposal cancels queued history reads', async t => {
  const { CodexTranscript } = await library()
  const sessions = new Sessions(); sessions.prompt('host-session', 'turn', 'fixture')
  const transcript = new CodexTranscript({ host: 'v1', directory: '/project', history: async () => history() })
  t.after(async () => { await transcript.dispose(); sessions.dispose() })
  transcript.observe(event(), sessions.get('host-session'))
  const views = await Promise.all([transcript.prepare(event(), sessions.get('host-session'), event().signal), transcript.prepare(event(), sessions.get('host-session'), event().signal)])
  assert.deepEqual(views[0], views[1])
  let entered!: () => void
  const ready = new Promise<void>(resolve => { entered = resolve })
  const waiting = new CodexTranscript({ host: 'v1', directory: '/project', history: async (_event: any, signal: AbortSignal) => { entered(); return new Promise(resolve => signal.addEventListener('abort', () => resolve(history()), { once: true })) } })
  t.after(() => waiting.dispose())
  waiting.observe(event(), sessions.get('host-session'))
  const pending = waiting.prepare(event(), sessions.get('host-session'), event().signal)
  const rejected = assert.rejects(pending, { code: 'CODEX_TRANSCRIPT_CANCELLED' })
  await ready
  await waiting.dispose()
  await rejected
  assert.equal(waiting.inspect().created, false)
})

test('startup reserves an existing native journal without a turn and later tool hooks share its identities', async t => {
  const { CodexTranscript } = await library()
  const sessions = new Sessions()
  let rows: any = { id: 'host-session', messages: [] }
  const transcript = new CodexTranscript({ host: 'v1', directory: '/project', history: async () => rows })
  t.after(async () => { await transcript.dispose(); sessions.dispose() })
  const start = { host: 'v1' as const, event: 'SessionStart' as const, sessionID: 'host-session', activationID: 'activation', cwd: '/project', data: { source: 'startup' } }
  const initial = await transcript.prepareStart(start, sessions.get('host-session'), sessions.get('host-session').signal)
  const metadata = JSON.parse((await readFile(initial.transcriptPath, 'utf8')).trim())
  assert.equal(metadata.type, 'session_meta')
  assert.equal(metadata.payload.id, initial.sessionID)
  assert.match(initial.sessionID, /^[a-f0-9-]{36}$/)
  assert.equal(Object.hasOwn(initial, 'turnID'), false)
  rows = history()
  sessions.prompt('host-session', 'turn', 'fixture')
  transcript.observe(event(), sessions.get('host-session'))
  const tool = await transcript.prepare(event(), sessions.get('host-session'), event().signal)
  assert.equal(tool.sessionID, initial.sessionID)
  assert.equal(tool.transcriptPath, initial.transcriptPath)
  const projected = (await readFile(tool.transcriptPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(projected[0], metadata)
  assert.ok(projected.some(row => row.payload.type === 'function_call'))
})

test('startup context enters the journal before its owned user with native hook provenance and stable readback', async t => {
  const { CodexTranscript } = await library()
  const sessions = new Sessions(); sessions.prompt('host-session', 'turn', 'fixture')
  const transcript = new CodexTranscript({ host: 'v1', directory: '/project', history: async () => history() })
  t.after(async () => { await transcript.dispose(); sessions.dispose() })
  transcript.rememberStart(sessions.get('host-session'), 'activation', ['CODEX_START_CONTEXT'])
  transcript.bindStart(sessions.get('host-session'), 'activation', 'turn')
  transcript.observe(event(), sessions.get('host-session'))
  const view = await transcript.prepare(event(), sessions.get('host-session'), event().signal)
  const before = await readFile(view.transcriptPath, 'utf8'), rows = before.trim().split('\n').map(line => JSON.parse(line))
  const context = rows.find(row => row.payload.role === 'developer')
  assert.ok(context)
  assert.deepEqual(context.payload.content, [{ type: 'input_text', text: 'CODEX_START_CONTEXT' }])
  assert.equal(context.payload.internal_chat_message_metadata_passthrough.turn_id, view.turnID)
  assert.deepEqual(context.payload.internal_chat_message_metadata_passthrough.content_item_kinds, ['hooks.additional_context'])
  assert.deepEqual(context.payload.internal_chat_message_metadata_passthrough.content_item_metadata, [{ provenance: { type: 'harness', hook: true } }])
  assert.ok(rows.indexOf(context) < rows.findIndex(row => row.payload.role === 'user'))
  await transcript.prepare(event(), sessions.get('host-session'), event().signal)
  assert.equal(await readFile(view.transcriptPath, 'utf8'), before)
  assert.throws(() => transcript.bindStart(sessions.get('host-session'), 'activation', 'foreign'), { code: 'CODEX_STARTUP_BINDING_INVALID' })
})

test('a genuine prompt can read its existing Codex journal before its SDK user is persisted', async t => {
  const { CodexTranscript } = await library(), sessions = new Sessions(), records = { id: 'host-session', messages: [] as any[] }
  sessions.prompt('host-session', 'turn', 'fixture'); const session = sessions.get('host-session')
  const transcript = new CodexTranscript({ host: 'v1', directory: '/project', history: async () => records }); t.after(async () => { await transcript.dispose(); sessions.dispose() })
  const prompt = { host: 'v1' as const, event: 'UserPromptSubmit' as const, sessionID: 'host-session', messageID: 'turn', prompt: 'User prompt', signal: session.turnSignal }
  const view = await transcript.preparePrompt(prompt, session, session.turnSignal), before = await readFile(view.transcriptPath, 'utf8')
  assert.equal(JSON.parse(before).type, 'session_meta'); assert.equal(JSON.parse(before).payload.id, view.sessionID)
  assert.deepEqual(await transcript.preparePrompt(prompt, session, session.turnSignal), view)
  assert.match(view.turnID, /^[a-f0-9-]{36}$/); assert.notEqual(view.turnID, view.sessionID)
  records.messages.push(...history().messages); transcript.observe(event(), session)
  const tool = await transcript.prepare(event(), session, session.turnSignal)
  assert.equal(tool.sessionID, view.sessionID); assert.equal(tool.turnID, view.turnID); assert.equal(tool.transcriptPath, view.transcriptPath)
  assert.ok((await readFile(tool.transcriptPath, 'utf8')).startsWith(before))
  await assert.rejects(transcript.preparePrompt(prompt, session, session.turnSignal), { code: 'CODEX_TRANSCRIPT_PROMPT_UNAVAILABLE' })
})

test('a notification callback validates its real completed anchor and sees its Codex result without a fabricated tool event', async t => {
  const { CodexTranscript } = await library(), sessions = new Sessions(), records = history()
  sessions.prompt('host-session', 'turn', 'fixture'); const session = sessions.get('host-session')
  const transcript = new CodexTranscript({ host: 'v1', directory: '/project', history: async () => records }); t.after(async () => { await transcript.dispose(); sessions.dispose() })
  transcript.observe(event(), session)
  const anchor = { kind: 'tool' as const, sessionID: 'host-session', turnID: 'turn', messageID: 'answer', callID: 'call', signature: (await import('node:crypto')).createHash('sha256').update('Tool result').digest('hex') }
  const notification = { host: 'v1' as const, event: 'UserPromptSubmit' as const, sessionID: 'host-session', messageID: 'turn', prompt: 'NOTIFICATION', notificationID: 'owned-notice', anchor, signal: session.turnSignal }
  const view = await transcript.prepareNotification(notification, session, session.turnSignal), before = await readFile(view.transcriptPath, 'utf8'), rows = before.trim().split('\n').map(line => JSON.parse(line))
  assert.equal(rows.find(row => row.payload.type === 'function_call_output').payload.output, 'Tool result')
  assert.equal(rows.some(row => JSON.stringify(row.payload).includes('NOTIFICATION')), false)
  for (const changed of [{ callID: 'foreign' }, { messageID: 'foreign' }, { signature: 'a'.repeat(64) }]) await assert.rejects(transcript.prepareNotification({ ...notification, anchor: { ...anchor, ...changed } }, session, session.turnSignal), { code: 'CODEX_TRANSCRIPT_NOTIFICATION_UNAVAILABLE' })
  records.messages[1].content[1].status = 'running'
  await assert.rejects(transcript.prepareNotification(notification, session, session.turnSignal), { code: 'CODEX_TRANSCRIPT_NOTIFICATION_UNAVAILABLE' })
  assert.equal(await readFile(view.transcriptPath, 'utf8'), before)
})
