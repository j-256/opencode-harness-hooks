import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { PromptContexts, PROMPT_REQUEST_HEADER } from '../src/prompt-contexts.js'
import { Sessions } from '../src/sessions.js'

function fixture(t: { after: (callback: () => void) => void }, promptContext = false) {
  const sessions = new Sessions(), contexts = new PromptContexts()
  t.after(() => { contexts.dispose(); sessions.dispose() })
  sessions.prompt('session', 'original')
  contexts.remember(sessions.get('session'), ['Same'], [])
  sessions.prompt('session', 'next')
  const session = sessions.get('session')
  contexts.remember(session, ['Same'], promptContext ? [{ sourceID: 'claude', sourceDigest: 'revision', registrationID: 'context', dialect: 'claude-code', configuredOrder: 0, completionOrder: 0, action: { kind: 'context', placement: 'model', channel: 'additionalContext', text: 'CANCEL_NEXT_CONTEXT' } }] : [])
  return { sessions, contexts, session }
}
const input = () => ({ completionID: 'answer', assistantText: ['Answer'], reminders: ['Reminder'], feedback: ['Feedback'] })
const layout = [{ id: 'original', text: ['Same'] }, { id: 'next', text: ['Same'] }]
const cancellation = JSON.parse(readFileSync(new URL('./fixtures/claude-stop-cancellation-oracle.json', import.meta.url), 'utf8'))

for (const scenario of cancellation.cases) for (const protocol of ['chat', 'responses', 'anthropic'] as const) for (const promptContext of [false, true]) test(`native ${scenario.name} interruption model ordering in ${protocol} with next prompt context ${promptContext}`, async t => {
  const { contexts, session } = fixture(t, promptContext)
  contexts.layout(session, layout)
  const old = contexts.issue(session)!
  contexts.rememberHistory(session, { completionID: 'answer', assistantText: ['Answer'], reminders: scenario.retainedStopOutput ? [
    '<system-reminder>\nStop hook blocking error from command: "FIXTURE_COMMAND": CANCEL_STOP_FEEDBACK\n</system-reminder>',
    '<system-reminder>\nStop hook additional context: CANCEL_STOP_CONTEXT\n</system-reminder>',
  ] : [], feedback: scenario.retainedStopOutput ? ['Stop hook feedback:\nCANCEL_STOP_FEEDBACK'] : [], interrupted: true })
  const key = protocol === 'responses' ? 'input' : 'messages', type = protocol === 'responses' ? 'input_text' : 'text'
  const messages = [{ role: 'user', content: 'Same' }, { role: 'assistant', content: 'Answer' }, { role: 'user', content: 'Same' }]
  const request = new Request('https://provider.invalid', { method: 'POST', body: JSON.stringify({ [key]: messages }) })
  await assert.rejects(contexts.project(request, old, session), { code: 'HOST_PROMPT_REQUEST_UNAVAILABLE' })
  contexts.layout(session, layout)
  const token = contexts.issue(session, protocol === 'anthropic' ? 'anthropic' : 'openai')!
  const body = await (await contexts.project(request, token, session)).json()
  const expected = [...scenario.nextUser.slice(0, -1), 'Same']
  if (promptContext) expected.splice(scenario.retainedStopOutput ? 2 : 0, 0, '<system-reminder>\nUserPromptSubmit hook additional context: CANCEL_NEXT_CONTEXT\n</system-reminder>\n')
  assert.deepEqual(body[key][2].content, expected.map(text => ({ type, text })))
  assert.deepEqual(body[key].slice(0, 2), messages.slice(0, 2))
})

for (const protocol of ['chat', 'responses', 'anthropic'] as const) test(`retained Stop blocks join only their accepted real prompt in ${protocol}`, async t => {
  const { contexts, session } = fixture(t)
  const blocks = input()
  contexts.rememberHistory(session, blocks)
  blocks.reminders[0] = 'Changed'; blocks.assistantText[0] = 'Changed'
  contexts.layout(session, layout)
  const token = contexts.issue(session, protocol === 'anthropic' ? 'anthropic' : 'openai')!
  const key = protocol === 'responses' ? 'input' : 'messages', type = protocol === 'responses' ? 'input_text' : 'text'
  const messages = [{ role: 'user', content: 'Same' }, { role: 'assistant', content: 'Answer' }, { role: 'user', content: 'Same' }]
  const request = new Request('https://provider.invalid', { method: 'POST', headers: { [PROMPT_REQUEST_HEADER]: token }, body: JSON.stringify({ [key]: messages }) })
  const result = await contexts.project(request, token, session)
  const body = await result.clone().json()
  assert.deepEqual(body[key], [messages[0], messages[1], { role: 'user', content: ['Reminder', 'Feedback\n', 'Same'].map(text => ({ type, text })) }])
  assert.equal(result.headers.has(PROMPT_REQUEST_HEADER), false)
  assert.deepEqual(await (await contexts.project(result, token, session)).json(), body)
})

test('history binding validates its assistant and original accepted prompt order on every request', async t => {
  const { contexts, sessions, session } = fixture(t)
  contexts.rememberHistory(session, input()); contexts.layout(session, layout)
  for (const messages of [
    [{ role: 'user', content: 'Same' }, { role: 'assistant', content: 'Changed' }, { role: 'user', content: 'Same' }],
    [{ role: 'user', content: 'Same' }, { role: 'user', content: 'Same' }],
    [{ role: 'user', content: 'Same' }, { role: 'assistant', content: 'Answer', tool_calls: [{ id: 'unmapped' }] }, { role: 'user', content: 'Same' }],
  ]) {
    const request = new Request('https://provider.invalid', { method: 'POST', body: JSON.stringify({ messages }) })
    await assert.rejects(contexts.project(request, contexts.issue(session)!, session), { code: 'HOST_PROMPT_HISTORY_UNAVAILABLE' })
  }
  assert.throws(() => contexts.layout(session, [...layout].reverse()), { code: 'HOST_PROMPT_LAYOUT_UNAVAILABLE' })
  sessions.prompt('session', 'third')
  const third = sessions.get('session')
  contexts.remember(third, ['Third'], [])
  assert.throws(() => contexts.layout(third, [layout[1]!, layout[0]!, { id: 'third', text: ['Third'] }]), { code: 'HOST_PROMPT_LAYOUT_UNAVAILABLE' })
})

test('binding retained Stop content invalidates earlier tickets and survives subsequent real turns', async t => {
  const { contexts, sessions, session } = fixture(t)
  const context = { sourceID: 'claude', sourceDigest: 'revision', registrationID: 'context', dialect: 'claude-code' as const, configuredOrder: 0, completionOrder: 0, action: { kind: 'context' as const, placement: 'model' as const, channel: 'additionalContext' as const, text: 'Prompt context' } }
  contexts.rememberContinuation(session, 'continuation', ['Marker'], ['Native continuation'])
  contexts.layout(session, [...layout, { id: 'continuation', text: ['Marker'] }])
  const previous = contexts.issue(session)!
  contexts.rememberHistory(session, input())
  const request = new Request('https://provider.invalid', { method: 'POST', body: '{}' })
  await assert.rejects(contexts.project(request, previous, session), { code: 'HOST_PROMPT_REQUEST_UNAVAILABLE' })
  sessions.prompt('session', 'third')
  const third = sessions.get('session')
  contexts.remember(third, ['Third'], [context])
  contexts.layout(third, [...layout, { id: 'continuation', text: ['Marker'] }, { id: 'third', text: ['Third'] }])
  const messages = [{ role: 'user', content: 'Same' }, { role: 'assistant', content: 'Answer' }, { role: 'user', content: 'Same' }, { role: 'assistant', content: 'Second' }, { role: 'user', content: 'Marker' }, { role: 'assistant', content: 'Third answer' }, { role: 'user', content: 'Third' }]
  const body = await (await contexts.project(new Request('https://provider.invalid', { method: 'POST', body: JSON.stringify({ messages }) }), contexts.issue(third)!, third)).json()
  assert.deepEqual(body.messages[2].content, ['Reminder', 'Feedback\n', 'Same'].map(text => ({ type: 'text', text })))
  assert.deepEqual(body.messages[4].content, [{ type: 'text', text: 'Native continuation' }])
  assert.equal(body.messages[6].content[1].text, 'Third')
})

test('malformed, reused, oversized and cancelled history cannot corrupt retained transport state', async t => {
  const { contexts, sessions, session } = fixture(t)
  const before = contexts.inspect()
  for (const blocks of [{ ...input(), reminders: Array(1) }, { ...input(), feedback: [1] }, { ...input(), assistantText: [] }, { ...input(), completionID: '' }, { ...input(), reminders: [], feedback: [] }, { ...input(), interrupted: 'true' }, { ...input(), interrupted: false }]) {
    assert.throws(() => contexts.rememberHistory(session, blocks as any), { code: 'HOST_PROMPT_HISTORY_UNAVAILABLE' })
    assert.deepEqual(contexts.inspect(), before)
  }
  assert.throws(() => contexts.rememberHistory(session, { ...input(), reminders: ['x'.repeat(32 * 1024 * 1024)] }), { code: 'HOST_PROMPT_CONTEXT_LIMIT' })
  assert.deepEqual(contexts.inspect(), before)
  contexts.rememberHistory(session, input())
  assert.throws(() => contexts.rememberHistory(session, input()), { code: 'HOST_PROMPT_HISTORY_UNAVAILABLE' })
  sessions.prompt('session', 'replacement')
  assert.throws(() => contexts.rememberHistory(session, input()), { code: 'HOST_PROMPT_CANCELLED' })
  sessions.close('session')
  assert.deepEqual(contexts.inspect(), { prompts: 0, continuations: 0, bytes: 0, tickets: 0, sessions: 0 })
})

test('history captures its owner before invalidating request signals with caller listeners', async t => {
  const { contexts, session } = fixture(t)
  contexts.rememberContinuation(session, 'continuation', ['Marker'], ['Native continuation'])
  const rows = [...layout, { id: 'continuation', text: ['Marker'] }]
  contexts.layout(session, rows)
  const messages = [{ role: 'user', content: 'Same' }, { role: 'assistant', content: 'Answer' }, { role: 'user', content: 'Same' }, { role: 'assistant', content: 'Second' }, { role: 'user', content: 'Marker' }]
  const request = new Request('https://provider.invalid', { method: 'POST', body: JSON.stringify({ messages }) })
  const active = await contexts.project(request, contexts.issue(session)!, session)
  const mutable = { ...session }
  active.signal.addEventListener('abort', () => { mutable.turnID = 'foreign' }, { once: true })
  contexts.rememberHistory(mutable, input())
  assert.equal(mutable.turnID, 'foreign')
  contexts.layout(session, rows)
  const body = await (await contexts.project(request, contexts.issue(session)!, session)).json()
  assert.deepEqual(body.messages[2].content, ['Reminder', 'Feedback\n', 'Same'].map(text => ({ type: 'text', text })))
})
