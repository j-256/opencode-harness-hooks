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
import { WakeRecords } from '../src/wake-records.js'
import type { DispatchResult } from '../src/engine.js'
import { V1WakeInputs, wakeInputPart } from '../src/hosts/wake-inputs-v1.js'

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

for (const backgroundField of [false, true]) test(`known prior V1 layouts migrate narrowly without changing participant payloads, background field ${backgroundField}`, async t => {
  const f = await fixture(t), store = f.store(), sessions = new Sessions(), session = sessions.get('session')
  const previous = { kind: 'v1-session-state', version: 1, sessionID: 'session', claude: { original: 'retained' }, codex: null, contexts: null, pendingPrompts: [], ...(backgroundField ? { background: null } : {}) }
  await store.save(await store.load('session'), previous); await store.dispose()
  const data = participant(), background = participant(), state = new V1SessionState(f.store(), { claude: data, background })
  await state.ensure(session); assert.deepEqual(JSON.parse(JSON.stringify(data.value())), previous.claude); assert.equal(background.restored(), 0)
  background.set({ retained: 'background' }); await state.checkpoint(session); await state.dispose()
  const readback = f.store(), payload = (await readback.load('session')).payload!
  assert.deepEqual(JSON.parse(JSON.stringify(payload.claude)), previous.claude); assert.deepEqual(JSON.parse(JSON.stringify(payload.background)), { retained: 'background' })
  assert.equal(payload.wakes, null)
  assert.equal(payload.wakeInputs, null)
  await readback.dispose(); sessions.dispose()
})

test('unknown or partial V1 state layouts cannot use migration to bypass strict restoration', async t => {
  for (const extra of [{ unknown: true }, { background: null, unknown: true }, { wakes: null }, { background: null, wakes: null }, { background: null, wakes: null, unknown: true }]) {
    const f = await fixture(t), store = f.store(), sessions = new Sessions(), session = sessions.get('session')
    await store.save(await store.load('session'), { kind: 'v1-session-state', version: 1, sessionID: 'session', claude: null, codex: null, contexts: null, pendingPrompts: [], ...extra }); await store.dispose()
    const state = new V1SessionState(f.store(), { background: participant() })
    await assert.rejects(state.ensure(session), { code: 'SESSION_SNAPSHOT_SCHEMA_INVALID' }); await assert.rejects(state.requiresProjection(), { code: 'SESSION_SNAPSHOT_SCHEMA_INVALID' })
    await state.dispose(); sessions.dispose()
  }
})

async function wakeFixture(t: { after(callback: () => unknown): void }) {
  const f = await fixture(t), sessions = new Sessions(); sessions.prompt('session', 'turn', 'model')
  const registration: Registration = { id: 'hook', sourceID: 'source', sourceDigest: 'a'.repeat(64), dialect: 'claude-code', event: 'UserPromptSubmit', groupIndex: 0, handlerIndex: 0, handler: { type: 'command', command: 'owned', asyncRewake: true } }
  const wakes = new WakeRecords({ registrations: [registration] }), state = new V1SessionState(f.store(), { wakes }), session = sessions.get('session')
  t.after(async () => { await state.dispose(); wakes.dispose(); sessions.dispose() }); await state.ensure(session)
  wakes.admit(session, { id: 'job', sourceID: 'source', sourceDigest: registration.sourceDigest!, registrationID: 'hook', dialect: 'claude-code', event: 'UserPromptSubmit', mode: 'wake', actions: [{ kind: 'native-extension', name: 'asyncRewake', value: 'OWNED_WAKE' }], completion: { completedAt: 1700000000000, execution: { status: 'exited', exitCode: 2, signal: null, stdout: '', stderr: 'OWNED_WAKE', durationMs: 1, processID: 123 } } })
  const anchor = { kind: 'tool' as const, sessionID: 'session', turnID: 'turn', messageID: 'answer', callID: 'call', signature: 'b'.repeat(64) }, attempt = wakes.begin(session, 'job', anchor)
  const dispatch: DispatchResult = { entries: [], actions: [], cancelled: false, diagnostic: { dispatchID: 'dispatch', sessionID: 'session', event: 'UserPromptSubmit', durationMs: 0, cancelled: false, failed: 0, unsupported: 0, skipped: 0, background: 0, handlers: [] } }
  wakes.capture(session, { host: 'v1', event: 'UserPromptSubmit', sessionID: 'session', messageID: 'turn', prompt: wakes.read(session)[0]!.text.prompt, notificationID: attempt.id, anchor, signal: session.turnSignal }, dispatch)
  return { ...f, sessions, session, registration, wakes, state, anchor, attempt }
}

test('durable wake state survives a cold runtime without restoring source command grants', async t => {
  const f = await wakeFixture(t)
  const binding = f.wakes.reserveBind(f.session, 'job', f.attempt.id, f.anchor)
  await binding.persist(() => f.state.checkpoint(f.session, f.session.signal)); binding.commit(); await f.state.dispose()
  const sessions = new Sessions(), wakes = new WakeRecords(), state = new V1SessionState(f.store(), { wakes })
  t.after(async () => { await state.dispose(); wakes.dispose(); sessions.dispose() })
  assert.equal(await state.requiresProjection(), true)
  await state.ensure(sessions.get('session')); assert.deepEqual(wakes.read(sessions.get('session')), f.wakes.read(f.session))
  assert.throws(() => wakes.assertRegistration(f.registration), { code: 'WAKE_SOURCE_UNAVAILABLE' })
})

test('an unrelated durable checkpoint waits for the wake binding decision before sampling participants', async t => {
  const f = await wakeFixture(t), binding = f.wakes.reserveBind(f.session, 'job', f.attempt.id, f.anchor)
  let sampled = false; const snapshot = f.wakes.snapshotV1.bind(f.wakes); f.wakes.snapshotV1 = sessionID => { sampled = true; return snapshot(sessionID) }
  const external = f.state.checkpoint(f.session, f.session.signal)
  await new Promise<void>(resolve => setImmediate(resolve)); const sampledBeforeDecision = sampled
  binding.release(); await external; await f.state.dispose()
  const store = f.store(), payload = (await store.load('session')).payload!, cold = new WakeRecords(); t.after(async () => { await store.dispose(); cold.dispose() })
  cold.restoreV1(f.session, payload.wakes); assert.equal(cold.read(f.session)[0]!.binding, undefined)
  assert.equal(cold.read(f.session)[0]!.attempts[0]!.result!.outcome, 'allow'); assert.equal(sampledBeforeDecision, false)
})

test('wake participant rejection rolls back every restored predecessor atomically', async t => {
  const f = await fixture(t), sessions = new Sessions(), first = participant(), last = participant(), source = new V1SessionState(f.store(), { claude: first, wakes: last }), session = sessions.get('session')
  await source.ensure(session); first.set('retained'); last.set('invalid'); await source.checkpoint(session); await source.dispose()
  const restored = participant(), state = new V1SessionState(f.store(), { claude: restored, wakes: participant() })
  t.after(async () => { await state.dispose(); sessions.dispose() })
  await assert.rejects(state.ensure(session), /invalid/); assert.equal(restored.restored(), 0)
})

test('durable SDK ownership restores the saved host identity for its explicit resume phase without source replay', async t => {
  const f = await fixture(t), sessions = new Sessions(), inputs = new V1WakeInputs(), state = new V1SessionState(f.store(), { wakeInputs: inputs })
  sessions.prompt('session', 'genuine', 'model'); const before = sessions.get('session'); await state.ensure(before)
  const prompt = 'OWNED_NOTIFICATION', model = { providerID: 'provider', modelID: 'model' }, ticket = inputs.prepare(before, { jobID: 'job', prompt, model, agent: 'build', promptIndex: 0, turnIndex: 2 })
  const message = { role: 'user', id: 'system', sessionID: 'session', time: { created: 1700000000000 }, model, agent: 'build' }, parts = [{ ...wakeInputPart(ticket, prompt, 'save'), id: 'part' }]
  inputs.claim(before, message, parts); sessions.prompt('session', 'system', 'model'); const owner = sessions.get('session')
  inputs.saved(owner, ticket.saveNonce, { info: message, parts }); await state.checkpoint(owner); await state.dispose()
  const coldSessions = new Sessions(), coldInputs = new V1WakeInputs(), cold = new V1SessionState(f.store(), { wakeInputs: coldInputs })
  t.after(async () => { await cold.dispose(); inputs.dispose(); coldInputs.dispose(); sessions.dispose(); coldSessions.dispose() })
  assert.equal(await cold.requiresProjection(), true); await cold.ensure(coldSessions.get('session'))
  assert.equal(coldInputs.normalize('session', [{ info: message, parts }])[0]!.parts[0]!.synthetic, undefined)
  coldSessions.prompt('session', 'system', 'model')
  const resumed = coldInputs.resume(coldSessions.get('session'), ticket.saveNonce), copied = { ...message, time: { created: 1700000000005 } }
  assert.equal(coldInputs.claim(coldSessions.get('session'), copied, [wakeInputPart(resumed, prompt, 'resume')])?.phase, 'resume')
  assert.equal(copied.time.created, message.time.created)
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
