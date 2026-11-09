import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Sessions } from '../src/sessions.js'
import { V2StopEvents } from '../src/hosts/v2-stop-events.js'

const CREATED = Date.parse('2026-01-01T00:00:00Z')
const event = (type: string, seq: number, data: Record<string, unknown> = {}) => ({ id: 'event-' + seq, created: CREATED + seq, type: 'session.' + type, durable: { aggregateID: 'session', version: 1, seq }, data: { sessionID: 'session', ...data } })
const enqueue = (id: string, text: string, seq: number, type = 'user') => event('inbox.enqueued', seq, { inboxID: id, item: { type, payload: { text, ...(type === 'user' ? { files: [] } : { metadata: { source: 'fixture' } }) }, delivery: 'steer' } })
function fixture(t: { after: (callback: () => void) => void }) {
  const sessions = new Sessions(), events = new V2StopEvents()
  t.after(() => { events.dispose(); sessions.dispose() })
  sessions.prompt('session', 'original')
  const owner = sessions.get('session')
  return { sessions, events, owner }
}

test('V2 interruption follows delivered inbox ownership despite a newer prompt callback', t => {
  const { sessions, events, owner } = fixture(t)
  events.event(enqueue('original', 'Original', 1))
  events.accept(owner, 'Original')
  events.event(event('execution.started', 2))
  events.event(event('inbox.delivered', 4, { inboxID: 'original' }))
  sessions.prompt('session', 'next')
  const next = sessions.get('session')
  events.accept(next, 'Next')
  const receipt = events.event(event('execution.interrupted', 13, { reason: 'user' }))!
  assert.equal(receipt.owner.turnSignal, owner.turnSignal)
  assert.equal(receipt.owner.turnID, 'original')
  assert.equal(receipt.inputID, 'original')
  assert.equal(receipt.inputType, 'user')
  assert.equal(receipt.eventID, 'event-13')
  assert.equal(receipt.created, CREATED + 13)
  assert.equal(receipt.reason, 'user')
  assert.equal(sessions.interrupt(receipt.owner), false)
  assert.equal(next.turnSignal.aborted, false)
  assert.ok(Object.isFrozen(receipt) && Object.isFrozen(receipt.owner))
})

test('V2 execution retains its real owner through synthetic delivery and exact event replay', t => {
  const { events, owner } = fixture(t)
  events.accept(owner, 'Original')
  events.event(enqueue('original', 'Original', 1))
  events.event(event('execution.started', 2))
  events.event(event('inbox.delivered', 4, { inboxID: 'original' }))
  events.event(enqueue('synthetic', 'Marker', 11, 'synthetic'))
  events.event(event('inbox.delivered', 12, { inboxID: 'synthetic' }))
  const interrupted = event('execution.interrupted', 13, { reason: 'user' })
  const receipt = events.event(interrupted)!
  assert.equal(receipt.owner.turnSignal, owner.turnSignal)
  assert.equal(receipt.inputID, 'synthetic')
  assert.equal(receipt.inputType, 'synthetic')
  assert.equal(events.event(structuredClone(interrupted)), undefined)
  assert.throws(() => events.event({ ...interrupted, created: CREATED }), { code: 'HOST_STOP_EVENT_ORDER_INVALID' })
})

test('V2 events reject malformed envelopes, missing input ownership and mismatched accepted text', t => {
  const { events, owner } = fixture(t)
  for (const invalid of [
    { ...event('execution.started', 2), durable: { aggregateID: 'foreign', seq: 2, version: 1 } },
    { ...event('execution.started', 2), durable: { aggregateID: 'session', seq: 2, version: 2 } },
    { ...event('execution.started', 2), created: NaN },
    { ...event('execution.started', 2), id: '' },
    event('inbox.enqueued', 1, { inboxID: 'original', item: { type: ['user'], delivery: 'steer', payload: { text: 'Original' } } }),
    event('inbox.enqueued', 1, { inboxID: 'original', item: { type: 'user', delivery: ['steer'], payload: { text: 'Original' } } }),
  ]) assert.throws(() => events.event(invalid), { code: 'HOST_STOP_EVENT_INVALID' })
  events.event(enqueue('original', 'Original', 1))
  assert.throws(() => events.accept(owner, 'Changed'), { code: 'HOST_STOP_EVENT_OWNER_CHANGED' })
  events.accept(owner, 'Original')
  events.event(event('execution.started', 2))
  assert.throws(() => events.event(event('inbox.delivered', 4, { inboxID: 'unknown' })), { code: 'HOST_STOP_EVENT_INPUT_UNAVAILABLE' })
  events.event(event('inbox.delivered', 4, { inboxID: 'original' }))
  assert.throws(() => events.event(event('execution.interrupted', 5, { reason: 'invented' })), { code: 'HOST_STOP_EVENT_INVALID' })
  assert.equal(events.event(event('execution.interrupted', 5, { reason: 'shutdown' }))!.reason, 'shutdown')
})

test('V2 events reject input reuse, overlapping executions and out-of-order delivery', t => {
  const { events, owner } = fixture(t)
  events.accept(owner, 'Original')
  events.event(enqueue('original', 'Original', 1))
  assert.throws(() => events.event(enqueue('original', 'Original', 2)), { code: 'HOST_STOP_EVENT_INPUT_REUSED' })
  events.event(event('execution.started', 2))
  assert.throws(() => events.event(event('execution.started', 3)), { code: 'HOST_STOP_EVENT_EXECUTION_CHANGED' })
  events.event(event('inbox.delivered', 4, { inboxID: 'original' }))
  assert.throws(() => events.event(event('inbox.delivered', 3, { inboxID: 'original' })), { code: 'HOST_STOP_EVENT_ORDER_INVALID' })
  events.event(event('execution.succeeded', 10))
  assert.throws(() => events.event(event('execution.interrupted', 11, { reason: 'user' })), { code: 'HOST_STOP_EVENT_EXECUTION_CHANGED' })
})

test('V2 event ownership clears on session close and disposal', t => {
  const { sessions, events, owner } = fixture(t)
  events.accept(owner, 'Original')
  events.event(enqueue('original', 'Original', 1))
  sessions.close('session')
  assert.equal(events.inspect().inputs, 0)
  assert.equal(events.inspect().owners, 0)
  assert.equal(events.event(event('execution.interrupted', 2, { reason: 'user' })), undefined)
  assert.throws(() => events.accept(owner, 'Original'), { code: 'HOST_STOP_EVENT_CANCELLED' })
  events.dispose()
  assert.equal(events.inspect().sessions, 0)
  assert.throws(() => events.event(event('execution.started', 3)), { code: 'HOST_STOP_EVENT_CANCELLED' })
})

test('cancelled inbox items cannot acquire delivery ownership and failed executions cannot own the next receipt', t => {
  const { sessions, events, owner } = fixture(t)
  events.accept(owner, 'Original')
  events.event(enqueue('original', 'Original', 1))
  events.event(enqueue('cancelled', 'Cancelled', 2))
  events.event(event('inbox.cancelled', 3, { inboxID: 'cancelled' }))
  events.event(event('execution.started', 4))
  assert.throws(() => events.event(event('inbox.delivered', 5, { inboxID: 'cancelled' })), { code: 'HOST_STOP_EVENT_INPUT_UNAVAILABLE' })
  assert.throws(() => events.event(event('execution.interrupted', 5, { reason: 'user' })), { code: 'HOST_STOP_EVENT_OWNER_UNAVAILABLE' })
  events.event(event('inbox.delivered', 5, { inboxID: 'original' }))
  events.event(event('execution.failed', 10, { error: { name: 'Fixture' } }))
  sessions.prompt('session', 'next')
  const next = sessions.get('session')
  events.accept(next, 'Next')
  events.event(enqueue('next', 'Next', 11))
  events.event(event('execution.started', 12))
  events.event(event('inbox.delivered', 13, { inboxID: 'next' }))
  assert.equal(events.event(event('execution.interrupted', 14, { reason: 'user' }))!.owner.turnSignal, next.turnSignal)
})

test('V2 event input and session limits reject before retaining another item', t => {
  const { events } = fixture(t)
  for (let index = 0; index < 10000; index++) events.event(enqueue('input-' + index, 'Text', index + 1))
  const before = events.inspect()
  assert.throws(() => events.event(enqueue('overflow', 'Text', 10001)), { code: 'HOST_STOP_EVENT_LIMIT' })
  assert.deepEqual(events.inspect(), before)
  events.dispose()
  assert.equal(events.inspect().bytes, 0)
  const sessions = new V2StopEvents()
  t.after(() => sessions.dispose())
  for (let index = 0; index < 1024; index++) {
    const raw = enqueue('input', 'Text', 1)
    raw.data.sessionID = 'session-' + index
    raw.durable.aggregateID = raw.data.sessionID
    sessions.event(raw)
  }
  const raw = enqueue('input', 'Text', 1)
  raw.data.sessionID = 'overflow'
  raw.durable.aggregateID = raw.data.sessionID
  assert.throws(() => sessions.event(raw), { code: 'HOST_STOP_EVENT_LIMIT' })
  assert.equal(sessions.inspect().sessions, 1024)
})
