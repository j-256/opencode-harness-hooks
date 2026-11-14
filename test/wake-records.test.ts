import assert from 'node:assert/strict'
import { test } from 'node:test'
import { WakeRecords } from '../src/wake-records.js'
import { Sessions } from '../src/sessions.js'
import type { BackgroundDelivery } from '../src/background-types.js'
import type { Registration } from '../src/types.js'

const digest = 'a'.repeat(64)
const registration = (): Registration => ({ id: 'wake', sourceID: 'source', sourceDigest: digest, dialect: 'claude-code', event: 'UserPromptSubmit', groupIndex: 0, handlerIndex: 0, handler: { type: 'command', command: 'fixture', asyncRewake: true } })
const delivery = (id = 'job'): BackgroundDelivery => ({ id, sourceID: 'source', sourceDigest: digest, registrationID: 'wake', dialect: 'claude-code', event: 'UserPromptSubmit', mode: 'wake', actions: [{ kind: 'native-extension', name: 'asyncRewake', value: 'WAKE_CONTEXT\n' }], completion: { completedAt: 1700000000000, execution: { status: 'exited', exitCode: 2, signal: null, stdout: 'Ignored JSON', stderr: 'WAKE_CONTEXT\n', durationMs: 1, processID: 123 } } })

test('wake records copy current command authority and retain immutable native queue identities across duplicate deliveries and turns', t => {
  const sessions = new Sessions(), source = registration(), records = new WakeRecords({ registrations: [source] })
  sessions.prompt('session', 'first'); t.after(() => { records.dispose(); sessions.dispose() })
  records.assertRegistration(source)
  const handler = source.handler as { command: string }; handler.command = 'changed'
  assert.throws(() => records.assertRegistration(source), { code: 'WAKE_SOURCE_UNAVAILABLE' })
  const input = delivery(); assert.equal(records.admit(sessions.get('session'), input), true)
  const first = records.read(sessions.get('session'))[0]!
  assert.match(first.sourceUUID, /^[0-9a-f-]{36}$/); assert.match(first.deliveryID, /^[0-9a-f-]{36}$/)
  assert.notEqual(first.sourceUUID, first.deliveryID); assert.ok(first.text.model.includes('NOT USER INPUT'))
  assert.equal(records.admit(sessions.get('session'), delivery()), false)
  assert.deepEqual(records.read(sessions.get('session'))[0], first)
  ;(input.actions[0] as { value: string }).value = 'caller mutation'
  const retained = records.read(sessions.get('session'))[0]!.delivery.actions[0]!
  assert.equal(retained.kind, 'native-extension'); if (retained.kind === 'native-extension') assert.equal(retained.value, 'WAKE_CONTEXT\n')
  assert.ok(records.read(sessions.get('session'))[0]!.text.prompt.includes('WAKE_CONTEXT'))
  sessions.prompt('session', 'second'); assert.deepEqual(records.read(sessions.get('session'))[0], first)
  assert.ok(Object.isFrozen(first)); assert.ok(Object.isFrozen(first.delivery)); assert.ok(Object.isFrozen(first.delivery.completion!.execution))
})

test('wake admission rejects changed job evidence, foreign source revisions and raw/action mismatches', t => {
  const sessions = new Sessions(), records = new WakeRecords({ registrations: [registration()] }); t.after(() => { records.dispose(); sessions.dispose() })
  const session = sessions.get('session'); assert.equal(records.admit(session, delivery()), true)
  const input = delivery()
  for (const change of [
    { ...input, sourceDigest: 'b'.repeat(64) },
    { ...input, completion: { ...input.completion!, completedAt: 1700000000001 } },
  ]) assert.throws(() => records.admit(session, change), { code: 'WAKE_DELIVERY_REUSED' })
  assert.throws(() => records.admit(session, { ...delivery('foreign'), sourceDigest: 'b'.repeat(64) }), { code: 'WAKE_SOURCE_UNAVAILABLE' })
  for (const change of [
    { ...delivery('bad'), mode: 'safe-point' as const },
    { ...delivery('bad'), dialect: 'codex' as const },
    { ...delivery('bad'), actions: [{ kind: 'native-extension' as const, name: 'asyncRewake', value: 'forged' }] },
    { ...delivery('bad'), completion: { ...input.completion!, execution: { ...input.completion!.execution, exitCode: 0 } } },
  ]) assert.throws(() => records.admit(session, change), { code: 'WAKE_DELIVERY_INVALID' })
  assert.equal(records.inspect().records, 1)
})

test('strict cold queue restoration preserves history without command grants and rejects changed identities or missing receipts atomically', t => {
  const sessions = new Sessions(), records = new WakeRecords({ registrations: [registration()] }); t.after(() => { records.dispose(); sessions.dispose() })
  const session = sessions.get('session'); assert.equal(records.admit(session, delivery()), true)
  const snapshot = records.snapshotV1('session'), cold = new WakeRecords(); t.after(() => cold.dispose())
  const undo = cold.restoreV1(session, snapshot)
  assert.deepEqual(cold.read(session), records.read(session)); assert.equal(cold.admit(session, delivery()), false)
  assert.throws(() => cold.assertRegistration(registration()), { code: 'WAKE_SOURCE_UNAVAILABLE' })
  assert.throws(() => cold.admit(session, delivery('new')), { code: 'WAKE_SOURCE_UNAVAILABLE' })
  undo(); assert.deepEqual(cold.read(session), [])
  for (const mutate of [
    (value: any) => { value.rows[0].sourceUUID = value.rows[0].deliveryID },
    (value: any) => { value.receipts = [] },
    (value: any) => { value.rows.push(structuredClone(value.rows[0])) },
    (value: any) => { value.sessionID = 'foreign' },
    (value: any) => { value.unknown = true },
  ]) {
    const wrong = structuredClone(snapshot); mutate(wrong)
    assert.throws(() => cold.restoreV1(session, wrong)); assert.deepEqual(cold.read(session), [])
  }
})

test('wake queue budgets include derived context and closed identities without evicting retained jobs or reopening sessions', t => {
  const sessions = new Sessions(), records = new WakeRecords({ registrations: [registration()], maxRecords: 1 }), small = new WakeRecords({ registrations: [registration()], maxBytes: 1024 })
  t.after(() => { records.dispose(); small.dispose(); sessions.dispose() })
  const session = sessions.get('session'); assert.equal(records.admit(session, delivery()), true)
  assert.throws(() => records.admit(session, delivery('overflow')), { code: 'WAKE_RECORD_LIMIT' })
  assert.equal(records.inspect().records, 1)
  assert.throws(() => small.admit(session, delivery()), { code: 'WAKE_RECORD_LIMIT' }); assert.equal(small.inspect().sessions, 0)
  records.removeSession('session'); assert.equal(records.inspect().records, 0); assert.equal(records.inspect().closed, 1)
  assert.throws(() => records.admit(session, delivery('late')), { code: 'WAKE_SESSION_CLOSED' })
  assert.throws(() => records.read(session), { code: 'WAKE_SESSION_CLOSED' })
  records.dispose(); assert.throws(() => records.snapshotV1('other'), { code: 'WAKE_SESSION_CLOSED' })
})

test('a copied snapshot cannot change session ownership by relabelling its outer header', t => {
  const sessions = new Sessions(), source = new WakeRecords({ registrations: [registration()] }), cold = new WakeRecords()
  t.after(() => { source.dispose(); cold.dispose(); sessions.dispose() })
  assert.equal(source.admit(sessions.get('session'), delivery()), true)
  const snapshot = structuredClone(source.snapshotV1('session')) as any; snapshot.sessionID = 'foreign'
  assert.throws(() => cold.restoreV1(sessions.get('foreign'), snapshot), { code: 'SESSION_SNAPSHOT_SCHEMA_INVALID' })
  assert.equal(cold.inspect().records, 0)
})

test('wake restoration cannot undo new accepted work or inherit another runtime lifetime', t => {
  const sessions = new Sessions(), source = new WakeRecords({ registrations: [registration()] }), cold = new WakeRecords({ registrations: [registration()] })
  t.after(() => { source.dispose(); cold.dispose(); sessions.dispose() })
  const session = sessions.get('session'); source.admit(session, delivery())
  const undo = cold.restoreV1(session, source.snapshotV1('session'))
  cold.admit(session, delivery('later'))
  assert.throws(undo, { code: 'WAKE_STATE_CHANGED' }); assert.equal(cold.inspect().records, 2)
  assert.throws(() => cold.read({ ...session, signal: new AbortController().signal }), { code: 'WAKE_OWNER_MISMATCH' })
})

test('failed source changes leave existing command authority and retained queue data intact', t => {
  const sessions = new Sessions(), source = registration(), records = new WakeRecords({ registrations: [source], maxBytes: 4096 })
  t.after(() => { records.dispose(); sessions.dispose() })
  records.admit(sessions.get('session'), delivery())
  assert.throws(() => records.configure([{ ...source, sourceID: 's'.repeat(4096) }]), { code: 'WAKE_RECORD_LIMIT' })
  records.assertRegistration(source); assert.equal(records.inspect().records, 1)
  assert.throws(() => records.configure([{ ...source, handler: { ...source.handler, asyncRewake: false, async: true } }]), { code: 'WAKE_SOURCE_INVALID' })
  records.assertRegistration(source)
  records.configure([]); assert.equal(records.read(sessions.get('session')).length, 1)
  assert.throws(() => records.admit(sessions.get('session'), delivery('unselected')), { code: 'WAKE_SOURCE_UNAVAILABLE' })
})

test('restoring an empty queue does not reserve a retained session or charge an unused header', t => {
  const sessions = new Sessions(), source = new WakeRecords({ registrations: [registration()] }), tight = new WakeRecords({ registrations: [registration()], maxBytes: source.inspect().bytes })
  t.after(() => { source.dispose(); tight.dispose(); sessions.dispose() })
  const before = tight.inspect().bytes
  assert.doesNotThrow(() => tight.restoreV1(sessions.get('session'), source.snapshotV1('session')))
  assert.equal(tight.inspect().bytes, before); assert.equal(tight.inspect().sessions, 0)
})
