import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { CodexTranscript } from '../src/codex-transcript.js'
import { Sessions } from '../src/sessions.js'
import { executeRegistration } from '../src/handlers.js'
import type { DispatchResult } from '../src/engine.js'
import type { HostPromptEvent } from '../src/prompt-types.js'
import type { Registration } from '../src/types.js'
import { WakeRecords } from '../src/wake-records.js'
import type { BackgroundDelivery } from '../src/background-types.js'
import type { HostNotificationEvent } from '../src/notification.js'
import { createHash } from 'node:crypto'

const CREATED = 1700000000000
const oracle = JSON.parse(readFileSync(new URL('./fixtures/codex-prompt-context-oracle.json', import.meta.url), 'utf8'))
async function context(event: HostPromptEvent): Promise<DispatchResult> {
  const registration: Registration = { id: 'context', sourceID: 'codex', sourceDigest: 'a'.repeat(64), dialect: 'codex', event: 'UserPromptSubmit', groupIndex: 0, handlerIndex: 0, handler: { type: 'command', command: `printf '%s' '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"PROMPT_JOURNAL_CONTEXT"}}'` } }
  const result = await executeRegistration(registration, { host: 'v1', event: event.event, sessionID: event.sessionID, cwd: process.cwd(), data: { prompt: event.prompt, transcript_path: '/unused', turn_id: 'turn', model: 'fixture', permission_mode: 'default' } }, { projectRoot: process.cwd(), environment: {} })
  assert.equal(result.status, 'success', JSON.stringify(result))
  const entry = { sourceID: registration.sourceID, sourceDigest: registration.sourceDigest!, registrationID: registration.id, dialect: registration.dialect, configuredOrder: 0, completionOrder: 0, result }, { result: _result, ...origin } = entry
  return { entries: [entry], actions: result.actions.map(action => ({ ...origin, action })), cancelled: false, diagnostic: { dispatchID: 'dispatch', sessionID: event.sessionID, event: event.event, durationMs: 0, cancelled: false, failed: 0, unsupported: 0, skipped: 0, background: 0, handlers: [] } }
}
const rows = async (path: string) => (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line))

test('accepted Codex prompt context has native developer provenance and survives repeat reads and cold replay', async t => {
  const sessions = new Sessions(); sessions.prompt('session', 'turn', 'model'); const session = sessions.get('session')
  const records = { id: 'session', messages: [] as any[] }, transcript = new CodexTranscript({ host: 'v1', directory: '/project', history: async () => records })
  t.after(async () => { await transcript.dispose(); sessions.dispose() })
  const prompt: HostPromptEvent = { host: 'v1', event: 'UserPromptSubmit', sessionID: 'session', messageID: 'turn', prompt: 'GENUINE', signal: session.turnSignal }
  const view = await transcript.preparePrompt(prompt, session, session.turnSignal)
  const dispatched = await context(prompt)
  transcript.admitPrompt(prompt, session, dispatched)
  const snapshot = transcript.snapshotV1('session')
  const next = new Sessions(); next.prompt('session', 'turn', 'model')
  const restored = new CodexTranscript({ host: 'v1', directory: '/project', history: async () => records })
  t.after(async () => { await restored.dispose(); next.dispose() })
  restored.restoreV1(next.get('session'), snapshot)
  records.messages.push({ id: 'turn', turnID: 'turn', role: 'user', created: CREATED, content: ['GENUINE'] })
  sessions.prompt('session', 'next', 'model'); next.prompt('session', 'next', 'model')
  const future = { ...prompt, messageID: 'next', prompt: 'NEXT', signal: sessions.get('session').turnSignal }
  const fresh = await transcript.preparePrompt(future, sessions.get('session'), future.signal)
  const published = await rows(fresh.transcriptPath), developer = published.find(row => row.payload.role === 'developer')
  assert.ok(developer)
  const payload = structuredClone(developer.payload), meta = payload.internal_chat_message_metadata_passthrough
  assert.ok(Number.isFinite(meta.create_time)); assert.equal(new Date(meta.create_time * 1000).toISOString(), developer.timestamp)
  assert.equal(meta.turn_id, view.turnID); payload.id = '<message-id>'; meta.turn_id = '<turn-id>'; meta.create_time = 0
  assert.deepEqual(payload, oracle.payload)
  assert.ok(published.findIndex(row => row.payload.role === 'user') < published.indexOf(developer))
  await transcript.preparePrompt(future, sessions.get('session'), future.signal)
  const replay = await restored.preparePrompt({ ...future, signal: next.get('session').turnSignal }, next.get('session'), next.get('session').turnSignal)
  assert.deepEqual(await rows(replay.transcriptPath), published)
  records.messages[0].content = ['CHANGED']
  await assert.rejects(transcript.preparePrompt(future, sessions.get('session'), future.signal), { code: 'CODEX_PROMPT_HISTORY_MISMATCH' })
  assert.deepEqual(await rows(fresh.transcriptPath), published)
})

test('Codex prompt admission rejects stopped, cancelled, foreign, and changed prompt state', async t => {
  const sessions = new Sessions(); sessions.prompt('session', 'turn', 'model'); const session = sessions.get('session')
  const transcript = new CodexTranscript({ host: 'v1', directory: '/project', history: async () => ({ id: 'session', messages: [] }) })
  t.after(async () => { await transcript.dispose(); sessions.dispose() })
  const prompt: HostPromptEvent = { host: 'v1', event: 'UserPromptSubmit', sessionID: 'session', messageID: 'turn', prompt: 'GENUINE', signal: session.turnSignal }, dispatched = await context(prompt)
  assert.throws(() => transcript.admitPrompt({ ...prompt, messageID: 'foreign' }, session, dispatched), { code: 'CODEX_PROMPT_OWNER_MISMATCH' })
  assert.throws(() => transcript.admitPrompt(prompt, session, { ...dispatched, cancelled: true }), { code: 'CODEX_PROMPT_NOT_ACCEPTED' })
  assert.throws(() => transcript.admitPrompt(prompt, session, { ...dispatched, actions: [{ ...dispatched.actions[0]!, action: { kind: 'stop-session', reason: 'STOP' } }] }), { code: 'CODEX_PROMPT_NOT_ACCEPTED' })
  transcript.admitPrompt(prompt, session, dispatched)
  assert.throws(() => transcript.admitPrompt({ ...prompt, prompt: 'CHANGED' }, session, dispatched), { code: 'CODEX_PROMPT_HISTORY_MISMATCH' })
  transcript.discardPendingPrompt(session, 'turn')
  assert.equal(transcript.snapshotV1('session').prompts.length, 0)
})

test('Codex context restoration validates the whole snapshot, rolls back, and migrates only the exact older shape', async t => {
  const sessions = new Sessions(); sessions.prompt('session', 'turn', 'model'); const session = sessions.get('session')
  const options = { host: 'v1' as const, directory: '/project', history: async () => ({ id: 'session', messages: [] }) }, source = new CodexTranscript(options)
  t.after(async () => { await source.dispose(); sessions.dispose() })
  const event: HostPromptEvent = { host: 'v1', event: 'UserPromptSubmit', sessionID: 'session', messageID: 'turn', prompt: 'GENUINE', signal: session.turnSignal }
  source.admitPrompt(event, session, await context(event)); const snapshot = source.snapshotV1('session')
  for (const mutate of [
    (value: any) => { value.prompts[0].promptHash = 'invalid' },
    (value: any) => { value.prompts[0].contexts = [false] },
    (value: any) => { value.prompts[0].created = null },
    (value: any) => { value.prompts.push(value.prompts[0]) },
    (value: any) => { value.prompts[0].extra = true },
    (value: any) => { value.originals = { invalid: true } },
  ]) {
    const restored = new CodexTranscript(options), input = structuredClone(snapshot); mutate(input)
    try { assert.throws(() => restored.restoreV1(session, input)); assert.equal(restored.inspect().promptContexts, 0); const undo = restored.restoreV1(session, snapshot); assert.equal(restored.inspect().promptContexts, 1); undo(); assert.equal(restored.inspect().promptContexts, 0) } finally { await restored.dispose() }
  }
  const old = new CodexTranscript(options), empty = new CodexTranscript(options), { prompts: _prompts, ...legacy } = empty.snapshotV1('session')
  t.after(async () => { await old.dispose(); await empty.dispose() }); old.restoreV1(session, legacy)
  assert.equal(old.inspect().promptContexts, 0)
  const rejected = new CodexTranscript(options); t.after(() => rejected.dispose())
  assert.throws(() => rejected.restoreV1(session, { ...legacy, unknown: [] }), { code: 'SESSION_SNAPSHOT_SCHEMA_INVALID' })
  sessions.close('session'); assert.equal(source.inspect().promptContexts, 0)
})

test('Codex session deletion reclaims prompt context without affecting another session', async t => {
  const sessions = new Sessions(), transcript = new CodexTranscript({ host: 'v1', directory: '/project', history: async event => ({ id: event.sessionID, messages: [] }) })
  t.after(async () => { await transcript.dispose(); sessions.dispose() })
  for (const sessionID of ['session', 'other']) {
    sessions.prompt(sessionID, 'turn', 'model'); const session = sessions.get(sessionID), prompt: HostPromptEvent = { host: 'v1', event: 'UserPromptSubmit', sessionID, messageID: 'turn', prompt: 'GENUINE', signal: session.turnSignal }
    transcript.admitPrompt(prompt, session, await context(prompt))
  }
  await transcript.removeSession('session')
  assert.equal(transcript.inspect().promptContexts, 1); assert.deepEqual(transcript.snapshotV1('session').prompts, []); assert.equal(transcript.snapshotV1('other').prompts.length, 1)
})

for (const position of ['tool', 'system'] as const) test(`Codex wake developer context follows its proven ${position} anchor and survives cold replay`, async t => {
  const sessions = new Sessions(); sessions.prompt('session', 'turn', 'model')
  const source: Registration = { id: 'wake', sourceID: 'source', sourceDigest: 'b'.repeat(64), dialect: 'claude-code', event: 'UserPromptSubmit', groupIndex: 0, handlerIndex: 0, handler: { type: 'command', command: 'owned', asyncRewake: true } }, wakes = new WakeRecords({ registrations: [source] })
  const delivery: BackgroundDelivery = { id: 'job', sourceID: source.sourceID, sourceDigest: source.sourceDigest!, registrationID: source.id, dialect: 'claude-code', event: source.event, mode: 'wake', actions: [{ kind: 'native-extension', name: 'asyncRewake', value: 'WAKE' }], completion: { completedAt: CREATED + 3, execution: { status: 'exited', exitCode: 2, signal: null, stdout: '', stderr: 'WAKE', durationMs: 1, processID: 123 } } }
  const records = { id: 'session', messages: [{ id: 'turn', turnID: 'turn', role: 'user', created: CREATED, content: ['GENUINE'] }] as any[] }
  const transcript = new CodexTranscript({ host: 'v1', directory: '/project', wakes, history: async () => records })
  t.after(async () => { await transcript.dispose(); wakes.dispose(); sessions.dispose() })
  const tool = { host: 'v1' as const, event: 'PreToolUse' as const, sessionID: 'session', callID: 'call', tool: 'bash', toolInput: { command: 'original' }, effectiveInput: { command: 'original' }, signal: sessions.get('session').turnSignal }
  if (position === 'tool') {
    transcript.observe(tool, sessions.get('session'))
    records.messages.push({ id: 'answer', turnID: 'turn', role: 'assistant', created: CREATED + 1, content: [{ id: 'call', name: 'bash', status: 'completed', created: CREATED + 1, completed: CREATED + 2, output: 'RESULT' }] })
  } else sessions.prompt('session', 'system', 'model')
  const session = sessions.get('session'); wakes.admit(session, delivery)
  const prompt = wakes.read(session)[0]!.text.prompt, hash = (text: string) => createHash('sha256').update(text).digest('hex')
  const anchor = position === 'tool' ? { kind: 'tool' as const, sessionID: 'session', turnID: 'turn', messageID: 'answer', callID: 'call', signature: hash('RESULT') } : { kind: 'prompt' as const, sessionID: 'session', turnID: 'system', messageID: 'system', signature: hash(JSON.stringify([prompt])) }
  const attempt = wakes.begin(session, 'job', anchor), event: HostNotificationEvent = { host: 'v1', event: 'UserPromptSubmit', sessionID: 'session', messageID: session.turnID!, prompt, notificationID: attempt.id, anchor, signal: session.turnSignal }
  await transcript.prepareNotification(event, session, session.turnSignal)
  wakes.capture(session, event, await context(event)); wakes.reserveBind(session, 'job', attempt.id, anchor, position === 'tool' ? { kind: 'queued', human: false } : { kind: 'system', promptIndex: 0, turnIndex: 2 }).commit()
  if (position === 'system') records.messages.push({ id: 'system', turnID: 'system', role: 'user', created: CREATED + 4, content: [prompt] })
  sessions.prompt('session', 'next', 'model'); const current = sessions.get('session'), future: HostPromptEvent = { ...event, messageID: 'next', prompt: 'NEXT', signal: current.turnSignal }
  const view = await transcript.preparePrompt(future, current, current.turnSignal), published = await rows(view.transcriptPath), index = published.findIndex(row => row.payload.role === 'developer')
  assert.ok(index > 0)
  assert.equal(published[index - 1].payload.type, position === 'tool' ? 'function_call_output' : 'user_message')
  assert.equal(published[index].payload.content[0].text, 'PROMPT_JOURNAL_CONTEXT')
  assert.deepEqual(published[index].payload.internal_chat_message_metadata_passthrough.content_item_metadata, [{ provenance: { type: 'harness', hook: true } }])
  const coldWakes = new WakeRecords(), cold = new CodexTranscript({ host: 'v1', directory: '/project', wakes: coldWakes, history: async () => records })
  t.after(async () => { await cold.dispose(); coldWakes.dispose() })
  coldWakes.restoreV1(current, wakes.snapshotV1('session')); cold.restoreV1(current, transcript.snapshotV1('session'))
  const replay = await cold.preparePrompt(future, current, current.turnSignal)
  assert.deepEqual(await rows(replay.transcriptPath), published)
  if (position === 'tool') records.messages[1].content[0].output = 'CHANGED'
  else records.messages[1].content = ['CHANGED']
  await assert.rejects(transcript.preparePrompt(future, current, current.turnSignal), { code: 'WAKE_HISTORY_OWNER_MISMATCH' })
  assert.deepEqual(await rows(view.transcriptPath), published)
})
