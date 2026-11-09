import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ModelContext } from '../src/model-context.js'
import { Sessions } from '../src/sessions.js'

const FIRST = new Date(2026, 0, 1, 12).getTime()
const NEXT = new Date(2026, 0, 2, 12).getTime()

test('observed local model dates have stable identity and coalesce across requests and same-day turns', () => {
  let time = FIRST
  const contexts = new ModelContext(() => time)
  const sessions = new Sessions()
  sessions.prompt('session', 'first')
  contexts.observe(sessions.get('session'))
  const first = contexts.read('session', 'first', true)!
  assert.equal(first.date, '2026-01-01')
  assert.equal(first.created, FIRST)
  contexts.observe(sessions.get('session'))
  assert.deepEqual(contexts.read('session', 'first', true), first)
  sessions.prompt('session', 'second')
  contexts.observe(sessions.get('session'))
  assert.equal(contexts.read('session', 'second', true), undefined)
  sessions.prompt('session', 'third')
  time = NEXT
  contexts.observe(sessions.get('session'))
  assert.equal(contexts.read('session', 'third', true)!.date, '2026-01-02')
  assert.notEqual(contexts.read('session', 'third', true)!.id, first.id)
  assert.equal(contexts.inspect().modelTurns, 3)
  assert.equal(contexts.inspect().modelDates, 2)
  sessions.close('session')
  assert.deepEqual(contexts.inspect(), { modelSessions: 0, modelTurns: 0, modelDates: 0, modelBytes: 0 })
  contexts.dispose()
})

test('missing, foreign, cancelled and reused model observations cannot invent or replace date records', () => {
  const contexts = new ModelContext(() => FIRST)
  const sessions = new Sessions()
  sessions.prompt('session', 'first')
  assert.equal(contexts.read('session', 'first', false), undefined)
  assert.throws(() => contexts.read('session', 'first', true), { code: 'TRANSCRIPT_MODEL_CONTEXT_UNAVAILABLE' })
  const first = sessions.get('session')
  contexts.observe(first)
  const original = contexts.read('session', 'first', true)
  const foreign = new Sessions()
  foreign.prompt('session', 'first')
  assert.throws(() => contexts.observe(foreign.get('session')), { code: 'TRANSCRIPT_SESSION_MISMATCH' })
  sessions.prompt('session', 'second')
  assert.throws(() => contexts.observe(first), { code: 'TRANSCRIPT_MODEL_CANCELLED' })
  contexts.observe(sessions.get('session'))
  sessions.prompt('session', 'first')
  assert.throws(() => contexts.observe(sessions.get('session')), { code: 'TRANSCRIPT_MODEL_TURN_REUSED' })
  assert.deepEqual(contexts.read('session', 'first', true), original)
  contexts.dispose()
  assert.throws(() => contexts.observe(sessions.get('session')), { code: 'TRANSCRIPT_MODEL_CANCELLED' })
  sessions.dispose(); foreign.dispose()
})

test('an unverified within-turn date change fails without rewriting historical dates', () => {
  let time = FIRST
  const contexts = new ModelContext(() => time)
  const sessions = new Sessions()
  sessions.prompt('session', 'first')
  contexts.observe(sessions.get('session'))
  const first = contexts.read('session', 'first', true)
  time = NEXT
  assert.throws(() => contexts.observe(sessions.get('session')), { code: 'TRANSCRIPT_DATE_BOUNDARY_UNVERIFIED' })
  assert.deepEqual(contexts.read('session', 'first', true), first)
  contexts.dispose(); sessions.dispose()
})

test('invalid clocks and excessive identity data fail without retaining partial calendar state', () => {
  const sessions = new Sessions()
  sessions.prompt('session', 'turn')
  for (const now of [() => Number.NaN, () => Infinity, () => { throw new Error('PRIVATE_CLOCK_DETAIL') }]) {
    const contexts = new ModelContext(now)
    assert.throws(() => contexts.observe(sessions.get('session')), { code: 'TRANSCRIPT_MODEL_CLOCK_UNAVAILABLE' })
    assert.equal(contexts.inspect().modelSessions, 0)
    assert.equal(contexts.inspect().modelBytes, 0)
    contexts.dispose()
  }
  const contexts = new ModelContext(() => FIRST)
  sessions.prompt('session', 'x'.repeat(8 * 1024 * 1024))
  assert.throws(() => contexts.observe(sessions.get('session')), { code: 'TRANSCRIPT_MODEL_LIMIT' })
  assert.equal(contexts.inspect().modelSessions, 0)
  assert.equal(contexts.inspect().modelTurns, 0)
  contexts.dispose(); sessions.dispose()
})

test('a clock callback cannot publish a date after cancellation or disposal', () => {
  for (const action of ['cancel', 'dispose']) {
    const sessions = new Sessions()
    sessions.prompt('session', 'turn')
    const contexts = new ModelContext(() => { if (action === 'cancel') sessions.close('session'); else contexts.dispose(); return FIRST })
    assert.throws(() => contexts.observe(sessions.get('session')), { code: 'TRANSCRIPT_MODEL_CANCELLED' })
    assert.equal(contexts.inspect().modelTurns, 0)
    assert.equal(contexts.inspect().modelSessions, 0)
    contexts.dispose(); sessions.dispose()
  }
})
