import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PromptContexts, PROMPT_REQUEST_HEADER } from '../src/prompt-contexts.js'
import { Sessions } from '../src/sessions.js'

function fixture(t: { after: (callback: () => void) => void }) {
  const sessions = new Sessions()
  const contexts = new PromptContexts()
  t.after(() => { contexts.dispose(); sessions.dispose() })
  sessions.prompt('session', 'prompt', 'fixture')
  const session = sessions.get('session')
  contexts.remember(session, ['Original'], [])
  return { sessions, contexts, session }
}
const PROJECTION = Object.freeze([
  '<system-reminder>\nStop hook blocking error from command: "fixture": Feedback\n</system-reminder>',
  '<system-reminder>\nStop hook additional context: Context\n</system-reminder>\n',
  'Stop hook feedback:\nFeedback',
])

for (const protocol of ['chat', 'responses', 'anthropic'] as const) test(`owned Stop input replaces only the matching synthetic text in ${protocol}`, async t => {
  const { contexts, session } = fixture(t)
  const projected = [...PROJECTION]
  contexts.rememberContinuation(session, 'synthetic', ['Transport marker'], projected)
  projected[0] = 'Changed after admission'
  contexts.layout(session, [{ id: 'prompt', text: ['Original'] }, { id: 'synthetic', text: ['Transport marker'] }])
  const token = contexts.issue(session, protocol === 'anthropic' ? 'anthropic' : 'openai')!
  assert.equal(typeof token, 'string')
  const key = protocol === 'responses' ? 'input' : 'messages'
  const type = protocol === 'responses' ? 'input_text' : 'text'
  const history = [{ role: 'user', content: 'Original' }, { role: 'assistant', content: 'Answer' }, { role: 'user', content: 'Transport marker' }].map(row => protocol === 'responses' ? { type: 'message', ...row } : row)
  const request = new Request('https://provider.invalid', { method: 'POST', headers: { [PROMPT_REQUEST_HEADER]: token, authorization: 'Bearer fixture' }, body: JSON.stringify({ [key]: history, model: 'fixture' }) })
  const result = await contexts.project(request, token, session)
  const body = await result.clone().json()
  assert.deepEqual(body[key], [history[0], history[1], { ...history[2], content: PROJECTION.map(text => ({ type, text })) }])
  assert.equal(result.headers.has(PROMPT_REQUEST_HEADER), false)
  assert.equal(result.headers.get('authorization'), 'Bearer fixture')
  assert.deepEqual(await (await contexts.project(result, token, session)).json(), body)
  assert.deepEqual((await request.json())[key], history)
  assert.equal(contexts.ownsCurrentMessage(session, 'synthetic'), true)
})

test('Stop rendering stays at its owned position after a real replacement prompt', async t => {
  const { contexts, sessions, session } = fixture(t)
  contexts.rememberContinuation(session, 'synthetic', ['Transport marker'], PROJECTION)
  sessions.prompt('session', 'next', 'fixture')
  const next = sessions.get('session')
  contexts.remember(next, ['Next'], [])
  contexts.layout(next, [{ id: 'prompt', text: ['Original'] }, { id: 'synthetic', text: ['Transport marker'] }, { id: 'next', text: ['Next'] }])
  const history = [{ role: 'user', content: 'Original' }, { role: 'assistant', content: 'First answer' }, { role: 'user', content: 'Transport marker' }, { role: 'assistant', content: 'Second answer' }, { role: 'user', content: 'Next' }]
  const original = new Request('https://provider.invalid', { method: 'POST', body: JSON.stringify({ messages: history }) })
  const result = await contexts.project(original, contexts.issue(next)!, next)
  assert.deepEqual((await result.json()).messages, [history[0], history[1], { role: 'user', content: PROJECTION.map(text => ({ type: 'text', text })) }, history[3], history[4]])
  assert.equal(contexts.ownsCurrentMessage(next, 'synthetic'), false)
  assert.equal(sessions.get('session').turnID, 'next')
})

test('malformed or oversized Stop projection cannot claim a synthetic identity', t => {
  const { contexts, session } = fixture(t)
  const before = contexts.inspect()
  for (const value of [[], [123], Array(1), 'Projection', null]) {
    assert.throws(() => contexts.rememberContinuation(session, 'synthetic', ['Transport marker'], value as unknown as readonly string[]), { code: 'HOST_PROMPT_INPUT_UNAVAILABLE' })
    assert.equal(contexts.ownsCurrentMessage(session, 'synthetic'), false)
    assert.deepEqual(contexts.inspect(), before)
  }
  assert.throws(() => contexts.rememberContinuation(session, 'synthetic', ['Transport marker'], ['x'.repeat(32 * 1024 * 1024)]), { code: 'HOST_PROMPT_CONTEXT_LIMIT' })
  assert.deepEqual(contexts.inspect(), before)
})

test('Stop projection cannot bypass raw input matching or survive owner cancellation', async t => {
  const { contexts, sessions, session } = fixture(t)
  contexts.rememberContinuation(session, 'synthetic', ['Transport marker'], PROJECTION)
  contexts.layout(session, [{ id: 'prompt', text: ['Original'] }, { id: 'synthetic', text: ['Transport marker'] }])
  const token = contexts.issue(session)!
  const request = new Request('https://provider.invalid', { method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', content: 'Original' }, { role: 'user', content: 'Changed' }] }) })
  await assert.rejects(contexts.project(request, token, session), { code: 'HOST_PROMPT_REQUEST_UNAVAILABLE' })
  sessions.prompt('session', 'next')
  await assert.rejects(contexts.project(request, token), { code: 'HOST_PROMPT_REQUEST_UNAVAILABLE' })
  sessions.close('session')
  assert.deepEqual(contexts.inspect(), { prompts: 0, continuations: 0, bytes: 0, tickets: 0, sessions: 0 })
})
