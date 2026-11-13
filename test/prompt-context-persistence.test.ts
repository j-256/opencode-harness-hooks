import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PromptContexts } from '../src/prompt-contexts.js'
import { Sessions } from '../src/sessions.js'
import type { AttributedAction } from '../src/engine.js'
import type { HookAction } from '../src/effect-types.js'

const context = (dialect: 'claude-code' | 'codex', text: string): AttributedAction<Extract<HookAction, { kind: 'context' }>> => ({ sourceID: dialect, sourceDigest: 'revision', registrationID: text, dialect, configuredOrder: 0, completionOrder: 0, action: { kind: 'context', placement: 'model', text, ...(dialect === 'claude-code' ? { channel: 'additionalContext' as const } : {}) } })
const request = () => new Request('https://provider.invalid/v1/chat/completions', { method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', content: 'Same' }, { role: 'assistant', content: 'Earlier' }, { role: 'user', content: 'Same' }] }) })

test('cold prompt restoration retains mixed contexts at original user positions while invalidating old tickets', async () => {
  const sessions = new Sessions(), source = new PromptContexts(), restored = new PromptContexts(), next = new Sessions()
  sessions.prompt('session', 'first', 'fixture')
  source.remember(sessions.get('session'), ['Same'], [context('claude-code', 'CLAUDE'), context('codex', 'CODEX')])
  source.rememberStartup(sessions.get('session'), { claude: ['CLAUDE_START'], codex: ['CODEX_START'] })
  source.layout(sessions.get('session'), [{ id: 'first', text: ['Same'] }])
  const stale = source.issue(sessions.get('session'))!, snapshot = source.snapshotV1('session')
  source.dispose(); sessions.dispose()
  restored.restoreV1(next.get('session'), snapshot)
  assert.equal(restored.owner(stale), undefined)
  assert.equal(restored.inspect().tickets, 0)
  next.prompt('session', 'second', 'fixture')
  const owner = next.get('session')
  restored.remember(owner, ['Same'], [context('codex', 'SECOND')])
  assert.throws(() => restored.issue(owner), { code: 'HOST_PROMPT_LAYOUT_UNAVAILABLE' })
  restored.layout(owner, [{ id: 'first', text: ['Same'] }, { id: 'second', text: ['Same'] }])
  const body = await (await restored.project(request(), restored.issue(owner)!)).json()
  assert.deepEqual(body.messages, [
    { role: 'developer', content: 'CODEX_START' },
    { role: 'user', content: [{ type: 'text', text: 'CLAUDE_START' }, { type: 'text', text: '<system-reminder>\nUserPromptSubmit hook additional context: CLAUDE\n</system-reminder>' }, { type: 'text', text: 'Same' }] },
    { role: 'developer', content: 'CODEX' }, { role: 'assistant', content: 'Earlier' },
    { role: 'user', content: 'Same' }, { role: 'developer', content: 'SECOND' },
  ])
  next.close('session')
  assert.deepEqual(restored.inspect(), { prompts: 0, continuations: 0, bytes: 0, tickets: 0, sessions: 0 })
  restored.dispose(); next.dispose()
})

test('prompt snapshot validation cannot partially admit changed owners, duplicate entries or unsupported actions', () => {
  const sessions = new Sessions(), source = new PromptContexts()
  sessions.prompt('session', 'first', 'fixture')
  source.remember(sessions.get('session'), ['Same'], [context('claude-code', 'CLAUDE')])
  const snapshot = source.snapshotV1('session')
  for (const mutate of [
    (value: any) => { value.sessionID = 'foreign' },
    (value: any) => { value.entries.push(structuredClone(value.entries[0])) },
    (value: any) => { value.entries[0].contexts[0].action.kind = 'block-event' },
    (value: any) => { value.entries[0].contexts[0].action.channel = 'systemMessage' },
    (value: any) => { value.entries[0].startup = { claude: ['VALID'], codex: [false] } },
  ]) {
    const restored = new PromptContexts(), next = new Sessions(), value = structuredClone(snapshot)
    mutate(value)
    assert.throws(() => restored.restoreV1(next.get('session'), value))
    assert.equal(restored.inspect().prompts, 0)
    assert.equal(restored.inspect().bytes, 0)
    restored.dispose(); next.dispose()
  }
  assert.throws(() => source.restoreV1(sessions.get('session'), snapshot), { code: 'SESSION_SNAPSHOT_STATE_CONFLICT' })
  source.dispose(); sessions.dispose()
})

test('V1 context snapshots reject continuation and Stop history state rather than silently dropping it', () => {
  const sessions = new Sessions(), contexts = new PromptContexts()
  sessions.prompt('session', 'first', 'fixture')
  contexts.remember(sessions.get('session'), ['Original'], [])
  contexts.rememberContinuation(sessions.get('session'), 'continuation', ['Feedback'])
  assert.throws(() => contexts.snapshotV1('session'), { code: 'SESSION_SNAPSHOT_HOST_UNSUPPORTED' })
  contexts.dispose(); sessions.dispose()
})
