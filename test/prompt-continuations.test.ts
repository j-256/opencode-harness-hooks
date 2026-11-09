import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PromptContexts } from '../src/prompt-contexts.js'
import { Sessions } from '../src/sessions.js'

function fixture(t: { after: (callback: () => void) => void }) {
  const sessions = new Sessions()
  const contexts = new PromptContexts()
  t.after(() => { contexts.dispose(); sessions.dispose() })
  sessions.prompt('session', 'prompt', 'model')
  return { sessions, contexts }
}
const context = { sourceID: 'codex', sourceDigest: 'revision', registrationID: 'registration', dialect: 'codex' as const, configuredOrder: 0, completionOrder: 0, action: { kind: 'context' as const, placement: 'model' as const, text: 'Prompt context' } }
const request = (messages: unknown[]) => new Request('https://provider.invalid/v1/chat/completions', { method: 'POST', body: JSON.stringify({ messages }) })

test('an explicitly owned continuation preserves the logical turn and original prompt context', async t => {
  const { sessions, contexts } = fixture(t)
  const session = sessions.get('session')
  contexts.remember(session, ['Original'], [context])
  contexts.rememberContinuation(session, 'synthetic', ['Feedback'])
  assert.throws(() => contexts.rememberContinuation(session, 'synthetic', ['Other feedback']), { code: 'HOST_PROMPT_ID_REUSED' })
  assert.throws(() => contexts.layout(session, [{ id: 'prompt', text: ['Original'] }, { id: 'synthetic', text: ['Changed'] }]), { code: 'HOST_PROMPT_LAYOUT_UNAVAILABLE' })
  contexts.layout(session, [{ id: 'prompt', text: ['Original'] }, { id: 'synthetic', text: ['Feedback'] }])
  const token = contexts.issue(session)!
  assert.deepEqual(contexts.owner(token), { sessionID: 'session', messageID: 'prompt' })
  assert.equal(contexts.ownsCurrentMessage(session, 'synthetic'), true)
  assert.deepEqual(sessions.get('session'), session)
  const messages = [{ role: 'user', content: 'Original' }, { role: 'assistant', content: 'Answer' }, { role: 'user', content: 'Feedback' }]
  assert.deepEqual((await (await contexts.project(request(messages), token, session)).json()).messages, [messages[0], { role: 'developer', content: 'Prompt context' }, messages[1], messages[2]])
  assert.equal(contexts.inspect().prompts, 1)
  assert.equal(contexts.inspect().continuations, 1)
})

test('historical continuations retain their position but cannot own a replacement turn', async t => {
  const { sessions, contexts } = fixture(t)
  const original = sessions.get('session')
  contexts.remember(original, ['Original'], [context])
  contexts.rememberContinuation(original, 'synthetic', ['Feedback'])
  contexts.layout(original, [{ id: 'prompt', text: ['Original'] }, { id: 'synthetic', text: ['Feedback'] }])
  const expired = contexts.issue(original)!
  sessions.prompt('session', 'next', 'model')
  const next = sessions.get('session')
  assert.equal(contexts.ownsCurrentMessage(next, 'synthetic'), false)
  assert.equal(contexts.ownsCurrentMessage(original, 'synthetic'), false)
  assert.throws(() => contexts.issue(next), { code: 'HOST_PROMPT_LAYOUT_UNAVAILABLE' })
  assert.throws(() => contexts.rememberContinuation(original, 'stale', ['Stale']), { code: 'HOST_PROMPT_CANCELLED' })
  await assert.rejects(contexts.project(request([]), expired), { code: 'HOST_PROMPT_REQUEST_UNAVAILABLE' })
  contexts.remember(next, ['Next'], [])
  contexts.layout(next, [{ id: 'prompt', text: ['Original'] }, { id: 'synthetic', text: ['Feedback'] }, { id: 'next', text: ['Next'] }])
  const messages = [{ role: 'user', content: 'Original' }, { role: 'user', content: 'Feedback' }, { role: 'user', content: 'Next' }]
  assert.deepEqual((await (await contexts.project(request(messages), contexts.issue(next)!)).json()).messages, [messages[0], { role: 'developer', content: 'Prompt context' }, messages[1], messages[2]])
})

test('unknown synthetic messages and invalid ownership admissions leave retained state unchanged', t => {
  const { sessions, contexts } = fixture(t)
  const session = sessions.get('session')
  contexts.remember(session, ['Original'], [context])
  const before = contexts.inspect()
  assert.throws(() => contexts.layout(session, [{ id: 'prompt', text: ['Original'] }, { id: 'unknown', text: ['Feedback'] }]), { code: 'HOST_PROMPT_LAYOUT_UNAVAILABLE' })
  assert.equal(contexts.ownsCurrentMessage(session, 'unknown'), false)
  for (const id of ['', 'nul\0id', 'x'.repeat(4097)]) assert.throws(() => contexts.rememberContinuation(session, id, ['Feedback']), { code: 'HOST_PROMPT_INPUT_UNAVAILABLE' })
  assert.throws(() => contexts.rememberContinuation(session, 'prompt', ['Feedback']), { code: 'HOST_PROMPT_ID_REUSED' })
  assert.throws(() => contexts.rememberContinuation(session, 'empty', []), { code: 'HOST_PROMPT_INPUT_UNAVAILABLE' })
  const foreign = new Sessions()
  t.after(() => foreign.dispose())
  foreign.prompt('session', 'prompt', 'model')
  assert.throws(() => contexts.rememberContinuation(foreign.get('session'), 'foreign', ['Feedback']), { code: 'HOST_PROMPT_SESSION_MISMATCH' })
  assert.equal(contexts.ownsCurrentMessage(foreign.get('session'), 'prompt'), false)
  assert.deepEqual(contexts.inspect(), before)
})

test('ownership without prompt context does not fabricate the missing prompt history', t => {
  const { sessions, contexts } = fixture(t)
  const session = sessions.get('session')
  assert.equal(contexts.ownsCurrentMessage(session, 'prompt'), true)
  const text = ['Feedback']
  contexts.rememberContinuation(session, 'synthetic', text)
  text[0] = 'Changed'
  assert.equal(contexts.ownsCurrentMessage(session, 'synthetic'), true)
  assert.throws(() => contexts.layout(session, [{ id: 'prompt', text: ['Original'] }, { id: 'synthetic', text: ['Feedback'] }]), { code: 'HOST_PROMPT_LAYOUT_UNAVAILABLE' })
  contexts.layout(session, [{ id: 'synthetic', text: ['Feedback'] }])
  assert.equal(contexts.issue(session), undefined)
  sessions.close('session')
  assert.equal(contexts.ownsCurrentMessage(session, 'synthetic'), false)
  assert.deepEqual(contexts.inspect(), { prompts: 0, continuations: 0, bytes: 0, tickets: 0, sessions: 0 })
  assert.throws(() => contexts.rememberContinuation(session, 'closed', ['Feedback']), { code: 'HOST_PROMPT_CANCELLED' })
})

test('a reused turn identity cannot reclaim historical continuation ownership', t => {
  const { sessions, contexts } = fixture(t)
  const original = sessions.get('session')
  contexts.rememberContinuation(original, 'synthetic', ['Feedback'])
  sessions.prompt('session', 'other')
  sessions.prompt('session', 'prompt')
  assert.equal(contexts.ownsCurrentMessage(sessions.get('session'), 'synthetic'), false)
  assert.throws(() => contexts.layout(sessions.get('session'), [{ id: 'synthetic', text: ['Feedback'] }]), { code: 'HOST_PROMPT_LAYOUT_UNAVAILABLE' })
})

test('continuations share the prompt retention budget and disposal releases their bytes', t => {
  const { sessions, contexts } = fixture(t)
  const session = sessions.get('session')
  contexts.remember(session, ['Original'], [context])
  const limit = 10000
  for (let i = 1; i < limit; i++) contexts.rememberContinuation(session, `continuation-${i}`, ['Feedback'])
  const before = contexts.inspect()
  assert.throws(() => contexts.rememberContinuation(session, 'overflow', ['Feedback']), { code: 'HOST_PROMPT_CONTEXT_LIMIT' })
  assert.deepEqual(contexts.inspect(), before)
  contexts.dispose()
  assert.equal(contexts.ownsCurrentMessage(session, 'prompt'), false)
  assert.deepEqual(contexts.inspect(), { prompts: 0, continuations: 0, bytes: 0, tickets: 0, sessions: 0 })
})
