import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { claudeQueuedWake, claudeSystemWake, claudeSystemFeedback, claudeWakeText } from '../src/claude-wake.js'
import { EXECUTION_LIMITS } from '../src/runner.js'

interface Capture { name: string; hookName: string; text: string; prompt: string; model: string; modelInHumanTurn: string; queuedBody: unknown }
const oracle = JSON.parse(readFileSync(new URL('./fixtures/claude-wake-oracle.json', import.meta.url), 'utf8')) as { cases: Capture[]; idle: unknown }
const identity = { sourceUUID: '11111111-1111-4111-8111-111111111111', deliveryID: '22222222-2222-4222-8222-222222222222', created: 1700000000000 }
const feedback = JSON.parse(readFileSync(new URL('./fixtures/claude-wake-feedback-oracle.json', import.meta.url), 'utf8')) as { promptID: string; text: string; body: unknown; modelBeforeFollowingPrompt: string; withoutReasonText: string; withoutReasonModelBeforeFollowingPrompt: string }

test('wake prompts and both non-human model warnings match literal native captures without trimming or escaping unrelated markup', () => {
  for (const row of oracle.cases) {
    const output = claudeWakeText(row)
    assert.deepEqual(output, { prompt: row.prompt, model: row.model, modelInHumanTurn: row.modelInHumanTurn }, row.name)
    assert.ok(Object.isFrozen(output))
  }
})

test('active wake artifacts retain native queued-command identities and both rendered variants rather than admitting a new human input', () => {
  for (const row of oracle.cases) {
    const output = claudeQueuedWake({ ...row, ...identity })
    assert.deepEqual(JSON.parse(JSON.stringify(output.body)), row.queuedBody, row.name)
    assert.equal(output.created, identity.created)
    assert.deepEqual(output.model, [row.model]); assert.deepEqual(output.humanModel, [row.modelInHumanTurn])
    assert.ok(Object.isFrozen(output.body)); assert.ok(Object.isFrozen(output.body.attachment)); assert.ok(Object.isFrozen(output.body.renderedInHumanTurn))
    assert.equal(Object.hasOwn(output.body, 'message'), false)
  }
})

test('idle notification rows keep their system origin and supplied genuine/turn indexes', () => {
  const row = oracle.cases[0]!, input = { ...row, promptID: '33333333-3333-4333-8333-333333333333', promptIndex: 0, turnIndex: 2 }
  const output = claudeSystemWake(input)
  assert.deepEqual(JSON.parse(JSON.stringify(output)), oracle.idle)
  assert.ok(Object.isFrozen(output)); assert.ok(Object.isFrozen(output.message)); assert.ok(Object.isFrozen(output.origin))
  assert.equal(Object.hasOwn(output, 'isMeta'), false)
})

test('wake codecs reject absent identities, impossible positions and unbounded source output before producing native history', () => {
  const row = oracle.cases[0]!
  for (const input of [{ ...row, hookName: '' }, { ...row, hookName: 'bad\0name' }]) assert.throws(() => claudeWakeText(input), { code: 'CLAUDE_WAKE_INPUT_INVALID' })
  for (const text of ['x'.repeat(EXECUTION_LIMITS.outputBytes + 1), '雪'.repeat(Math.floor(EXECUTION_LIMITS.outputBytes / 3) + 1)]) assert.throws(() => claudeWakeText({ ...row, text }), { code: 'CLAUDE_WAKE_LIMIT' })
  for (const change of [{ sourceUUID: 'host-message' }, { deliveryID: '' }, { created: NaN }, { created: -1 }, { created: 8640000000000001 }]) assert.throws(() => claudeQueuedWake({ ...row, ...identity, ...change }), { code: 'CLAUDE_WAKE_IDENTITY_INVALID' })
  for (const change of [{ promptID: '' }, { promptIndex: -1 }, { turnIndex: 0 }, { promptIndex: 0.5 }, { promptIndex: 2, turnIndex: 2 }]) assert.throws(() => claudeSystemWake({ ...row, promptID: 'native-prompt', promptIndex: 0, turnIndex: 2, ...change }), { code: 'CLAUDE_WAKE_IDENTITY_INVALID' })
})

test('idle terminal feedback retains its literal native meta-user origin and a non-human wrapper before later genuine input', () => {
  const result = claudeSystemFeedback({ promptID: feedback.promptID, text: feedback.text, created: identity.created })
  assert.deepEqual(JSON.parse(JSON.stringify(result.body)), feedback.body)
  assert.equal(result.model[0] + '\n', feedback.modelBeforeFollowingPrompt)
  assert.equal(claudeSystemFeedback({ promptID: feedback.promptID, text: feedback.withoutReasonText, created: identity.created }).model[0] + '\n', feedback.withoutReasonModelBeforeFollowingPrompt)
  assert.equal(result.created, identity.created); assert.ok(Object.isFrozen(result.body)); assert.ok(Object.isFrozen(result.model))
  for (const change of [{ promptID: '' }, { created: NaN }, { created: -1 }]) assert.throws(() => claudeSystemFeedback({ ...feedback, created: identity.created, ...change }), { code: 'CLAUDE_WAKE_IDENTITY_INVALID' })
  assert.throws(() => claudeSystemFeedback({ promptID: feedback.promptID, created: identity.created, text: 'x'.repeat(EXECUTION_LIMITS.outputBytes + 1) }), { code: 'CLAUDE_WAKE_LIMIT' })
})
