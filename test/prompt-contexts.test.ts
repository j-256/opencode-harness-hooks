import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PromptContexts } from '../src/prompt-contexts.js'
import { Sessions } from '../src/sessions.js'
import type { AttributedAction } from '../src/engine.js'
import type { HookAction } from '../src/effect-types.js'

const context = (dialect: 'claude-code' | 'codex', text: string, channel?: 'stdout' | 'additionalContext'): AttributedAction<Extract<HookAction, { kind: 'context' }>> => ({ sourceID: dialect, sourceDigest: 'revision', registrationID: text, dialect, configuredOrder: 0, completionOrder: 0, action: { kind: 'context', placement: 'model', text, ...(channel ? { channel } : {}) } })
function fixture(t: { after: (callback: () => void) => void }) {
  const sessions = new Sessions()
  const contexts = new PromptContexts()
  t.after(() => { contexts.dispose(); sessions.dispose() })
  sessions.prompt('session', 'first', 'model')
  return { sessions, contexts }
}
const request = (messages: unknown[], path = '/v1/chat/completions') => new Request('https://provider.invalid' + path, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer fixture' }, body: JSON.stringify({ messages, model: 'fixture' }) })

test('mixed prompt context preserves Claude before-user rendering and independent Codex developer messages', async t => {
  const { sessions, contexts } = fixture(t)
  const session = sessions.get('session')
  contexts.remember(session, ['Original'], [context('claude-code', 'Additional', 'additionalContext'), context('claude-code', 'Stdout', 'stdout'), context('codex', 'Developer'), context('codex', 'Developer')])
  contexts.layout(session, [{ id: 'first', text: ['Original'] }])
  const token = contexts.issue(session)!
  const original = request([{ role: 'system', content: 'Host instructions' }, { role: 'user', content: 'Original' }])
  original.headers.set('x-opencode-harness-hooks-request', token)
  original.headers.set('content-length', '1')
  const projected = await contexts.project(original, token)
  assert.equal(projected.headers.get('authorization'), 'Bearer fixture')
  assert.equal(projected.headers.has('x-opencode-harness-hooks-request'), false)
  assert.equal(projected.headers.has('content-length'), false)
  assert.equal(original.headers.get('x-opencode-harness-hooks-request'), token)
  const body = await projected.clone().json()
  assert.deepEqual(body.messages, [
    { role: 'system', content: 'Host instructions' },
    { role: 'user', content: [{ type: 'text', text: '<system-reminder>\nUserPromptSubmit hook additional context: Additional\n</system-reminder>' }, { type: 'text', text: '<system-reminder>\nUserPromptSubmit hook success: Stdout\n</system-reminder>' }, { type: 'text', text: 'Original' }] },
    { role: 'developer', content: 'Developer' }, { role: 'developer', content: 'Developer' },
  ])
  assert.equal((await original.json()).messages[1].content, 'Original')
  assert.deepEqual(await (await contexts.project(projected, token)).json(), body)
  assert.ok(!JSON.stringify(contexts.inspect()).includes('Original'))
})

test('Claude prompt contexts follow native completion order across independent registrations', async t => {
  const { sessions, contexts } = fixture(t)
  const session = sessions.get('session')
  contexts.remember(session, ['Original'], [
    { ...context('claude-code', 'Configured first', 'additionalContext'), completionOrder: 2 },
    { ...context('claude-code', 'Configured second', 'stdout'), completionOrder: 1 },
    { ...context('claude-code', 'Configured last', 'additionalContext'), completionOrder: 0 },
  ])
  contexts.layout(session, [{ id: 'first', text: ['Original'] }])
  const projected = await contexts.project(request([{ role: 'user', content: 'Original' }]), contexts.issue(session)!)
  const body = await projected.json()
  assert.deepEqual(body.messages[0].content.map((part: any) => part.text.match(/Configured \w+/)?.[0]).filter(Boolean), ['Configured last', 'Configured second', 'Configured first'])
})

test('history retains context at each original user position across accepted turns and repeated text', async t => {
  const { sessions, contexts } = fixture(t)
  contexts.remember(sessions.get('session'), ['Same'], [context('codex', 'First')])
  sessions.prompt('session', 'second', 'model')
  const session = sessions.get('session')
  contexts.remember(session, ['Same'], [context('codex', 'Second')])
  contexts.layout(session, [{ id: 'first', text: ['Same'] }, { id: 'second', text: ['Same'] }])
  const result = await contexts.project(request([{ role: 'user', content: 'Same' }, { role: 'assistant', content: 'Previous answer' }, { role: 'user', content: 'Same' }, { role: 'assistant', tool_calls: [] }, { role: 'tool', content: 'Current result' }]), contexts.issue(session)!)
  const body = await result.json()
  assert.deepEqual(body.messages.map((row: any) => [row.role, row.content]), [['user', 'Same'], ['developer', 'First'], ['assistant', 'Previous answer'], ['user', 'Same'], ['developer', 'Second'], ['assistant', undefined], ['tool', 'Current result']])
})

test('a header-only request cannot retain the correlation header when Bun reconstructs an empty header set', async t => {
  const { sessions, contexts } = fixture(t)
  const session = sessions.get('session')
  contexts.remember(session, ['Original'], [context('codex', 'Context')])
  contexts.layout(session, [{ id: 'first', text: ['Original'] }])
  const token = contexts.issue(session)!
  const original = new Request('https://provider.invalid', { method: 'POST', headers: { 'x-opencode-harness-hooks-request': token }, body: JSON.stringify({ messages: [{ role: 'user', content: 'Original' }] }) })
  const projected = await contexts.project(original, token)
  assert.equal(projected.headers.has('x-opencode-harness-hooks-request'), false)
  assert.equal(original.headers.get('x-opencode-harness-hooks-request'), token)
})

test('Responses projection uses input_text while preserving native function-call entries', async t => {
  const { sessions, contexts } = fixture(t)
  const session = sessions.get('session')
  contexts.remember(session, ['Original'], [context('codex', 'Developer')])
  contexts.layout(session, [{ id: 'first', text: ['Original'] }])
  const input = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Original' }] }, { type: 'function_call', call_id: 'call', name: 'tool', arguments: '{}' }]
  const original = new Request('https://provider.invalid/v1/responses', { method: 'POST', body: JSON.stringify({ input }) })
  const result = await contexts.project(original, contexts.issue(session)!)
  assert.deepEqual((await result.json()).input, [input[0], { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Developer' }] }, input[1]])
})

test('foreign, modified and pruned layouts fail instead of associating context by user text', async t => {
  const { sessions, contexts } = fixture(t)
  const session = sessions.get('session')
  contexts.remember(session, ['Original'], [context('codex', 'Private context')])
  for (const rows of [[{ id: 'other', text: ['Original'] }], [{ id: 'first', text: ['Changed'] }], []]) assert.throws(() => contexts.layout(session, rows), { code: 'HOST_PROMPT_LAYOUT_UNAVAILABLE' })
  contexts.layout(session, [{ id: 'first', text: ['Original'] }])
  const token = contexts.issue(session)!
  sessions.prompt('foreign', 'first', 'model')
  await assert.rejects(contexts.project(request([{ role: 'user', content: 'Original' }]), token, sessions.get('foreign')), { code: 'HOST_PROMPT_REQUEST_UNAVAILABLE' })
  await assert.rejects(contexts.project(request([{ role: 'user', content: 'Changed' }]), token), { code: 'HOST_PROMPT_REQUEST_UNAVAILABLE' })
  await assert.rejects(contexts.project(request([{ role: 'user', content: 'Original' }]), 'foreign'), { code: 'HOST_PROMPT_REQUEST_UNAVAILABLE' })
  await assert.rejects(contexts.project(request([{ role: 'user', content: 'Original' }], '/v1/messages'), contexts.issue(session, 'anthropic')!), { code: 'HOST_PROMPT_ROLE_UNAVAILABLE' })
})

test('turn cancellation expires request admission while session close removes retained context', async t => {
  const { sessions, contexts } = fixture(t)
  let session = sessions.get('session')
  contexts.remember(session, ['Original'], [context('codex', 'Private')])
  contexts.layout(session, [{ id: 'first', text: ['Original'] }])
  const token = contexts.issue(session)!
  sessions.prompt('session', 'second', 'model')
  await assert.rejects(contexts.project(request([{ role: 'user', content: 'Original' }]), token), { code: 'HOST_PROMPT_REQUEST_UNAVAILABLE' })
  assert.equal(contexts.inspect().prompts, 1)
  session = sessions.get('session')
  contexts.remember(session, ['New'], [])
  sessions.close('session')
  assert.equal(contexts.inspect().prompts, 0)
  assert.equal(contexts.inspect().tickets, 0)
  assert.equal(contexts.inspect().bytes, 0)
})

test('Anthropic Claude context keeps tool results and rejects unsupported user media', async t => {
  const { sessions, contexts } = fixture(t)
  const session = sessions.get('session')
  contexts.remember(session, ['Original'], [context('claude-code', 'Claude context', 'additionalContext')])
  contexts.layout(session, [{ id: 'first', text: ['Original'] }])
  const messages = [{ role: 'user', content: 'Original' }, { role: 'assistant', content: [{ type: 'tool_use', id: 'call', name: 'tool', input: {} }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call', content: 'Result' }] }]
  const token = contexts.issue(session, 'anthropic')!
  const projected = await contexts.project(request(messages, '/v1/messages'), token)
  const body = await projected.json()
  assert.match(body.messages[0].content[0].text, /hook additional context: Claude context/)
  assert.deepEqual(body.messages.slice(1), messages.slice(1))
  await assert.rejects(contexts.project(request([{ role: 'user', content: [{ type: 'image', source: {} }] }], '/v1/messages'), token), { code: 'HOST_PROMPT_REQUEST_UNAVAILABLE' })
})

test('disposal cancels an in-flight body read before any projected request can escape', async t => {
  const { sessions, contexts } = fixture(t)
  const session = sessions.get('session')
  contexts.remember(session, ['Original'], [context('codex', 'Private context')])
  contexts.layout(session, [{ id: 'first', text: ['Original'] }])
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('{')) } })
  const original = new Request('https://provider.invalid', { method: 'POST', body: stream, duplex: 'half' } as RequestInit)
  const pending = contexts.project(original, contexts.issue(session)!)
  contexts.dispose()
  await assert.rejects(pending, { code: 'HOST_PROMPT_CANCELLED' })
  assert.deepEqual(contexts.inspect(), { prompts: 0, bytes: 0, tickets: 0, sessions: 0 })
})
