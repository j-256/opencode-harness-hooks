import assert from 'node:assert/strict'
import { test } from 'node:test'
import { V1WakeInputs, V1_WAKE_METADATA, wakeInputPart } from '../src/hosts/wake-inputs-v1.js'
import { Sessions } from '../src/sessions.js'

const PROMPT = 'OWNED_SYSTEM_NOTIFICATION'
const MODEL = { providerID: 'provider', modelID: 'model' }
const CREATED = 1700000000000
function fixture(t: { after(callback: () => unknown): void }, options = {}) {
  const sessions = new Sessions(), inputs = new V1WakeInputs(options); sessions.prompt('session', 'genuine', 'model')
  t.after(() => inputs.dispose()); t.after(() => sessions.dispose())
  const ticket = inputs.prepare(sessions.get('session'), { jobID: 'job', prompt: PROMPT, model: MODEL, agent: 'build', promptIndex: 0, turnIndex: 2 })
  const message = () => ({ id: 'system', sessionID: 'session', role: 'user', model: { ...MODEL }, agent: 'build', time: { created: CREATED } })
  const parts = () => [{ ...wakeInputPart(ticket, PROMPT, 'save'), id: 'part' }]
  return { inputs, sessions, ticket, message, parts }
}

test('two distinct owned SDK phases reuse actual host IDs without repeating source admission or changing the first timestamp', t => {
  const f = fixture(t), message = f.message(), parts = f.parts(), owner = f.sessions.get('session')
  const first = f.inputs.claim(owner, message, parts)
  assert.ok(first)
  assert.equal(first.phase, 'evaluate'); assert.equal(first.input.messageID, 'system')
  assert.notEqual(f.ticket.saveNonce, f.ticket.resumeNonce)
  assert.throws(() => f.inputs.claim(owner, message, parts), { code: 'HOST_WAKE_INPUT_REUSED' })
  f.sessions.prompt('session', 'system', 'model'); const session = f.sessions.get('session')
  const saved = f.inputs.saved(session, f.ticket.saveNonce, { info: message, parts })
  assert.equal(saved.phase, 'saved'); assert.equal(saved.partID, 'part')
  const resuming = f.inputs.resume(session, f.ticket.saveNonce), repeated = { ...message, time: { created: CREATED + 5 } }, resumedParts = [wakeInputPart(resuming, PROMPT, 'resume')]
  const second = f.inputs.claim(session, repeated, resumedParts)
  assert.ok(second)
  assert.equal(second.phase, 'resume'); assert.equal(repeated.time.created, CREATED)
  assert.equal(resumedParts[0]!.id, parts[0]!.id)
  assert.throws(() => f.inputs.claim(session, repeated, resumedParts), { code: 'HOST_WAKE_INPUT_REUSED' })
  const finished = f.inputs.finish(session, f.ticket.saveNonce, { info: repeated, parts: resumedParts })
  assert.equal(finished.phase, 'finished'); assert.equal(f.inputs.read(session).length, 1)
  assert.ok(!JSON.stringify(f.inputs.inspect()).includes(PROMPT)); assert.ok(!JSON.stringify(f.inputs.inspect()).includes(f.ticket.saveNonce))
})

test('an unsubmitted issued ticket can be released without retaining nonce authority or its allocation', t => {
  const f = fixture(t), session = f.sessions.get('session')
  f.inputs.discardIssued(session, f.ticket.saveNonce)
  assert.equal(f.inputs.inspect().inputs, 0); assert.equal(f.inputs.inspect().bytes, 0)
  assert.throws(() => f.inputs.claim(session, f.message(), f.parts()), { code: 'HOST_WAKE_INPUT_OWNER_MISMATCH' })
  const next = f.inputs.prepare(session, { jobID: 'job', prompt: PROMPT, model: MODEL, agent: 'build', promptIndex: 0, turnIndex: 2 })
  assert.notEqual(next.saveNonce, f.ticket.saveNonce)
  f.inputs.claim(session, f.message(), [{ ...wakeInputPart(next, PROMPT, 'save'), id: 'part' }])
  assert.throws(() => f.inputs.discardIssued(session, next.saveNonce), { code: 'HOST_WAKE_INPUT_REUSED' })
  assert.equal(f.inputs.inspect().inputs, 1)
})

test('an unsubmitted resume can return to saved state while a claimed resume remains irreversible', t => {
  const f = fixture(t), message = f.message(), parts = f.parts()
  f.inputs.claim(f.sessions.get('session'), message, parts); f.sessions.prompt('session', 'system', 'model'); const session = f.sessions.get('session')
  f.inputs.saved(session, f.ticket.saveNonce, { info: message, parts }); f.inputs.resume(session, f.ticket.saveNonce)
  f.inputs.cancelResume(session, f.ticket.saveNonce)
  assert.equal(f.inputs.read(session)[0]!.phase, 'saved'); assert.equal(f.inputs.normalize('session', [{ info: message, parts }])[0]!.parts[0]!.synthetic, undefined)
  const resumed = f.inputs.resume(session, f.ticket.saveNonce)
  f.inputs.claim(session, message, [wakeInputPart(resumed, PROMPT, 'resume')])
  assert.throws(() => f.inputs.cancelResume(session, f.ticket.saveNonce), { code: 'HOST_WAKE_INPUT_REUSED' })
})

test('text matching and unrelated synthetic input never grant notification ownership, while forged marked input fails closed', t => {
  const f = fixture(t), session = f.sessions.get('session')
  assert.equal(f.inputs.claim(session, f.message(), [{ type: 'text', text: PROMPT }]), undefined)
  assert.equal(f.inputs.claim(session, f.message(), [{ type: 'text', text: PROMPT, synthetic: true }]), undefined)
  for (const change of [
    [{ ...f.parts()[0], text: 'changed' }], [{ ...f.parts()[0], synthetic: false }],
    [{ ...f.parts()[0], metadata: { [V1_WAKE_METADATA]: 'foreign' } }], [...f.parts(), { type: 'text', text: 'additional' }],
  ]) assert.throws(() => f.inputs.claim(session, f.message(), change), { code: 'HOST_WAKE_INPUT_OWNER_MISMATCH' })
  assert.equal(f.inputs.read(session)[0]!.phase, 'issued')
  f.sessions.prompt('session', 'new-genuine', 'model')
  assert.throws(() => f.inputs.claim(f.sessions.get('session'), f.message(), f.parts()), { code: 'HOST_WAKE_INPUT_OWNER_MISMATCH' })
})

test('owned history normalization verifies each actual part identity without mutating raw SDK history', t => {
  const f = fixture(t), message = f.message(), parts = f.parts()
  f.inputs.claim(f.sessions.get('session'), message, parts); f.sessions.prompt('session', 'system', 'model')
  f.inputs.saved(f.sessions.get('session'), f.ticket.saveNonce, { info: message, parts })
  const raw = [{ info: { id: 'genuine', sessionID: 'session', role: 'user' }, parts: [{ type: 'text', text: 'GENUINE' }] }, { info: { ...message, role: 'user' }, parts }], before = structuredClone(raw)
  const normalized = f.inputs.normalize('session', raw)
  assert.equal(Object.hasOwn(normalized[1]!.parts[0]!, 'synthetic'), false); assert.equal(normalized[1]!.parts[0]!.text, PROMPT)
  assert.deepEqual(raw, before)
  for (const mutate of [
    (value: any) => { value[1].info.id = 'foreign' },
    (value: any) => { value[1].parts[0].id = 'foreign' },
    (value: any) => { value[1].parts[0].text = 'foreign' },
    (value: any) => { value[1].info.model.modelID = 'foreign' },
    (value: any) => { value[1].info.time.created++ },
    (value: any) => { delete value[1].parts[0].metadata },
    (value: any) => { value.push(structuredClone(value[1])) },
  ]) { const invalid = structuredClone(raw); mutate(invalid); assert.throws(() => f.inputs.normalize('session', invalid), { code: 'HOST_WAKE_INPUT_OWNER_MISMATCH' }) }
})

test('cold ownership restore retains first-phase history and permits only the explicit second admission phase', t => {
  const f = fixture(t), message = f.message(), parts = f.parts()
  f.inputs.claim(f.sessions.get('session'), message, parts); f.sessions.prompt('session', 'system', 'model'); const session = f.sessions.get('session')
  f.inputs.saved(session, f.ticket.saveNonce, { info: message, parts })
  const cold = new V1WakeInputs(); t.after(() => cold.dispose())
  cold.restoreV1(session, f.inputs.snapshotV1('session'))
  assert.throws(() => cold.claim(session, message, parts), { code: 'HOST_WAKE_INPUT_REUSED' })
  const resuming = cold.resume(session, f.ticket.saveNonce), next = { ...message, time: { created: CREATED + 10 } }, resumed = [wakeInputPart(resuming, PROMPT, 'resume')]
  assert.equal(cold.claim(session, next, resumed)?.phase, 'resume'); assert.equal(next.time.created, CREATED)
  assert.equal(cold.normalize('session', [{ info: { ...next, role: 'user' }, parts: resumed }])[0]!.parts[0]!.synthetic, undefined)
})

test('terminal saved notifications finish without a model admission and newer genuine input fences the resume phase', t => {
  const f = fixture(t), message = f.message(), parts = f.parts()
  f.inputs.claim(f.sessions.get('session'), message, parts); f.sessions.prompt('session', 'system', 'model'); const session = f.sessions.get('session')
  f.inputs.saved(session, f.ticket.saveNonce, { info: message, parts }); f.sessions.prompt('session', 'new-genuine', 'model')
  assert.throws(() => f.inputs.resume(f.sessions.get('session'), f.ticket.saveNonce), { code: 'HOST_WAKE_INPUT_OWNER_MISMATCH' })
  assert.equal(f.inputs.finish(session, f.ticket.saveNonce, { info: message, parts }).phase, 'finished')
  assert.throws(() => f.inputs.resume(session, f.ticket.saveNonce), { code: 'HOST_WAKE_INPUT_REUSED' })
})

test('strict ownership snapshots reject relabelled sessions and invalid phase fields atomically', t => {
  const f = fixture(t), saved = f.inputs.snapshotV1('session')
  for (const mutate of [
    (value: any) => { value.sessionID = 'foreign' },
    (value: any) => { value.rows[0].phase = 'running' },
    (value: any) => { value.rows[0].resumeNonce = value.rows[0].saveNonce },
    (value: any) => { value.rows.push(structuredClone(value.rows[0])) },
    (value: any) => { value.rows[0].unexpected = true },
  ]) {
    const cold = new V1WakeInputs(); t.after(() => cold.dispose()); const invalid = structuredClone(saved); mutate(invalid)
    assert.throws(() => cold.restoreV1(f.sessions.get((invalid as any).sessionID), invalid))
    assert.equal(cold.inspect().inputs, 0)
  }
  const cold = new V1WakeInputs(); t.after(() => cold.dispose()); const undo = cold.restoreV1(f.sessions.get('session'), saved)
  cold.claim(f.sessions.get('session'), f.message(), f.parts()); assert.throws(undo, { code: 'HOST_WAKE_INPUT_STATE_CHANGED' })
})

test('issued defaults bind to the observed host model and agent while resume cannot change the saved tool policy', t => {
  const sessions = new Sessions(), inputs = new V1WakeInputs(); t.after(() => { inputs.dispose(); sessions.dispose() })
  const before = sessions.get('session'), ticket = inputs.prepare(before, { jobID: 'job', prompt: PROMPT, promptIndex: 0, turnIndex: 1 })
  const message = { id: 'system', sessionID: 'session', role: 'user', model: MODEL, agent: 'build', time: { created: CREATED } }, parts = [{ ...wakeInputPart(ticket, PROMPT, 'save'), id: 'part' }]
  assert.deepEqual(inputs.claim(before, message, parts)?.input.model, MODEL)
  sessions.prompt('session', 'system', 'model'); const session = sessions.get('session')
  const saved = inputs.saved(session, ticket.saveNonce, { info: message, parts }); assert.equal(saved.agent, 'build')
  const resuming = inputs.resume(session, ticket.saveNonce)
  assert.throws(() => inputs.claim(session, { ...message, tools: { bash: true } }, [wakeInputPart(resuming, PROMPT, 'resume')]), { code: 'HOST_WAKE_INPUT_OWNER_MISMATCH' })
  assert.equal(inputs.read(session)[0]!.phase, 'resuming')
})

test('an owned message cannot become a genuine prompt by dropping its marker or reuse an existing genuine identity', t => {
  const f = fixture(t), before = f.sessions.get('session'), parts = f.parts()
  assert.throws(() => f.inputs.claim(before, { ...f.message(), id: 'genuine' }, parts), { code: 'HOST_WAKE_INPUT_OWNER_MISMATCH' })
  f.inputs.claim(before, f.message(), parts)
  assert.throws(() => f.inputs.claim(before, f.message(), [{ type: 'text', text: PROMPT }]), { code: 'HOST_WAKE_INPUT_OWNER_MISMATCH' })
})

test('ownership bounds and session closure cannot evict prior tickets or reopen their nonce authority', t => {
  const f = fixture(t, { maxInputs: 1 })
  assert.throws(() => f.inputs.prepare(f.sessions.get('session'), { jobID: 'another', prompt: PROMPT, model: MODEL, agent: 'build', promptIndex: 0, turnIndex: 2 }), { code: 'HOST_WAKE_INPUT_LIMIT' })
  assert.equal(f.inputs.read(f.sessions.get('session')).length, 1)
  f.inputs.removeSession('session'); assert.equal(f.inputs.inspect().inputs, 0)
  assert.throws(() => f.inputs.claim(f.sessions.get('session'), f.message(), f.parts()), { code: 'HOST_WAKE_INPUT_CLOSED' })
})

test('a read-only resume timestamp rejects before consuming the admission nonce', t => {
  const f = fixture(t), message = f.message(), parts = f.parts()
  f.inputs.claim(f.sessions.get('session'), message, parts); f.sessions.prompt('session', 'system', 'model'); const session = f.sessions.get('session')
  f.inputs.saved(session, f.ticket.saveNonce, { info: message, parts }); const resuming = f.inputs.resume(session, f.ticket.saveNonce)
  const frozen = { ...message, time: Object.freeze({ created: CREATED + 5 }) }
  assert.throws(() => f.inputs.claim(session, frozen, [wakeInputPart(resuming, PROMPT, 'resume')]), { code: 'HOST_WAKE_INPUT_OWNER_MISMATCH' })
  assert.equal(f.inputs.read(session)[0]!.phase, 'resuming')
  const mutable = { ...message, time: { created: CREATED + 5 } }
  assert.equal(f.inputs.claim(session, mutable, [wakeInputPart(resuming, PROMPT, 'resume')])?.phase, 'resume')
})

test('failed ownership snapshots cannot weaken already bound host metadata or inherit another runtime lifetime', t => {
  const f = fixture(t), session = f.sessions.get('session'); f.inputs.claim(session, f.message(), f.parts()); f.inputs.fail(session, f.ticket.saveNonce)
  const saved = f.inputs.snapshotV1('session')
  for (const field of ['model', 'agent', 'created']) {
    const cold = new V1WakeInputs(); t.after(() => cold.dispose()); const invalid = structuredClone(saved) as any; invalid.rows[0][field] = null
    assert.throws(() => cold.restoreV1(session, invalid), { code: 'SESSION_SNAPSHOT_SCHEMA_INVALID' }); assert.equal(cold.inspect().inputs, 0)
  }
  assert.throws(() => f.inputs.read({ ...session, signal: new AbortController().signal }), { code: 'HOST_WAKE_INPUT_OWNER_MISMATCH' })
  const tight = new V1WakeInputs({ maxBytes: 1 }); t.after(() => tight.dispose())
  assert.throws(() => tight.prepare(session, { jobID: 'job', prompt: PROMPT, model: MODEL, promptIndex: 0, turnIndex: 2 }), { code: 'HOST_WAKE_INPUT_LIMIT' })
  assert.equal(tight.inspect().inputs, 0)
})

test('OpenCode transient undefined model fields do not change the persisted selection or block owned admission', t => {
  const f = fixture(t), message = { ...f.message(), model: { ...MODEL, variant: undefined } }
  const result = f.inputs.claim(f.sessions.get('session'), message, f.parts())
  assert.deepEqual(result?.input.model, MODEL)
})

test('a defined host model variant binds once and cannot change during the second SDK admission', t => {
  const f = fixture(t), message = { ...f.message(), model: { ...MODEL, variant: 'probe-variant' } }, parts = f.parts(), before = f.sessions.get('session')
  const first = f.inputs.claim(before, message, parts)
  assert.deepEqual(first?.input.model, message.model)
  f.sessions.prompt('session', 'system', 'model'); const session = f.sessions.get('session')
  f.inputs.saved(session, f.ticket.saveNonce, { info: message, parts }); const resuming = f.inputs.resume(session, f.ticket.saveNonce), resumed = [wakeInputPart(resuming, PROMPT, 'resume')]
  assert.throws(() => f.inputs.claim(session, { ...message, model: MODEL }, resumed), { code: 'HOST_WAKE_INPUT_OWNER_MISMATCH' })
  assert.throws(() => f.inputs.claim(session, { ...message, model: { ...MODEL, variant: 'changed' } }, resumed), { code: 'HOST_WAKE_INPUT_OWNER_MISMATCH' })
  assert.equal(f.inputs.claim(session, message, resumed)?.phase, 'resume')
})
