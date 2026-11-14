import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { ClaudeTranscript } from '../src/transcript.js'
import { Sessions } from '../src/sessions.js'
import type { DispatchResult } from '../src/engine.js'
import type { HostNotificationEvent } from '../src/notification.js'
import type { HostPromptEvent } from '../src/prompt-types.js'
import { executeRegistration } from '../src/handlers.js'

const CREATED = Date.parse('2026-01-01T00:00:00Z')
const OUTPUT = 'ORIGINAL_TOOL_RESULT'
const digest = (text: string) => createHash('sha256').update(text).digest('hex')
const empty: DispatchResult = { entries: [], actions: [], cancelled: false, diagnostic: { dispatchID: 'dispatch', sessionID: 'session', event: 'UserPromptSubmit', durationMs: 0, cancelled: false, failed: 0, unsupported: 0, skipped: 0, background: 0, handlers: [] } }
function fixture(t: { after(callback: () => unknown): void }) {
  const sessions = new Sessions(); sessions.prompt('session', 'turn', 'model'); const session = sessions.get('session')
  let status = 'completed', output = OUTPUT
  const history = () => [
    { info: { role: 'user', id: 'turn', sessionID: 'session', time: { created: CREATED } }, parts: [{ type: 'text', text: 'GENUINE_PROMPT' }] },
    { info: { role: 'assistant', id: 'assistant', parentID: 'turn', sessionID: 'session', modelID: 'model', time: { created: CREATED + 1 } }, parts: [{ type: 'tool', tool: 'bash', callID: 'call', state: { status, output, time: { start: CREATED + 1, end: CREATED + 2 } } }] },
  ]
  const transcripts = new ClaudeTranscript({ host: 'v1', directory: process.cwd(), history: async () => ({ id: 'session', messages: history() }) })
  t.after(() => transcripts.dispose()); t.after(() => sessions.dispose())
  const prompt: HostPromptEvent = { host: 'v1', event: 'UserPromptSubmit', sessionID: 'session', messageID: 'turn', prompt: 'GENUINE_PROMPT', signal: session.turnSignal }
  transcripts.admitPrompt(prompt, session, empty)
  transcripts.observeModel({ host: 'v1', sessionID: 'session', messageID: 'turn', signal: session.turnSignal }, session)
  transcripts.observe({ host: 'v1', event: 'PreToolUse', sessionID: 'session', callID: 'call', tool: 'bash', toolInput: { command: 'original' }, effectiveInput: { command: 'original' }, signal: session.turnSignal }, session)
  const event: HostNotificationEvent = { ...prompt, prompt: 'OWNED_NOTIFICATION', notificationID: 'delivery', anchor: { kind: 'tool', sessionID: 'session', turnID: 'turn', messageID: 'assistant', callID: 'call', signature: digest(OUTPUT) } }
  return { sessions, session, transcripts, prompt, event, change: (next: string, text = OUTPUT) => { status = next; output = text } }
}

test('active notification callbacks can read the admitted genuine prompt and completed anchor without adding future artifacts', async t => {
  const f = fixture(t)
  const path = await f.transcripts.prepareNotification(f.event, f.session, f.session.turnSignal)
  const text = await readFile(path, 'utf8'), rows = text.trim().split('\n').map(line => JSON.parse(line))
  assert.equal(rows[0].message.content, 'GENUINE_PROMPT')
  assert.equal(rows.at(-1).message.content[0].content, OUTPUT)
  assert.ok(!text.includes('OWNED_NOTIFICATION')); assert.ok(!text.includes('queued_command'))
  assert.equal(f.transcripts.inspect().promptTurns, 1)
  await assert.rejects(f.transcripts.prepare(f.prompt, f.session, f.session.turnSignal), { code: 'TRANSCRIPT_PROMPT_ALREADY_ADMITTED' })
  assert.equal(await readFile(path, 'utf8'), text)
  assert.equal(await f.transcripts.prepareNotification(f.event, f.session, f.session.turnSignal), path)
  assert.equal(await readFile(path, 'utf8'), text)
})

test('foreign, stale, uncompleted and changed notification anchors cannot replace a published transcript', async t => {
  const f = fixture(t), path = await f.transcripts.prepareNotification(f.event, f.session, f.session.turnSignal), text = await readFile(path, 'utf8')
  const anchors = [
    { ...f.event.anchor, sessionID: 'foreign' }, { ...f.event.anchor, turnID: 'foreign' }, { ...f.event.anchor, messageID: 'foreign' },
    { ...f.event.anchor, callID: 'foreign' }, { ...f.event.anchor, signature: digest('changed') },
  ]
  for (const anchor of anchors) await assert.rejects(f.transcripts.prepareNotification({ ...f.event, anchor }, f.session, f.session.turnSignal), { code: 'TRANSCRIPT_NOTIFICATION_ANCHOR_UNAVAILABLE' })
  f.change('running'); await assert.rejects(f.transcripts.prepareNotification(f.event, f.session, f.session.turnSignal), { code: 'TRANSCRIPT_NOTIFICATION_ANCHOR_UNAVAILABLE' })
  f.change('completed', 'changed'); await assert.rejects(f.transcripts.prepareNotification(f.event, f.session, f.session.turnSignal), { code: 'TRANSCRIPT_NOTIFICATION_ANCHOR_UNAVAILABLE' })
  assert.equal(await readFile(path, 'utf8'), text)
  f.sessions.prompt('session', 'next', 'model')
  await assert.rejects(f.transcripts.prepareNotification(f.event, f.sessions.get('session'), f.sessions.get('session').turnSignal), { code: 'TRANSCRIPT_NOTIFICATION_ANCHOR_UNAVAILABLE' })
  await assert.rejects(f.transcripts.prepareNotification(f.event, f.session, new AbortController().signal), { code: 'TRANSCRIPT_CANCELLED' })
})

test('idle notifications reserve their new identity without admitting another genuine prompt', async t => {
  const f = fixture(t); f.sessions.prompt('session', 'system-turn', 'model'); const session = f.sessions.get('session')
  const event: HostNotificationEvent = { ...f.event, messageID: 'system-turn', signal: session.turnSignal, anchor: { kind: 'prompt', sessionID: 'session', turnID: 'system-turn', messageID: 'system-turn', signature: digest(JSON.stringify([f.event.prompt])) } }
  const path = await f.transcripts.prepareNotification(event, session, session.turnSignal), text = await readFile(path, 'utf8')
  assert.ok(text.includes('GENUINE_PROMPT')); assert.ok(!text.includes('OWNED_NOTIFICATION'))
  assert.equal(f.transcripts.inspect().promptTurns, 1)
  await assert.rejects(f.transcripts.prepareNotification({ ...event, anchor: { ...event.anchor, signature: digest('foreign') } }, session, session.turnSignal), { code: 'TRANSCRIPT_NOTIFICATION_ANCHOR_UNAVAILABLE' })
})

test('an active notification preserves one copy of the startup attachments bound to its genuine prompt', async t => {
  const f = fixture(t), event = { host: 'v1' as const, event: 'SessionStart' as const, sessionID: 'session', activationID: 'activation', cwd: process.cwd(), data: { source: 'startup', transcript_path: '/unused' } }
  const result = await executeRegistration({ id: 'start', sourceID: 'source', dialect: 'claude-code', event: 'SessionStart', groupIndex: 0, handlerIndex: 0, handler: { type: 'command', command: 'printf START_CONTEXT' } }, event, { projectRoot: process.cwd(), environment: {}, captureCommandArtifacts: true })
  assert.equal(result.status, 'success')
  f.transcripts.admitStart({ event, session: f.session, signal: f.session.signal, dispatch: { ...empty, entries: [{ sourceID: 'source', sourceDigest: 'a'.repeat(64), registrationID: 'start', dialect: 'claude-code', configuredOrder: 0, completionOrder: 0, result }], diagnostic: { ...empty.diagnostic, event: 'SessionStart' } } })
  f.transcripts.bindStart(f.session, 'activation', 'turn')
  const path = await f.transcripts.prepareNotification(f.event, f.session, f.session.turnSignal), rows = (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.equal(rows.filter(row => row.attachment?.hookEvent === 'SessionStart').length, 1)
  assert.equal(rows[0].attachment.content, 'START_CONTEXT')
  assert.equal(new Set(rows.map(row => row.uuid)).size, rows.length)
})
