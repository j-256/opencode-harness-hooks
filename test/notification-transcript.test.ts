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
import { WakeRecords } from '../src/wake-records.js'
import type { Registration } from '../src/types.js'
import type { BackgroundDelivery } from '../src/background-types.js'
import { V1WakeInputs, wakeInputPart } from '../src/hosts/wake-inputs-v1.js'

const CREATED = Date.parse('2026-01-01T00:00:00Z')
const OUTPUT = 'ORIGINAL_TOOL_RESULT'
const digest = (text: string) => createHash('sha256').update(text).digest('hex')
const empty: DispatchResult = { entries: [], actions: [], cancelled: false, diagnostic: { dispatchID: 'dispatch', sessionID: 'session', event: 'UserPromptSubmit', durationMs: 0, cancelled: false, failed: 0, unsupported: 0, skipped: 0, background: 0, handlers: [] } }
function wakeQueue(t: { after(callback: () => unknown): void }) {
  const source: Registration = { id: 'wake', sourceID: 'source', sourceDigest: 'a'.repeat(64), dialect: 'claude-code', event: 'UserPromptSubmit', groupIndex: 0, handlerIndex: 0, handler: { type: 'command', command: 'owned', asyncRewake: true } }, wakes = new WakeRecords({ registrations: [source] })
  const delivery: BackgroundDelivery = { id: 'job', sourceID: 'source', sourceDigest: source.sourceDigest!, registrationID: 'wake', dialect: 'claude-code', event: 'UserPromptSubmit', mode: 'wake', actions: [{ kind: 'native-extension', name: 'asyncRewake', value: 'OWNED_WAKE' }], completion: { completedAt: CREATED + 3, execution: { status: 'exited', exitCode: 2, signal: null, stdout: '', stderr: 'OWNED_WAKE', durationMs: 1, processID: 123 } } }
  t.after(() => wakes.dispose()); return { source, wakes, delivery }
}
function fixture(t: { after(callback: () => unknown): void }, wakes?: WakeRecords) {
  const sessions = new Sessions(); sessions.prompt('session', 'turn', 'model'); const session = sessions.get('session')
  let status = 'completed', output = OUTPUT
  const extra: unknown[] = []
  const history = () => [
    { info: { role: 'user', id: 'turn', sessionID: 'session', time: { created: CREATED } }, parts: [{ type: 'text', text: 'GENUINE_PROMPT' }] },
    { info: { role: 'assistant', id: 'assistant', parentID: 'turn', sessionID: 'session', modelID: 'model', time: { created: CREATED + 1 } }, parts: [{ type: 'tool', tool: 'bash', callID: 'call', state: { status, output, time: { start: CREATED + 1, end: CREATED + 2 } } }] },
    ...extra,
  ]
  const transcripts = new ClaudeTranscript({ host: 'v1', directory: process.cwd(), ...(wakes ? { wakes } : {}), history: async () => ({ id: 'session', messages: history() }) })
  t.after(() => transcripts.dispose()); t.after(() => sessions.dispose())
  const prompt: HostPromptEvent = { host: 'v1', event: 'UserPromptSubmit', sessionID: 'session', messageID: 'turn', prompt: 'GENUINE_PROMPT', signal: session.turnSignal }
  transcripts.admitPrompt(prompt, session, empty)
  transcripts.observeModel({ host: 'v1', sessionID: 'session', messageID: 'turn', signal: session.turnSignal }, session)
  transcripts.observe({ host: 'v1', event: 'PreToolUse', sessionID: 'session', callID: 'call', tool: 'bash', toolInput: { command: 'original' }, effectiveInput: { command: 'original' }, signal: session.turnSignal }, session)
  const event: HostNotificationEvent = { ...prompt, prompt: 'OWNED_NOTIFICATION', notificationID: 'delivery', anchor: { kind: 'tool', sessionID: 'session', turnID: 'turn', messageID: 'assistant', callID: 'call', signature: digest(OUTPUT) } }
  return { sessions, session, transcripts, prompt, event, history, later: () => { extra.push({ info: { role: 'assistant', id: 'later-answer', parentID: 'turn', sessionID: 'session', modelID: 'model', time: { created: CREATED + 4 } }, parts: [{ type: 'tool', tool: 'bash', callID: 'later', state: { status: 'running' } }] }) }, change: (next: string, text = OUTPUT) => { status = next; output = text } }
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

test('accepted wake and source callback artifacts follow their completed tool once and survive cold transcript projection', async t => {
  const { source, wakes, delivery } = wakeQueue(t), f = fixture(t, wakes)
  wakes.admit(f.session, delivery)
  const attempt = wakes.begin(f.session, 'job', f.event.anchor), event = { ...f.event, notificationID: attempt.id, prompt: wakes.read(f.session)[0]!.text.prompt }
  const path = await f.transcripts.prepareNotification(event, f.session, f.session.turnSignal), before = await readFile(path, 'utf8')
  assert.ok(!before.includes('queued_command'))
  const output = JSON.stringify({ systemMessage: 'UI_ONLY', hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'CALLBACK_CONTEXT' } })
  const result = await executeRegistration({ ...source, id: 'callback', handler: { type: 'command', command: "printf '%s' '" + output + "'" } }, { host: 'v1', event: 'UserPromptSubmit', sessionID: 'session', cwd: process.cwd(), data: { prompt: event.prompt, transcript_path: path, permission_mode: 'default' } }, { projectRoot: process.cwd(), environment: {}, captureCommandArtifacts: true })
  const origin = { sourceID: 'source', sourceDigest: source.sourceDigest!, registrationID: 'callback', dialect: 'claude-code' as const, configuredOrder: 0, completionOrder: 0 }, dispatch = { ...empty, entries: [{ ...origin, result }], actions: result.actions.map(action => ({ ...origin, action })) }
  wakes.capture(f.session, event, dispatch); wakes.reserveBind(f.session, 'job', attempt.id, f.event.anchor).commit()
  const next = { host: 'v1' as const, event: 'PreToolUse' as const, sessionID: 'session', callID: 'later', tool: 'bash', toolInput: { command: 'later' }, effectiveInput: { command: 'later' }, signal: f.session.turnSignal }
  f.later(); f.transcripts.observe(next, f.session)
  const actual = (await readFile(await f.transcripts.prepare(next, f.session, f.session.turnSignal), 'utf8')).trim().split('\n').map(line => JSON.parse(line)), attachments = actual.filter(row => row.attachment)
  assert.deepEqual(attachments.map(row => row.attachment.type), ['date', 'queued_command', 'hook_system_message', 'hook_additional_context'])
  const index = actual.findIndex(row => row.attachment?.type === 'queued_command')
  assert.equal(actual[index - 1].message.content[0].content, OUTPUT)
  assert.equal(actual[index].attachment.prompt, event.prompt); assert.equal(actual[index + 1].attachment.content, 'UI_ONLY')
  assert.equal(actual[index + 2].rendered[0].content, '<system-reminder>\nUserPromptSubmit hook additional context: CALLBACK_CONTEXT\n</system-reminder>')
  assert.equal(new Set(actual.map(row => row.uuid)).size, actual.length)
  for (let i = 1; i < actual.length; i++) assert.equal(actual[i].parentUuid, actual[i - 1].uuid)
  const coldWakes = new WakeRecords(); t.after(() => coldWakes.dispose()); coldWakes.restoreV1(f.session, wakes.snapshotV1('session'))
  const cold = new ClaudeTranscript({ host: 'v1', directory: process.cwd(), wakes: coldWakes, history: async () => ({ id: 'session', messages: f.history() }) })
  t.after(() => cold.dispose()); cold.restoreV1(f.session, f.transcripts.snapshotV1('session'))
  const snapshot = f.transcripts.snapshotV1('session'); assert.deepEqual(cold.snapshotV1('session'), snapshot)
  assert.deepEqual((await readFile(await cold.prepare(next, f.session, f.session.turnSignal), 'utf8')).trim().split('\n').map(line => JSON.parse(line)), actual)
  await f.transcripts.prepare(next, f.session, f.session.turnSignal)
  assert.deepEqual((await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line)), actual)
  f.change('completed', 'changed')
  await assert.rejects(f.transcripts.prepare(next, f.session, f.session.turnSignal), { code: 'WAKE_HISTORY_OWNER_MISMATCH' })
  assert.deepEqual((await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line)), actual)
})

test('a saved terminal notification replays its native system and meta-user rows before a later genuine turn', async t => {
  const { source, wakes, delivery } = wakeQueue(t), f = fixture(t, wakes), inputs = new V1WakeInputs(); t.after(() => inputs.dispose())
  wakes.admit(f.session, delivery); const prompt = wakes.read(f.session)[0]!.text.prompt
  const ticket = inputs.prepare(f.session, { jobID: 'job', prompt, model: { providerID: 'provider', modelID: 'model' }, agent: 'build', promptIndex: 0, turnIndex: 2 })
  const message = { role: 'user', id: 'system', sessionID: 'session', model: { providerID: 'provider', modelID: 'model' }, agent: 'build', time: { created: CREATED + 3 } }, parts = [{ ...wakeInputPart(ticket, prompt, 'save'), id: 'part' }]
  inputs.claim(f.session, message, parts); f.sessions.prompt('session', 'system', 'model'); const system = f.sessions.get('session')
  const anchor = { kind: 'prompt' as const, sessionID: 'session', turnID: 'system', messageID: 'system', signature: digest(JSON.stringify([prompt])) }, attempt = wakes.begin(system, 'job', anchor)
  const event: HostNotificationEvent = { host: 'v1', event: 'UserPromptSubmit', sessionID: 'session', messageID: 'system', prompt, notificationID: attempt.id, anchor, signal: system.turnSignal }
  const path = await f.transcripts.prepareNotification(event, system, system.turnSignal)
  const result = await executeRegistration({ ...source, id: 'callback', handler: { type: 'command', command: "printf '%s' '{\"continue\":false,\"stopReason\":\"STOPPED\"}'" } }, { host: 'v1', event: 'UserPromptSubmit', sessionID: 'session', cwd: process.cwd(), data: { prompt, transcript_path: path, permission_mode: 'default' } }, { projectRoot: process.cwd(), environment: {}, captureCommandArtifacts: true })
  const origin = { sourceID: 'source', sourceDigest: source.sourceDigest!, registrationID: 'callback', dialect: 'claude-code' as const, configuredOrder: 0, completionOrder: 0 }
  wakes.capture(system, event, { ...empty, entries: [{ ...origin, result }], actions: result.actions.map(action => ({ ...origin, action })) })
  wakes.reserveBind(system, 'job', attempt.id, anchor, { kind: 'system', promptIndex: 0, turnIndex: 2 }).commit()
  inputs.saved(system, ticket.saveNonce, { info: message, parts }); inputs.finish(system, ticket.saveNonce, { info: message, parts })
  f.sessions.prompt('session', 'future', 'model'); const future = f.sessions.get('session')
  const later = { host: 'v1' as const, event: 'PreToolUse' as const, sessionID: 'session', callID: 'later', tool: 'bash', toolInput: { command: 'later' }, effectiveInput: { command: 'later' }, signal: future.turnSignal }
  const raw = [...f.history(), { info: message, parts }, { info: { role: 'user', id: 'future', sessionID: 'session', time: { created: CREATED + 4 } }, parts: [{ type: 'text', text: 'FUTURE_GENUINE' }] }, { info: { role: 'assistant', id: 'future-answer', parentID: 'future', sessionID: 'session', modelID: 'model', time: { created: CREATED + 5 } }, parts: [{ type: 'tool', tool: 'bash', callID: 'later', state: { status: 'running' } }] }]
  const replay = new ClaudeTranscript({ host: 'v1', directory: process.cwd(), wakes, history: async () => ({ id: 'session', messages: inputs.normalize('session', raw) }) }); t.after(() => replay.dispose())
  replay.restoreV1(future, f.transcripts.snapshotV1('session'))
  replay.admitPrompt({ host: 'v1', event: 'UserPromptSubmit', sessionID: 'session', messageID: 'future', prompt: 'FUTURE_GENUINE', signal: future.turnSignal }, future, empty)
  replay.observeModel({ host: 'v1', sessionID: 'session', messageID: 'future', signal: future.turnSignal }, future); replay.observe(later, future)
  const output = (await readFile(await replay.prepare(later, future, future.turnSignal), 'utf8')).trim().split('\n').map(line => JSON.parse(line)), index = output.findIndex(row => row.promptId === 'system' && row.isMeta !== true)
  assert.ok(index > 0); assert.equal(output[index].message.content, prompt); assert.equal(output[index].promptSource, 'system')
  assert.equal(output[index + 1].isMeta, true); assert.equal(output[index + 1].message.content, 'Operation stopped by hook: STOPPED')
  assert.deepEqual(output[index + 1].origin, { kind: 'task-notification', producer: 'session-task' })
  assert.equal(output[index + 2].message.content, 'FUTURE_GENUINE')
  assert.equal(new Set(output.map(row => row.uuid)).size, output.length)
  for (let i = 1; i < output.length; i++) assert.equal(output[i].parentUuid, output[i - 1].uuid)
  assert.equal(parts[0]!.synthetic, true)
})
