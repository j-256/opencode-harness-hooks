import assert from 'node:assert/strict'
import { test } from 'node:test'

test('unsupported requirements prevent an equivalence claim even when the remaining cases pass', async () => {
  const { assessCompatibility } = await import('../src/contracts.js')
  const report = assessCompatibility([
    { id: 'PreToolUse.deny', required: true, status: 'verified', evidence: 'actual denied tool had no side effect' },
    { id: 'Stop.veto', required: true, status: 'unsupported', evidence: 'no awaited final-turn veto in pinned host' },
  ])
  assert.equal(report.equivalent, false)
  assert.deepEqual(report.blockers.map(item => item.id), ['Stop.veto'])
})

test('unresolved or missing evidence cannot establish compatibility', async () => {
  const { assessCompatibility } = await import('../src/contracts.js')
  for (const status of ['unresolved', 'verified'] as const) {
    assert.equal(assessCompatibility([{ id: 'example', required: true, status, evidence: '' }]).equivalent, false)
  }
  assert.equal(assessCompatibility([]).equivalent, false)
})

test('native event recognition accepts the full pinned catalogs and rejects cross-dialect guesses', async () => {
  const { isHookEvent, HANDLER_TYPES } = await import('../src/contracts.js')
  for (const event of ['UserPromptExpansion', 'PostToolBatch', 'PermissionDenied', 'StopFailure', 'PreModelSwitch', 'ElicitationResult']) {
    assert.equal(isHookEvent('claude-code', event), true, event)
    assert.equal(isHookEvent('codex', event), false, event)
  }
  for (const event of ['PreModelRequest', 'PostModelRequest', 'Interrupt']) {
    assert.equal(isHookEvent('codex', event), true, event)
    assert.equal(isHookEvent('claude-code', event), false, event)
  }
  for (const type of ['command', 'http', 'mcp_tool', 'prompt', 'agent']) assert.ok(HANDLER_TYPES.includes(type))
  assert.equal(isHookEvent('codex', 'stop'), false)
  assert.equal(isHookEvent('claude-code', 'UnknownEvent'), false)
})

