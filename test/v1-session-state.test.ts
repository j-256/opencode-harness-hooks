import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { SessionStore } from '../src/session-store.js'
import { V1SessionState } from '../src/hosts/session-state-v1.js'
import { Sessions } from '../src/sessions.js'

async function fixture(t: { after: (callback: () => Promise<void>) => void }) {
  const project = await mkdtemp(join(tmpdir(), 'v1-native-state-'))
  t.after(() => rm(project, { recursive: true, force: true }))
  const store = () => new SessionStore({ directory: join(project, 'state'), project, host: 'v1', diagnostic: () => {} })
  return { store }
}
function participant() {
  let value: unknown = null, restored = 0
  return { set(input: unknown) { value = input }, value: () => value, restored: () => restored, snapshotV1: (_sessionID: string) => value, restoreV1: (_session: unknown, input: unknown) => { if (input === 'invalid') throw new Error('invalid'); const previous = value; value = input; restored++; return () => { value = previous; restored-- } } }
}

test('V1 session state loads before use and serializes checkpoints across a cold runtime without reexecuting effects', async t => {
  const f = await fixture(t), sessions = new Sessions(), first = participant(), contexts = participant()
  const state = new V1SessionState(f.store(), { claude: first, contexts })
  const session = sessions.get('session')
  await state.ensure(session)
  first.set({ original: 'argument' }); contexts.set({ prompt: 'context' })
  await state.checkpoint(session)
  await state.dispose(); sessions.dispose()
  const next = new Sessions(), second = participant(), restoredContexts = participant(), restored = new V1SessionState(f.store(), { claude: second, contexts: restoredContexts })
  await Promise.all([restored.ensure(next.get('session')), restored.ensure(next.get('session'))])
  assert.deepEqual(JSON.parse(JSON.stringify(second.value())), { original: 'argument' })
  assert.equal(second.restored(), 1)
  assert.deepEqual(JSON.parse(JSON.stringify(restoredContexts.value())), { prompt: 'context' })
  await restored.dispose(); next.dispose()
})

test('V1 session restoration rolls back earlier participants when a later participant rejects its snapshot', async t => {
  const f = await fixture(t), sessions = new Sessions(), first = participant(), contexts = participant(), store = f.store()
  const source = new V1SessionState(store, { claude: first, contexts })
  await source.ensure(sessions.get('session'))
  first.set('retained'); contexts.set('invalid')
  await source.checkpoint(sessions.get('session')); await source.dispose(); sessions.dispose()
  const next = new Sessions(), second = participant(), restored = new V1SessionState(f.store(), { claude: second, contexts: participant() })
  await assert.rejects(restored.ensure(next.get('session')), /invalid/)
  assert.equal(second.value(), null); assert.equal(second.restored(), 0)
  await assert.rejects(restored.ensure(next.get('session')), /invalid/)
  await restored.dispose(); next.dispose()
})

test('V1 session deletion fences durable resurrection and disposal preserves retained data', async t => {
  const f = await fixture(t), sessions = new Sessions(), data = participant(), source = new V1SessionState(f.store(), { claude: data })
  await source.ensure(sessions.get('session')); data.set('retained'); await source.checkpoint(sessions.get('session'))
  sessions.close('session'); await source.remove('session'); await source.dispose(); sessions.dispose()
  const next = new Sessions(), restored = new V1SessionState(f.store(), { claude: participant() })
  await assert.rejects(restored.ensure(next.get('session')), { code: 'SESSION_STORE_DELETED' })
  await restored.dispose(); next.dispose()
})

test('V1 state conflicts fail explicitly and cannot replace a newer durable snapshot', async t => {
  const f = await fixture(t), a = new Sessions(), b = new Sessions(), first = participant(), second = participant(), source = new V1SessionState(f.store(), { claude: first }), stale = new V1SessionState(f.store(), { claude: second })
  await source.ensure(a.get('session')); await stale.ensure(b.get('session'))
  first.set('newer'); await source.checkpoint(a.get('session'))
  second.set('stale'); await assert.rejects(stale.checkpoint(b.get('session')), { code: 'SESSION_STORE_CONFLICT' })
  await assert.rejects(stale.ensure(b.get('session')), { code: 'SESSION_STORE_CONFLICT' })
  await source.dispose(); await stale.dispose(); a.dispose(); b.dispose()
})
