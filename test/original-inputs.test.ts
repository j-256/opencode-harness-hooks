import assert from 'node:assert/strict'
import { test } from 'node:test'
import { OriginalInputs } from '../src/original-inputs.js'
import { Sessions } from '../src/sessions.js'

const options = { maxCalls: 1, maxBytes: 4096, limitCode: 'CALL_LIMIT', bytesCode: 'BYTE_LIMIT', reusedCode: 'CALL_REUSED' }

test('original inputs preserve session and tool ownership, immutable snapshots and quota recovery on close', () => {
  const inputs = new OriginalInputs(options), sessions = new Sessions()
  sessions.prompt('first', 'turn', 'fixture'); sessions.prompt('second', 'turn', 'fixture')
  inputs.remember(sessions.get('first'), 'call', 'bash', { command: 'original' })
  assert.throws(() => inputs.remember(sessions.get('second'), 'call', 'bash', { command: 'second' }), { code: 'CALL_LIMIT' })
  assert.throws(() => inputs.remember(sessions.get('first'), 'call', 'read', { command: 'original' }), { code: 'CALL_REUSED' })
  const foreign = new Sessions(); foreign.prompt('first', 'turn', 'fixture')
  assert.throws(() => inputs.remember(foreign.get('first'), 'call', 'bash', { command: 'original' }), { code: 'SESSION_SNAPSHOT_OWNER_MISMATCH' })
  const snapshot = inputs.snapshot('first')
  assert.ok(Object.isFrozen(snapshot.calls[0]!.input))
  sessions.close('first'); assert.equal(inputs.inspect().calls, 0)
  inputs.remember(sessions.get('second'), 'call', 'bash', { command: 'second' })
  assert.equal(inputs.inspect().calls, 1)
  inputs.dispose(); sessions.dispose(); foreign.dispose()
})

test('original input capture never executes getters or JSON hooks', () => {
  const inputs = new OriginalInputs(options), sessions = new Sessions(); sessions.prompt('session', 'turn', 'fixture')
  let reads = 0
  const unsafe = { get command() { reads++; return 'private' } }
  assert.throws(() => inputs.remember(sessions.get('session'), 'call', 'bash', unsafe), { code: 'SESSION_SNAPSHOT_SCHEMA_INVALID' })
  assert.throws(() => inputs.remember(sessions.get('session'), 'call', 'bash', { toJSON() { reads++; return {} } } as never), { code: 'SESSION_SNAPSHOT_SCHEMA_INVALID' })
  assert.equal(reads, 0)
  assert.equal(inputs.inspect().calls, 0)
  inputs.dispose(); sessions.dispose()
})
