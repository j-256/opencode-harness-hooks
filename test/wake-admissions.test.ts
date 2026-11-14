import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { WakeRecords } from '../src/wake-records.js'
import { Sessions } from '../src/sessions.js'
import { executeRegistration } from '../src/handlers.js'
import type { BackgroundDelivery } from '../src/background-types.js'
import type { BackgroundAnchor } from '../src/background-records.js'
import type { DispatchResult } from '../src/engine.js'
import type { HostNotificationEvent } from '../src/notification.js'
import type { Registration } from '../src/types.js'

const DIGEST = 'a'.repeat(64)
const registration: Registration = { id: 'wake', sourceID: 'source', sourceDigest: DIGEST, dialect: 'claude-code', event: 'UserPromptSubmit', groupIndex: 0, handlerIndex: 0, handler: { type: 'command', command: 'owned', asyncRewake: true } }
const delivery: BackgroundDelivery = { id: 'job', sourceID: 'source', sourceDigest: DIGEST, registrationID: 'wake', dialect: 'claude-code', event: 'UserPromptSubmit', mode: 'wake', actions: [{ kind: 'native-extension', name: 'asyncRewake', value: 'OWNED_WAKE' }], completion: { completedAt: 1700000000000, execution: { status: 'exited', exitCode: 2, signal: null, stdout: '', stderr: 'OWNED_WAKE', durationMs: 1, processID: 123 } } }
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const tool: BackgroundAnchor = { kind: 'tool', sessionID: 'session', turnID: 'turn', messageID: 'answer', callID: 'call', signature: hash('ORIGINAL_RESULT') }
function fixture(t: { after(callback: () => unknown): void }, maxBytes?: number) {
  const sessions = new Sessions(), records = new WakeRecords({ registrations: [registration], ...(maxBytes === undefined ? {} : { maxBytes }) })
  t.after(() => records.dispose()); t.after(() => sessions.dispose()); sessions.prompt('session', 'turn', 'model')
  const session = sessions.get('session'); records.admit(session, delivery)
  const input = (attempt: { readonly id: string; readonly promptID: string; readonly anchor: BackgroundAnchor }): HostNotificationEvent => ({ host: 'v1', event: 'UserPromptSubmit', sessionID: 'session', messageID: attempt.promptID, prompt: records.read(session)[0]!.text.prompt, notificationID: attempt.id, anchor: attempt.anchor, signal: session.turnSignal })
  return { sessions, records, session, input }
}
async function dispatch(input: HostNotificationEvent, output = JSON.stringify({ systemMessage: 'UI_ONLY', hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'CALLBACK_CONTEXT' } })): Promise<DispatchResult> {
  const source: Registration = { ...registration, id: 'callback', handler: { type: 'command', command: 'printf %s ' + "'" + output.replaceAll("'", "'\"'\"'") + "'" } }
  const result = await executeRegistration(source, { host: 'v1', event: 'UserPromptSubmit', sessionID: input.sessionID, cwd: process.cwd(), data: { prompt: input.prompt, prompt_id: input.messageID, transcript_path: '/unused', permission_mode: 'default', model: 'model' } }, { projectRoot: process.cwd(), environment: {}, captureCommandArtifacts: true })
  const entry = { sourceID: 'source', sourceDigest: DIGEST, registrationID: 'callback', dialect: 'claude-code' as const, configuredOrder: 0, completionOrder: 0, result }
  const { result: _result, ...origin } = entry
  return { entries: [entry], actions: result.actions.map(action => ({ ...origin, action })), cancelled: false, diagnostic: { dispatchID: 'dispatch', sessionID: 'session', event: 'UserPromptSubmit', durationMs: 1, cancelled: false, failed: 0, unsupported: 0, skipped: 0, background: 0, handlers: [] } }
}

test('accepted notification callbacks retain independent artifacts and bind once to the original model carrier', async t => {
  const f = fixture(t), attempt = f.records.begin(f.session, 'job', tool), event = f.input(attempt), result = await dispatch(event)
  assert.equal(f.records.capture(f.session, event, result), true)
  const evaluated = f.records.read(f.session)[0]!, receipt = evaluated.attempts[0]!.result!
  assert.equal(receipt.outcome, 'allow'); assert.deepEqual(receipt.warnings, ['UI_ONLY']); assert.equal(receipt.attachments.length, 2)
  assert.equal(f.records.capture(f.session, event, result), false)
  assert.deepEqual(f.records.read(f.session)[0], evaluated)
  assert.throws(() => f.records.begin(f.session, 'job', tool), { code: 'WAKE_ATTEMPT_UNRESOLVED' })
  const binding = f.records.reserveBind(f.session, 'job', attempt.id, tool)
  assert.throws(() => f.records.read(f.session), { code: 'WAKE_BINDING_PENDING' })
  const saved = await binding.persist(async () => f.records.snapshotV1('session'))
  binding.commit()
  const bound = f.records.read(f.session)[0]!.binding!
  assert.deepEqual(bound.anchor, tool); assert.equal(bound.attemptID, attempt.id)
  assert.equal(bound.artifact.body.attachment && (bound.artifact.body.attachment as any).type, 'queued_command')
  assert.deepEqual(bound.model, [evaluated.text.model, '<system-reminder>\nUserPromptSubmit hook additional context: CALLBACK_CONTEXT\n</system-reminder>'])
  assert.ok(!bound.model.join('').includes('UI_ONLY'))
  assert.deepEqual(f.records.snapshotV1('session'), saved)
  const cold = new WakeRecords(); t.after(() => cold.dispose()); cold.restoreV1(f.session, saved)
  assert.deepEqual(cold.read(f.session), f.records.read(f.session))
  assert.throws(() => cold.assertRegistration(registration), { code: 'WAKE_SOURCE_UNAVAILABLE' })
})

test('notification attempts reject foreign ownership, changed dispatch receipts and incomplete evidence atomically', async t => {
  const f = fixture(t), attempt = f.records.begin(f.session, 'job', tool), event = f.input(attempt), result = await dispatch(event)
  const before = f.records.snapshotV1('session')
  for (const change of [{ ...event, prompt: 'foreign' }, { ...event, notificationID: 'foreign' }, { ...event, anchor: { ...tool, signature: hash('foreign') } }]) assert.throws(() => f.records.capture(f.session, change, result), { code: 'WAKE_ATTEMPT_OWNER_MISMATCH' })
  const entry = result.entries[0]!, stripped = { ...result, entries: [{ ...entry, result: Object.fromEntries(Object.entries(entry.result).filter(([key]) => key !== 'commandArtifact')) as typeof entry.result }] }
  assert.throws(() => f.records.capture(f.session, event, stripped))
  assert.deepEqual(f.records.snapshotV1('session'), before)
  f.records.capture(f.session, event, result)
  assert.throws(() => f.records.capture(f.session, event, { ...result, diagnostic: { ...result.diagnostic, dispatchID: 'other' } }), { code: 'WAKE_ATTEMPT_REUSED' })
  assert.throws(() => f.records.reserveBind(f.session, 'job', attempt.id, { ...tool, signature: hash('changed') }), { code: 'WAKE_BINDING_OWNER_MISMATCH' })
  assert.equal(f.records.read(f.session)[0]!.binding, undefined)
})

test('altered callback origins or aggregate actions cannot create a notification effect receipt', async t => {
  const f = fixture(t), attempt = f.records.begin(f.session, 'job', tool), event = f.input(attempt), result = await dispatch(event), before = f.records.snapshotV1('session')
  for (const invalid of [
    { ...result, actions: [] },
    { ...result, actions: result.actions.map(row => ({ ...row, sourceDigest: 'b'.repeat(64) })) },
    { ...result, entries: result.entries.map(row => ({ ...row, registrationID: 'foreign' })) },
  ]) { assert.throws(() => f.records.capture(f.session, event, invalid), { code: 'WAKE_DISPATCH_INVALID' }); assert.deepEqual(f.records.snapshotV1('session'), before) }
})

test('callback evidence stays session-owned after turn cancellation while its model binding stays unavailable', async t => {
  const f = fixture(t), attempt = f.records.begin(f.session, 'job', tool), event = f.input(attempt), result = await dispatch(event)
  f.sessions.prompt('session', 'next', 'model')
  assert.equal(f.records.capture(f.session, event, result), true)
  assert.equal(f.records.read(f.sessions.get('session'))[0]!.attempts[0]!.result!.outcome, 'allow')
  assert.throws(() => f.records.reserveBind(f.session, 'job', attempt.id, tool), { code: 'WAKE_ATTEMPT_OWNER_MISMATCH' })
  assert.throws(() => f.records.reserveBind(f.sessions.get('session'), 'job', attempt.id, tool), { code: 'WAKE_ATTEMPT_OWNER_MISMATCH' })
})

test('pending callback attempts survive cold restoration without duplicate execution or command authority', async t => {
  const f = fixture(t), pending = f.records.begin(f.session, 'job', tool), cold = new WakeRecords(); t.after(() => cold.dispose())
  cold.restoreV1(f.session, f.records.snapshotV1('session'))
  assert.equal(cold.read(f.session)[0]!.attempts[0]!.id, pending.id)
  assert.throws(() => cold.begin(f.session, 'job', tool), { code: 'WAKE_ATTEMPT_UNRESOLVED' })
  assert.throws(() => cold.assertRegistration(registration), { code: 'WAKE_SOURCE_UNAVAILABLE' })
})

test('callback byte limits leave the owned pending attempt unchanged', async t => {
  const f = fixture(t); f.records.begin(f.session, 'job', tool)
  const tight = fixture(t, f.records.inspect().bytes), attempt = tight.records.begin(tight.session, 'job', tool), event = tight.input(attempt), before = tight.records.snapshotV1('session')
  const result = await dispatch(event)
  assert.throws(() => tight.records.capture(tight.session, event, result), { code: 'WAKE_RECORD_LIMIT' })
  assert.deepEqual(tight.records.snapshotV1('session'), before)
})

test('a blocking callback consumes the notification while an active stop permits only its explicit idle retry', async t => {
  for (const outcome of ['block', 'stop'] as const) {
    const f = fixture(t), attempt = f.records.begin(f.session, 'job', tool), event = f.input(attempt)
    f.records.capture(f.session, event, await dispatch(event, JSON.stringify(outcome === 'block' ? { decision: 'block', reason: 'BLOCKED' } : { continue: false, stopReason: 'STOPPED' })))
    assert.equal(f.records.read(f.session)[0]!.attempts[0]!.result!.outcome, outcome)
    assert.throws(() => f.records.reserveBind(f.session, 'job', attempt.id, tool), { code: 'WAKE_NOTIFICATION_NOT_ADMITTED' })
    assert.throws(() => f.records.begin(f.session, 'job', tool), { code: 'WAKE_ATTEMPT_UNRESOLVED' })
    f.sessions.prompt('session', 'idle', 'model'); const session = f.sessions.get('session'), prompt = f.records.read(session)[0]!.text.prompt
    const anchor: BackgroundAnchor = { kind: 'prompt', sessionID: 'session', turnID: 'idle', messageID: 'idle', signature: hash(JSON.stringify([prompt])) }
    if (outcome === 'block') assert.throws(() => f.records.begin(session, 'job', anchor), { code: 'WAKE_ATTEMPT_UNRESOLVED' })
    else { const retry = f.records.begin(session, 'job', anchor); assert.notEqual(retry.id, attempt.id); assert.equal(retry.promptID, 'idle'); assert.equal(f.records.read(session)[0]!.attempts.length, 2) }
  }
})

test('provisional notification bindings isolate snapshots until rollback and release waiting writers', async t => {
  const f = fixture(t), attempt = f.records.begin(f.session, 'job', tool), event = f.input(attempt)
  f.records.capture(f.session, event, await dispatch(event))
  const before = f.records.snapshotV1('session'), binding = f.records.reserveBind(f.session, 'job', attempt.id, tool)
  assert.throws(() => f.records.snapshotV1('session'), { code: 'WAKE_BINDING_PENDING' })
  let ready = false; const pending = f.records.snapshotReady(f.session, f.session.signal).then(() => { ready = true })
  await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(ready, false)
  await binding.persist(async () => { assert.ok(f.records.snapshotV1('session')) })
  binding.release(); await pending
  assert.deepEqual(f.records.snapshotV1('session'), before)
  assert.throws(() => binding.commit(), { code: 'WAKE_BINDING_STALE' })
  assert.equal(f.records.read(f.session)[0]!.attempts.length, 1)
})

test('changed persisted notification effects and binding positions fail cold restoration without partial state', async t => {
  const f = fixture(t), attempt = f.records.begin(f.session, 'job', tool), event = f.input(attempt)
  f.records.capture(f.session, event, await dispatch(event)); f.records.reserveBind(f.session, 'job', attempt.id, tool).commit()
  const saved = f.records.snapshotV1('session')
  for (const mutate of [
    (value: any) => { value.rows[0].attempts[0].result.attachments[1].body.rendered[0].content = 'forged' },
    (value: any) => { value.rows[0].attempts[0].promptID = 'foreign' },
    (value: any) => { value.rows[0].binding.anchor.signature = hash('foreign') },
    (value: any) => { value.rows[0].binding.attemptID = 'foreign' },
  ]) {
    const cold = new WakeRecords(); t.after(() => cold.dispose()); const wrong = structuredClone(saved); mutate(wrong)
    assert.throws(() => cold.restoreV1(f.session, wrong)); assert.equal(cold.inspect().records, 0)
  }
})

test('an idle system binding preserves the raw native user form and a separate non-human model wrapper', async t => {
  const f = fixture(t), prompt = f.records.read(f.session)[0]!.text.prompt
  const anchor: BackgroundAnchor = { kind: 'prompt', sessionID: 'session', turnID: 'turn', messageID: 'turn', signature: hash(JSON.stringify([prompt])) }, attempt = f.records.begin(f.session, 'job', anchor), event = f.input(attempt)
  f.records.capture(f.session, event, await dispatch(event))
  assert.throws(() => f.records.reserveBind(f.session, 'job', attempt.id, anchor), { code: 'WAKE_BINDING_OWNER_MISMATCH' })
  assert.throws(() => f.records.reserveBind(f.session, 'job', attempt.id, anchor, { kind: 'system', promptIndex: 2, turnIndex: 1 }), { code: 'CLAUDE_WAKE_IDENTITY_INVALID' })
  f.records.reserveBind(f.session, 'job', attempt.id, anchor, { kind: 'system', promptIndex: 0, turnIndex: 2 }).commit()
  const binding = f.records.read(f.session)[0]!.binding!, body = JSON.parse(JSON.stringify(binding.artifact.body))
  assert.equal(body.type, 'user'); assert.equal(body.promptId, 'turn'); assert.equal(body.message.content, prompt)
  assert.deepEqual(body.origin, { kind: 'task-notification', producer: 'session-task' }); assert.deepEqual(body.turnPosition, { promptIndex: 0, turnIndex: 2 })
  assert.equal(body.queueSkipAttachments, true); assert.equal(Object.hasOwn(body, 'isMeta'), false)
  assert.ok(binding.model[0]!.includes('NOT USER INPUT')); assert.ok(!body.message.content.includes('NOT USER INPUT'))
  const cold = new WakeRecords(); t.after(() => cold.dispose()); cold.restoreV1(f.session, f.records.snapshotV1('session'))
  assert.deepEqual(cold.read(f.session), f.records.read(f.session))
})
