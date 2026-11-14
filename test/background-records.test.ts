import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BackgroundRecords } from '../src/background-records.js'
import { Sessions } from '../src/sessions.js'
import type { BackgroundDelivery } from '../src/background-types.js'
import type { Registration } from '../src/types.js'

const digest = 'a'.repeat(64), signature = 'b'.repeat(64)
const registration: Registration = { id: 'hook', sourceID: 'native', sourceDigest: digest, dialect: 'claude-code', event: 'UserPromptSubmit', groupIndex: 0, handlerIndex: 0, handler: { type: 'command', command: 'fixture', async: true } }
function delivery(id = 'job'): BackgroundDelivery {
  return { id, sourceID: 'native', sourceDigest: digest, registrationID: 'hook', dialect: 'claude-code', event: 'UserPromptSubmit', mode: 'safe-point', actions: [{ kind: 'context', placement: 'model', channel: 'systemMessage', text: 'LATE_CONTEXT' }], completion: { completedAt: 1700000000000, execution: { status: 'exited', exitCode: 0, signal: null, stdout: '{"systemMessage":"LATE_CONTEXT"}', stderr: '', durationMs: 1, processID: 12345 } } }
}
function fixture() {
  const sessions = new Sessions(), records = new BackgroundRecords({ registrations: [registration] })
  sessions.prompt('session', 'user')
  const anchor = { kind: 'prompt' as const, sessionID: 'session', turnID: 'user', messageID: 'user', signature }
  return { sessions, records, anchor, owner: () => sessions.get('session') }
}

test('source-bound completions are copied once and only a committed verified anchor makes model history visible', () => {
  const f = fixture(), input = delivery()
  assert.equal(f.records.admit(f.owner(), input), true)
  assert.equal(f.records.read(f.owner())[0]!.anchor, undefined)
  assert.equal(f.records.admit(f.owner(), input), false)
  const mutableExecution = input.completion!.execution as { stdout: string }; mutableExecution.stdout = 'Changed caller data'
  const reserved = f.records.reserveBind(f.owner(), f.anchor)
  assert.throws(() => f.records.read(f.owner()), { code: 'BACKGROUND_BINDING_PENDING' })
  reserved.commit()
  const rows = f.records.read(f.owner())
  assert.equal(rows.length, 1); assert.deepEqual(JSON.parse(JSON.stringify(rows[0]!.anchor)), f.anchor)
  assert.deepEqual(rows[0]!.model, ['<system-reminder>\nLATE_CONTEXT\n</system-reminder>'])
  assert.equal(rows[0]!.artifact!.body.type, 'attachment')
  assert.ok(Object.isFrozen(rows)); assert.ok(Object.isFrozen(rows[0]!))
  assert.equal(JSON.stringify(f.records.inspect()).includes('LATE_CONTEXT'), false)
})

test('changed evidence under a reused job ID and unreviewed source revisions cannot publish new history', () => {
  const f = fixture(); f.records.admit(f.owner(), delivery())
  assert.throws(() => f.records.admit(f.owner(), { ...delivery(), completion: { ...delivery().completion!, execution: { ...delivery().completion!.execution, stdout: '{}' } } }), { code: 'BACKGROUND_DELIVERY_REUSED' })
  assert.throws(() => f.records.admit(f.owner(), { ...delivery('other'), sourceDigest: 'c'.repeat(64) }), { code: 'BACKGROUND_SOURCE_UNAVAILABLE' })
  assert.equal(f.records.read(f.owner()).length, 1)
})

test('binding release preserves newly completed jobs and old turn cancellation does not kill session-owned admission', () => {
  const f = fixture(), old = f.owner(); f.records.admit(old, delivery())
  const reservation = f.records.reserveBind(old, f.anchor)
  f.records.admit(old, delivery('late'))
  reservation.release()
  assert.ok(f.records.read(old).every(row => row.anchor === undefined))
  f.sessions.prompt('session', 'next')
  assert.equal(f.records.admit(old, delivery('after-turn')), true)
  assert.throws(() => f.records.reserveBind(old, f.anchor), { code: 'BACKGROUND_TURN_UNAVAILABLE' })
  assert.throws(() => f.records.reserveBind(f.owner(), { ...f.anchor, sessionID: 'foreign', turnID: 'next', messageID: 'next' }), { code: 'BACKGROUND_ANCHOR_INVALID' })
  f.records.reserveBind(f.owner(), { ...f.anchor, turnID: 'next', messageID: 'next' }).commit()
  assert.ok(f.records.read(f.owner()).every(row => row.anchor?.turnID === 'next'))
})

test('snapshot replay preserves accepted history across source changes and rejects malformed or altered evidence atomically', () => {
  const f = fixture(); f.records.admit(f.owner(), delivery()); f.records.reserveBind(f.owner(), f.anchor).commit()
  const snapshot = f.records.snapshotV1('session'), sessions = new Sessions(); sessions.prompt('session', 'later')
  const target = new BackgroundRecords({ registrations: [{ ...registration, sourceDigest: 'c'.repeat(64) }] })
  const rollback = target.restoreV1(sessions.get('session'), snapshot)
  assert.deepEqual(JSON.parse(JSON.stringify(target.read(sessions.get('session')))), JSON.parse(JSON.stringify(f.records.read(f.owner()))))
  assert.equal(target.admit(sessions.get('session'), delivery()), false)
  assert.throws(() => target.admit(sessions.get('session'), delivery('new')), { code: 'BACKGROUND_SOURCE_UNAVAILABLE' })
  rollback(); assert.equal(target.inspect().sessions, 0)
  for (const mutate of [(value: Record<string, unknown>) => { value.unknown = true }, (value: Record<string, unknown>) => { (value.rows as { delivery: BackgroundDelivery }[])[0]!.delivery = { ...delivery(), completion: { ...delivery().completion!, execution: { ...delivery().completion!.execution, stdout: 'Changed stored bytes' } } } }]) {
    const changed = JSON.parse(JSON.stringify(snapshot)); mutate(changed)
    assert.throws(() => target.restoreV1(sessions.get('session'), changed)); assert.equal(target.inspect().sessions, 0)
  }
})

test('Codex warnings have a separate idempotent acknowledgement and never become model context', () => {
  const sessions = new Sessions(); sessions.prompt('session', 'user')
  const records = new BackgroundRecords({ registrations: [{ ...registration, dialect: 'codex' }] })
  const input: BackgroundDelivery = { ...delivery(), dialect: 'codex', actions: [{ kind: 'warning', text: 'UI_ONLY' }, { kind: 'context', placement: 'model', text: 'DEVELOPER_CONTEXT' }] }
  records.admit(sessions.get('session'), input)
  assert.deepEqual(records.warnings(sessions.get('session')), [{ id: 'job', texts: ['UI_ONLY'] }])
  assert.deepEqual(records.read(sessions.get('session'))[0]!.model, ['DEVELOPER_CONTEXT'])
  records.acknowledgeWarnings(sessions.get('session'), ['job']); records.acknowledgeWarnings(sessions.get('session'), ['job'])
  assert.deepEqual(records.warnings(sessions.get('session')), [])
  records.admit(sessions.get('session'), input); assert.deepEqual(records.warnings(sessions.get('session')), [])
  const target = new BackgroundRecords(); target.restoreV1(sessions.get('session'), records.snapshotV1('session'))
  assert.deepEqual(target.warnings(sessions.get('session')), [])
})

test('receipt and raw-byte limits apply without evicting history or reopening deleted sessions', () => {
  const f = fixture(), limited = new BackgroundRecords({ registrations: [registration], maxRecords: 1 })
  const ignored = { ...delivery(), actions: [], completion: { ...delivery().completion!, execution: { ...delivery().completion!.execution, stdout: '{}' } } }
  assert.equal(limited.admit(f.owner(), ignored), false)
  assert.throws(() => limited.admit(f.owner(), delivery('second')), { code: 'BACKGROUND_RECORD_LIMIT' })
  const small = new BackgroundRecords({ registrations: [registration], maxBytes: 256 })
  assert.throws(() => small.admit(f.owner(), delivery()), { code: 'BACKGROUND_RECORD_LIMIT' })
  assert.equal(small.inspect().records, 0)
  f.records.admit(f.owner(), delivery()); f.records.removeSession('session')
  assert.throws(() => f.records.admit(f.owner(), delivery('late')), { code: 'BACKGROUND_SESSION_CLOSED' })
  assert.equal(f.records.inspect().records, 0)
})

test('failed artifact admission and a snapshot budget failure leave no allocated session state', () => {
  const f = fixture(), original = delivery(), { processID: _processID, ...execution } = original.completion!.execution
  assert.throws(() => f.records.admit(f.owner(), { ...original, completion: { ...original.completion!, execution } }), { code: 'BACKGROUND_ARTIFACT_IDENTITY_UNAVAILABLE' })
  assert.equal(f.records.inspect().sessions, 0)
  f.records.admit(f.owner(), delivery())
  const snapshotBytes = Buffer.byteLength(JSON.stringify({ value: f.records.snapshotV1('session') }))
  const small = new BackgroundRecords({ registrations: [registration], maxBytes: snapshotBytes - 1 })
  assert.throws(() => small.admit(f.owner(), delivery()), { code: 'BACKGROUND_RECORD_LIMIT' })
  assert.equal(small.inspect().sessions, 0)
})

test('a released binding cannot later acknowledge a model delivery that was rolled back', () => {
  const f = fixture(); f.records.admit(f.owner(), delivery())
  const reservation = f.records.reserveBind(f.owner(), f.anchor); reservation.release()
  assert.throws(() => reservation.commit(), { code: 'BACKGROUND_BINDING_STALE' })
  assert.equal(f.records.read(f.owner())[0]!.anchor, undefined)
})

test('the byte budget covers all retained sessions without evicting already accepted history', () => {
  const f = fixture(); f.records.admit(f.owner(), delivery())
  const limited = new BackgroundRecords({ registrations: [registration], maxBytes: f.records.inspect().bytes + 32 })
  limited.admit(f.owner(), delivery())
  f.sessions.prompt('other-session', 'other-user')
  const before = limited.inspect()
  assert.throws(() => limited.admit(f.sessions.get('other-session'), delivery('other-job')), { code: 'BACKGROUND_RECORD_LIMIT' })
  assert.equal(limited.inspect().sessions, 1); assert.equal(limited.inspect().bytes, before.bytes)
  assert.equal(limited.read(f.owner()).length, 1)
})

test('acknowledged UI-only output releases its payload while retaining the duplicate delivery receipt', () => {
  const f = fixture(), records = new BackgroundRecords({ registrations: [{ ...registration, dialect: 'codex' }] })
  const input: BackgroundDelivery = { ...delivery(), dialect: 'codex', actions: [{ kind: 'warning', text: 'UI_ONLY' }] }
  records.admit(f.owner(), input); const before = records.inspect().bytes
  records.acknowledgeWarnings(f.owner(), ['job']); records.acknowledgeWarnings(f.owner(), ['job'])
  assert.equal(records.read(f.owner()).length, 0); assert.ok(records.inspect().bytes < before)
  assert.equal(records.admit(f.owner(), input), false); assert.deepEqual(records.warnings(f.owner()), [])
})

test('registration authority includes the copied handler signature rather than only its source and registration IDs', () => {
  const source = { ...registration, handler: { ...registration.handler } }, records = new BackgroundRecords({ registrations: [source] })
  records.assertRegistration(registration)
  source.handler.command = 'Changed caller command'
  records.assertRegistration(registration)
  assert.throws(() => records.assertRegistration(source), { code: 'BACKGROUND_SOURCE_UNAVAILABLE' })
})
