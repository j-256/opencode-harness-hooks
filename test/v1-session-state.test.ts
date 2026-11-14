import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { SessionStore } from '../src/session-store.js'
import { V1SessionState } from '../src/hosts/session-state-v1.js'
import { Sessions } from '../src/sessions.js'
import { BackgroundRecords } from '../src/background-records.js'
import type { BackgroundDelivery } from '../src/background-types.js'
import type { Registration } from '../src/types.js'

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

test('the known previous V1 state shape migrates narrowly while preserving untouched participant payloads', async t => {
  const f = await fixture(t), store = f.store(), sessions = new Sessions(), session = sessions.get('session')
  const previous = { kind: 'v1-session-state', version: 1, sessionID: 'session', claude: { original: 'retained' }, codex: null, contexts: null, pendingPrompts: [] }
  await store.save(await store.load('session'), previous); await store.dispose()
  const data = participant(), background = participant(), state = new V1SessionState(f.store(), { claude: data, background })
  await state.ensure(session); assert.deepEqual(JSON.parse(JSON.stringify(data.value())), previous.claude); assert.equal(background.restored(), 0)
  background.set({ retained: 'background' }); await state.checkpoint(session); await state.dispose()
  const readback = f.store(), payload = (await readback.load('session')).payload!
  assert.deepEqual(JSON.parse(JSON.stringify(payload.claude)), previous.claude); assert.deepEqual(JSON.parse(JSON.stringify(payload.background)), { retained: 'background' })
  await readback.dispose(); sessions.dispose()
})

test('unknown or partial V1 state layouts cannot use migration to bypass strict restoration', async t => {
  for (const extra of [{ unknown: true }, { background: null, unknown: true }]) {
    const f = await fixture(t), store = f.store(), sessions = new Sessions(), session = sessions.get('session')
    await store.save(await store.load('session'), { kind: 'v1-session-state', version: 1, sessionID: 'session', claude: null, codex: null, contexts: null, pendingPrompts: [], ...extra }); await store.dispose()
    const state = new V1SessionState(f.store(), { background: participant() })
    await assert.rejects(state.ensure(session), { code: 'SESSION_SNAPSHOT_SCHEMA_INVALID' }); await assert.rejects(state.requiresProjection(), { code: 'SESSION_SNAPSHOT_SCHEMA_INVALID' })
    await state.dispose(); sessions.dispose()
  }
})

test('extended background state participates in atomic restore rollback', async t => {
  const f = await fixture(t), store = f.store(), sessions = new Sessions(), session = sessions.get('session')
  const data = participant(), invalid = participant(), source = new V1SessionState(store, { claude: data, background: invalid })
  await source.ensure(session); data.set('original'); invalid.set('invalid'); await source.checkpoint(session); await source.dispose()
  const restoredData = participant(), restored = new V1SessionState(f.store(), { claude: restoredData, background: participant() })
  await assert.rejects(restored.ensure(session), /invalid/); assert.equal(restoredData.restored(), 0)
  await restored.dispose(); sessions.dispose()
})

test('cold startup detects accepted background model history without enabling its previous command source', async t => {
  for (const warningOnly of [false, true]) {
    const f = await fixture(t), sessions = new Sessions(), digest = 'a'.repeat(64)
    sessions.prompt('session', 'turn')
    const registration: Registration = { id: 'hook', sourceID: 'source', sourceDigest: digest, dialect: 'codex', event: 'UserPromptSubmit', groupIndex: 0, handlerIndex: 0, handler: { type: 'command', command: 'fixture', async: true } }
    const delivery: BackgroundDelivery = { id: 'job', sourceID: 'source', sourceDigest: digest, registrationID: 'hook', dialect: 'codex', event: 'UserPromptSubmit', mode: 'safe-point', actions: warningOnly ? [{ kind: 'warning', text: 'UI_ONLY' }] : [{ kind: 'context', placement: 'model', text: 'MODEL_CONTEXT' }], completion: { completedAt: 1700000000000, execution: { status: 'exited', exitCode: 0, signal: null, stdout: '{}', stderr: '', durationMs: 1 } } }
    const records = new BackgroundRecords({ registrations: [registration] }), source = new V1SessionState(f.store(), { background: records })
    await source.ensure(sessions.get('session')); records.admit(sessions.get('session'), delivery); await source.checkpoint(sessions.get('session')); await source.dispose(); records.dispose(); sessions.dispose()
    const coldSessions = new Sessions(), coldRecords = new BackgroundRecords(), cold = new V1SessionState(f.store(), { background: coldRecords })
    assert.equal(await cold.requiresProjection(), !warningOnly)
    await cold.ensure(coldSessions.get('session')); assert.equal(coldRecords.read(coldSessions.get('session'))[0]!.sourceDigest, digest)
    assert.throws(() => coldRecords.admit(coldSessions.get('session'), { ...delivery, id: 'new' }), { code: 'BACKGROUND_SOURCE_UNAVAILABLE' })
    await cold.dispose(); coldRecords.dispose(); coldSessions.dispose()
  }
})

test('an unrelated checkpoint waits for a background binding decision and cannot persist a released anchor', async t => {
  const f = await fixture(t), sessions = new Sessions(), digest = 'a'.repeat(64); sessions.prompt('session', 'turn')
  const registration: Registration = { id: 'hook', sourceID: 'source', sourceDigest: digest, dialect: 'codex', event: 'UserPromptSubmit', groupIndex: 0, handlerIndex: 0, handler: { type: 'command', command: 'fixture', async: true } }
  const records = new BackgroundRecords({ registrations: [registration] }), state = new V1SessionState(f.store(), { background: records }), session = sessions.get('session')
  await state.ensure(session)
  records.admit(session, { id: 'job', sourceID: 'source', sourceDigest: digest, registrationID: 'hook', dialect: 'codex', event: 'UserPromptSubmit', mode: 'safe-point', actions: [{ kind: 'context', placement: 'model', text: 'CONTEXT' }], completion: { completedAt: 1700000000000, execution: { status: 'exited', exitCode: 0, signal: null, stdout: '{}', stderr: '', durationMs: 1 } } })
  const binding = records.reserveBind(session, { kind: 'prompt', sessionID: 'session', turnID: 'turn', messageID: 'turn', signature: 'b'.repeat(64) })
  let sampled = false; const snapshot = records.snapshotV1.bind(records); records.snapshotV1 = sessionID => { sampled = true; return snapshot(sessionID) }
  const external = state.checkpoint(session)
  await new Promise(resolve => setImmediate(resolve)); const sampledBeforeDecision = sampled
  binding.release(); await external; await state.dispose()
  const store = f.store(), receipt = await store.load('session'), cold = new BackgroundRecords(); cold.restoreV1(session, receipt.payload!.background)
  const restoredAnchor = cold.read(session)[0]!.anchor
  await store.dispose(); cold.dispose(); records.dispose(); sessions.dispose()
  assert.equal(sampledBeforeDecision, false); assert.equal(restoredAnchor, undefined)
})
