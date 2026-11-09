import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PromptContexts } from '../src/prompt-contexts.js'
import { Sessions } from '../src/sessions.js'

function fixture(t: { after: (callback: () => void) => void }) {
  const sessions = new Sessions()
  const contexts = new PromptContexts()
  t.after(() => { contexts.dispose(); sessions.dispose() })
  sessions.prompt('session', 'prompt', 'fixture')
  const session = sessions.get('session')
  contexts.remember(session, ['Original'], [])
  contexts.layout(session, [{ id: 'prompt', text: ['Original'] }])
  return { contexts, sessions, session }
}
const projection = Object.freeze(['<system-reminder>\nStop hook additional context: Feedback\n</system-reminder>'])
const request = (content = 'Marker') => new Request('https://provider.invalid', { method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', content: 'Original' }, { role: 'assistant', content: 'Answer' }, { role: 'user', content }] }) })

test('a reserved continuation consumes resources but cannot enter a model request before admission', async t => {
  const { contexts, session } = fixture(t)
  const raw = ['Marker'], content = [...projection]
  const before = contexts.inspect()
  const reservation = contexts.reserveContinuation(session, 'synthetic', raw, content)
  raw[0] = 'Changed marker'; content[0] = 'Changed feedback'
  assert.equal(contexts.ownsCurrentMessage(session, 'synthetic'), false)
  assert.equal(contexts.inspect().continuations, 1)
  assert.ok(contexts.inspect().bytes > before.bytes)
  assert.throws(() => contexts.layout(session, [{ id: 'prompt', text: ['Original'] }]), { code: 'HOST_PROMPT_ADMISSION_PENDING' })
  assert.throws(() => contexts.issue(session), { code: 'HOST_PROMPT_ADMISSION_PENDING' })
  reservation.admit()
  assert.equal(contexts.ownsCurrentMessage(session, 'synthetic'), true)
  assert.throws(() => reservation.admit(), { code: 'HOST_PROMPT_RESERVATION_UNAVAILABLE' })
  contexts.layout(session, [{ id: 'prompt', text: ['Original'] }, { id: 'synthetic', text: ['Marker'] }])
  const token = contexts.issue(session)!
  await assert.rejects(contexts.project(request('Changed marker'), token, session), { code: 'HOST_PROMPT_REQUEST_UNAVAILABLE' })
  const body = await (await contexts.project(request(), token, session)).json()
  assert.deepEqual(body.messages, [{ role: 'user', content: 'Original' }, { role: 'assistant', content: 'Answer' }, { role: 'user', content: [{ type: 'text', text: projection[0] }] }])
  reservation.release()
  assert.equal(contexts.ownsCurrentMessage(session, 'synthetic'), true)
})

test('releasing a pending continuation frees its ID and bytes without retaining an old request layout', t => {
  const { contexts, session } = fixture(t)
  const before = contexts.inspect()
  const reservation = contexts.reserveContinuation(session, 'synthetic', ['Marker'], projection)
  assert.throws(() => contexts.rememberContinuation(session, 'synthetic', ['Foreign']), { code: 'HOST_PROMPT_ID_REUSED' })
  assert.throws(() => contexts.reserveContinuation(session, 'synthetic', ['Foreign'], projection), { code: 'HOST_PROMPT_ID_REUSED' })
  reservation.release(); reservation.release()
  assert.deepEqual(contexts.inspect(), before)
  assert.throws(() => reservation.admit(), { code: 'HOST_PROMPT_RESERVATION_UNAVAILABLE' })
  assert.throws(() => contexts.issue(session), { code: 'HOST_PROMPT_LAYOUT_UNAVAILABLE' })
  contexts.reserveContinuation(session, 'synthetic', ['Marker'], projection).admit()
  assert.equal(contexts.ownsCurrentMessage(session, 'synthetic'), true)
})

test('model reservation ownership cannot be retargeted by mutating its caller-owned session snapshot', t => {
  const { contexts, session } = fixture(t)
  const mutable = { ...session }
  const reservation = contexts.reserveContinuation(mutable, 'synthetic', ['Marker'], projection)
  mutable.sessionID = 'foreign'; mutable.turnID = 'foreign'
  reservation.admit()
  assert.equal(contexts.ownsCurrentMessage(session, 'synthetic'), true)
  const next = { ...session }
  const before = contexts.inspect()
  const pending = contexts.reserveContinuation(next, 'pending', ['Marker'], projection)
  next.sessionID = 'foreign'
  pending.release()
  assert.deepEqual(contexts.inspect(), before)
})

test('turn cancellation releases pending ownership while preserving admitted historical entries', t => {
  const { contexts, sessions, session } = fixture(t)
  contexts.rememberContinuation(session, 'historical', ['History'], projection)
  const retained = contexts.inspect()
  const reservation = contexts.reserveContinuation(session, 'pending', ['Marker'], projection)
  sessions.prompt('session', 'next')
  assert.deepEqual(contexts.inspect(), retained)
  assert.equal(contexts.ownsCurrentMessage(session, 'pending'), false)
  assert.throws(() => reservation.admit(), { code: 'HOST_PROMPT_CANCELLED' })
  reservation.release()
  const next = sessions.get('session')
  contexts.remember(next, ['Next'], [])
  contexts.layout(next, [{ id: 'prompt', text: ['Original'] }, { id: 'historical', text: ['History'] }, { id: 'next', text: ['Next'] }])
  assert.equal(typeof contexts.issue(next), 'string')
  assert.equal(contexts.ownsCurrentMessage(next, 'historical'), false)
  sessions.close('session')
  assert.deepEqual(contexts.inspect(), { prompts: 0, continuations: 0, bytes: 0, tickets: 0, sessions: 0 })
})

test('starting a reservation invalidates already issued transport work under the same logical turn', async t => {
  const { contexts, session } = fixture(t)
  contexts.rememberContinuation(session, 'historical', ['History'], projection)
  contexts.layout(session, [{ id: 'prompt', text: ['Original'] }, { id: 'historical', text: ['History'] }])
  const token = contexts.issue(session)!
  const reservation = contexts.reserveContinuation(session, 'pending', ['Marker'], projection)
  await assert.rejects(contexts.project(request('History'), token, session), { code: 'HOST_PROMPT_REQUEST_UNAVAILABLE' })
  reservation.release()
  await assert.rejects(contexts.project(request('History'), token, session), { code: 'HOST_PROMPT_REQUEST_UNAVAILABLE' })
})

test('reservation invalidation cancels an in-flight provider-body read', async t => {
  const { contexts, session } = fixture(t)
  contexts.rememberContinuation(session, 'historical', ['History'], projection)
  contexts.layout(session, [{ id: 'prompt', text: ['Original'] }, { id: 'historical', text: ['History'] }])
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('{')) } })
  const input = new Request('https://provider.invalid', { method: 'POST', body: stream, duplex: 'half' } as RequestInit)
  const work = contexts.project(input, contexts.issue(session)!, session)
  contexts.reserveContinuation(session, 'pending', ['Marker'], projection)
  await assert.rejects(work, { code: 'HOST_PROMPT_CANCELLED' })
})

for (const action of ['replace-turn', 'dispose'] as const) test(`synchronous ${action} during request invalidation cannot leave a new pending slot`, async t => {
  const { contexts, sessions, session } = fixture(t)
  contexts.rememberContinuation(session, 'historical', ['History'], projection)
  contexts.layout(session, [{ id: 'prompt', text: ['Original'] }, { id: 'historical', text: ['History'] }])
  const previous = await contexts.project(request('History'), contexts.issue(session)!, session)
  const retained = contexts.inspect()
  previous.signal.addEventListener('abort', () => { if (action === 'dispose') contexts.dispose(); else sessions.prompt('session', 'next') }, { once: true })
  assert.throws(() => contexts.reserveContinuation(session, 'pending', ['Marker'], projection), { code: 'HOST_PROMPT_CANCELLED' })
  assert.equal(contexts.ownsCurrentMessage(session, 'pending'), false)
  assert.equal(contexts.inspect().continuations, action === 'dispose' ? 0 : retained.continuations)
  assert.equal(contexts.inspect().bytes, action === 'dispose' ? 0 : retained.bytes)
})

test('pending and admitted continuations share one finite retention budget', t => {
  const { contexts, session } = fixture(t)
  for (let index = 0; index < 9998; index++) contexts.rememberContinuation(session, `history-${index}`, ['History'])
  const reservation = contexts.reserveContinuation(session, 'pending', ['Marker'], projection)
  const before = contexts.inspect()
  assert.throws(() => contexts.rememberContinuation(session, 'overflow', ['Marker']), { code: 'HOST_PROMPT_CONTEXT_LIMIT' })
  assert.throws(() => contexts.reserveContinuation(session, 'overflow', ['Marker'], projection), { code: 'HOST_PROMPT_CONTEXT_LIMIT' })
  assert.deepEqual(contexts.inspect(), before)
  reservation.release()
  contexts.reserveContinuation(session, 'replacement', ['Marker'], projection).admit()
  assert.equal(contexts.ownsCurrentMessage(session, 'replacement'), true)
})

test('invalid reservations cannot leave ownership or an empty retained session behind', t => {
  const { contexts, session } = fixture(t)
  const before = contexts.inspect()
  for (const raw of [[], Array(1), [123], null]) assert.throws(() => contexts.reserveContinuation(session, 'invalid', raw as unknown as readonly string[], projection), { code: 'HOST_PROMPT_INPUT_UNAVAILABLE' })
  assert.throws(() => contexts.reserveContinuation(session, 'invalid', ['Marker'], ['x'.repeat(32 * 1024 * 1024)]), { code: 'HOST_PROMPT_CONTEXT_LIMIT' })
  assert.deepEqual(contexts.inspect(), before)
  const sessions = new Sessions(), empty = new PromptContexts()
  t.after(() => { empty.dispose(); sessions.dispose() })
  sessions.prompt('empty', 'prompt')
  const reservation = empty.reserveContinuation(sessions.get('empty'), 'pending', ['Marker'], projection)
  reservation.release()
  assert.deepEqual(empty.inspect(), { prompts: 0, continuations: 0, bytes: 0, tickets: 0, sessions: 0 })
})
