import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PromptContexts } from '../src/prompt-contexts.js'
import { Sessions } from '../src/sessions.js'

const START = '<system-reminder>\nSessionStart:startup hook success: START\n</system-reminder>'
const request = (messages: unknown[]) => new Request('https://provider.invalid/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages, model: 'fixture' }) })

test('startup context precedes the original first prompt and stays at that owned history position', async t => {
  const sessions = new Sessions(), contexts = new PromptContexts()
  t.after(() => { contexts.dispose(); sessions.dispose() })
  sessions.prompt('session', 'first', 'fixture')
  contexts.remember(sessions.get('session'), ['First'], [])
  contexts.rememberStartup(sessions.get('session'), { claude: [START], codex: [] })
  contexts.layout(sessions.get('session'), [{ id: 'first', text: ['First'] }])
  let token = contexts.issue(sessions.get('session'))!
  let output = await (await contexts.project(request([{ role: 'user', content: 'First' }]), token)).json()
  assert.deepEqual(output.messages, [{ role: 'user', content: [{ type: 'text', text: START }, { type: 'text', text: 'First' }] }])
  sessions.prompt('session', 'second', 'fixture')
  contexts.remember(sessions.get('session'), ['Second'], [])
  contexts.layout(sessions.get('session'), [{ id: 'first', text: ['First'] }, { id: 'second', text: ['Second'] }])
  token = contexts.issue(sessions.get('session'))!
  output = await (await contexts.project(request([{ role: 'user', content: 'First' }, { role: 'assistant', content: 'Answer' }, { role: 'user', content: 'Second' }]), token)).json()
  assert.deepEqual(output.messages[0].content, [{ type: 'text', text: START }, { type: 'text', text: 'First' }])
  assert.deepEqual(output.messages[2], { role: 'user', content: 'Second' })
})

test('startup context requires an accepted owned prompt, rejects repeat binding and cancels requests on closure', async () => {
  const sessions = new Sessions(), contexts = new PromptContexts()
  sessions.prompt('session', 'first', 'fixture')
  assert.throws(() => contexts.rememberStartup(sessions.get('session'), { claude: [START], codex: [] }), { code: 'HOST_STARTUP_CONTEXT_UNAVAILABLE' })
  contexts.remember(sessions.get('session'), ['First'], [])
  contexts.layout(sessions.get('session'), [{ id: 'first', text: ['First'] }])
  assert.equal(contexts.issue(sessions.get('session')), undefined)
  contexts.rememberStartup(sessions.get('session'), { claude: [START], codex: [] })
  assert.throws(() => contexts.issue(sessions.get('session')), { code: 'HOST_PROMPT_LAYOUT_UNAVAILABLE' })
  contexts.layout(sessions.get('session'), [{ id: 'first', text: ['First'] }])
  const token = contexts.issue(sessions.get('session'))!
  assert.throws(() => contexts.rememberStartup(sessions.get('session'), { claude: [START], codex: [] }), { code: 'HOST_STARTUP_CONTEXT_UNAVAILABLE' })
  sessions.close('session')
  await assert.rejects(contexts.project(request([{ role: 'user', content: 'First' }]), token), { code: 'HOST_PROMPT_REQUEST_UNAVAILABLE' })
  contexts.dispose(); sessions.dispose()
})

test('Codex startup context occupies a developer message before the original user in Chat and Responses', async () => {
  for (const responses of [false, true]) {
    const sessions = new Sessions(), contexts = new PromptContexts()
    sessions.prompt('session', 'turn', 'fixture')
    contexts.remember(sessions.get('session'), ['Original'], [])
    contexts.rememberStartup(sessions.get('session'), { claude: [], codex: ['CODEX_START_CONTEXT'] })
    contexts.layout(sessions.get('session'), [{ id: 'turn', text: ['Original'] }])
    const token = contexts.issue(sessions.get('session'))!
    const source = responses ? { input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Original' }] }] } : { messages: [{ role: 'user', content: 'Original' }] }
    const output = await (await contexts.project(new Request('https://provider.invalid/v1/' + (responses ? 'responses' : 'chat/completions'), { method: 'POST', body: JSON.stringify(source) }), token)).json()
    const messages = responses ? output.input : output.messages
    assert.deepEqual(messages.map((row: any) => row.role), ['developer', 'user'])
    assert.deepEqual(messages[0].content, responses ? [{ type: 'input_text', text: 'CODEX_START_CONTEXT' }] : 'CODEX_START_CONTEXT')
    contexts.dispose(); sessions.dispose()
  }
})

test('withdrawing an unsaved prompt preserves earlier context and frees its layout position', () => {
  const sessions = new Sessions(), contexts = new PromptContexts()
  sessions.prompt('session', 'old', 'fixture')
  contexts.remember(sessions.get('session'), ['Old'], [])
  contexts.rememberStartup(sessions.get('session'), { claude: [START], codex: [] })
  const retained = contexts.inspect().bytes
  sessions.prompt('session', 'unsaved', 'fixture')
  contexts.remember(sessions.get('session'), ['Unsaved'], [])
  contexts.withdraw(sessions.get('session'))
  assert.equal(contexts.inspect().bytes, retained)
  assert.equal(contexts.inspect().prompts, 1)
  sessions.prompt('session', 'accepted', 'fixture')
  contexts.remember(sessions.get('session'), ['Accepted'], [])
  contexts.layout(sessions.get('session'), [{ id: 'old', text: ['Old'] }, { id: 'accepted', text: ['Accepted'] }])
  assert.ok(contexts.issue(sessions.get('session')))
  contexts.dispose(); sessions.dispose()
})
