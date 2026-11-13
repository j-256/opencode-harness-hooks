import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ModelContext } from '../src/model-context.js'
import { Sessions } from '../src/sessions.js'

const FIRST = new Date(2026, 0, 1, 12).getTime()
test('model date restoration preserves native identity and time without sampling the replacement clock', () => {
  const sourceSessions = new Sessions(), first = new ModelContext(() => FIRST)
  sourceSessions.prompt('session', 'first', 'fixture')
  first.observe(sourceSessions.get('session'))
  sourceSessions.prompt('session', 'second', 'fixture')
  first.observe(sourceSessions.get('session'))
  const snapshot = first.snapshot('session'), original = first.read('session', 'first', true)
  assert.ok(Object.isFrozen(snapshot))
  first.dispose(); sourceSessions.dispose()
  const sessions = new Sessions(), restored = new ModelContext(() => FIRST + 86400000)
  sessions.prompt('session', 'third', 'fixture')
  restored.restore(sessions.get('session'), snapshot)
  assert.deepEqual(restored.read('session', 'first', true), original)
  assert.equal(restored.read('session', 'second', true), undefined)
  restored.observe(sessions.get('session'))
  assert.notEqual(restored.read('session', 'third', true)!.id, original!.id)
  assert.equal(restored.read('session', 'third', true)!.date, '2026-01-02')
  sessions.close('session')
  assert.equal(restored.inspect().modelTurns, 0)
  restored.dispose(); sessions.dispose()
})

test('foreign, malformed and partially valid date snapshots cannot publish restored state', () => {
  const firstSessions = new Sessions(), first = new ModelContext(() => FIRST)
  firstSessions.prompt('session', 'first', 'fixture'); first.observe(firstSessions.get('session'))
  const snapshot = first.snapshot('session')
  for (const edit of [
    (value: any) => { value.sessionID = 'foreign' },
    (value: any) => { value.version = 0 },
    (value: any) => { value.lastTurnID = 'foreign' },
    (value: any) => { value.turns.push({ turnID: 'invalid', date: { id: 'bad', date: '2026-99-01', created: FIRST } }) },
  ]) {
    const sessions = new Sessions(), restored = new ModelContext(() => FIRST)
    const value = structuredClone(snapshot)
    edit(value)
    assert.throws(() => restored.restore(sessions.get('session'), value))
    assert.equal(restored.inspect().modelTurns, 0)
    restored.dispose(); sessions.dispose()
  }
  first.dispose(); firstSessions.dispose()
})

test('date snapshot restoration cannot overwrite active state or outlive its owned session', () => {
  const sessions = new Sessions(), dates = new ModelContext(() => FIRST)
  sessions.prompt('session', 'first', 'fixture'); dates.observe(sessions.get('session'))
  const snapshot = dates.snapshot('session')
  assert.throws(() => dates.restore(sessions.get('session'), snapshot), { code: 'SESSION_SNAPSHOT_STATE_CONFLICT' })
  const next = new ModelContext(() => FIRST), previous = sessions.get('session')
  sessions.close('session')
  assert.throws(() => next.restore(previous, snapshot), { code: 'SESSION_SNAPSHOT_CANCELLED' })
  next.dispose(); dates.dispose(); sessions.dispose()
})

test('restored date records cannot reuse one native identity for different turns', () => {
  const sessions = new Sessions(), first = new ModelContext(() => FIRST)
  sessions.prompt('session', 'first', 'fixture'); first.observe(sessions.get('session'))
  const value: any = structuredClone(first.snapshot('session'))
  value.turns.push({ turnID: 'second', date: { ...value.turns[0]!.date!, date: '2026-01-02' } })
  value.lastTurnID = 'second'; value.date = '2026-01-02'
  const restored = new ModelContext(() => FIRST), other = new Sessions()
  assert.throws(() => restored.restore(other.get('session'), value), { code: 'SESSION_SNAPSHOT_SCHEMA_INVALID' })
  assert.equal(restored.inspect().modelTurns, 0)
  restored.dispose(); other.dispose(); first.dispose(); sessions.dispose()
})
