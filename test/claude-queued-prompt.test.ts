import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import * as claude from '../src/claude-wake.js'
import { EXECUTION_LIMITS } from '../src/runner.js'

const oracle = JSON.parse(readFileSync(new URL('./fixtures/claude-queued-prompt-oracle.json', import.meta.url), 'utf8')) as { cases: { prompt: string; body: unknown }[] }
const identity = { sourceUUID: '11111111-1111-4111-8111-111111111111', deliveryID: '22222222-2222-4222-8222-222222222222', created: Date.parse('2026-01-01T00:00:00.000Z') }
for (const row of oracle.cases) test(`queued genuine input matches the native attachment and preserves its raw markup: ${JSON.stringify(row.prompt)}`, () => {
  const actual = claude.claudeQueuedPrompt({ ...identity, prompt: row.prompt })
  assert.deepEqual(JSON.parse(JSON.stringify(actual.body)), row.body)
  assert.deepEqual(actual.model, (row.body as { rendered: { content: string }[] }).rendered.map(row => row.content))
  assert.ok(Object.isFrozen(actual)); assert.ok(Object.isFrozen(actual.body)); assert.equal('humanModel' in actual, false)
  assert.ok(!actual.model[0]!.includes('NOT USER INPUT'))
})

test('queued genuine input rejects invalid identity, time, and input bounds before formatting', () => {
  for (const change of [{ sourceUUID: 'invalid' }, { deliveryID: '' }, { created: NaN }, { created: -1 }, { created: 1.5 }]) assert.throws(() => claude.claudeQueuedPrompt({ ...identity, prompt: 'GENUINE', ...change }), { code: 'CLAUDE_WAKE_IDENTITY_INVALID' })
  assert.throws(() => claude.claudeQueuedPrompt({ ...identity, prompt: 'x'.repeat(EXECUTION_LIMITS.inputBytes + 1) }), { code: 'CLAUDE_QUEUED_PROMPT_LIMIT' })
})
