import assert from 'node:assert/strict'
import { test } from 'node:test'
import { comparePromptModelEvidence } from '../scripts/lib/conformance-prompt-model.mjs'

const prompt = 'OWNED_HOOK_CONDITION $ARGUMENTS'
function fixture() {
  return ['allow', 'deny', 'invalid', 'timeout'].map(mode => ({ mode, hookCalls: 1, parentCalls: mode === 'deny' ? 0 : 2, sideEffect: mode !== 'deny', done: mode !== 'deny', isolated: true, inputRetained: true, childRemoved: true, artifacts: mode === 'invalid' ? [{ type: 'hook_non_blocking_error', hookName: 'UserPromptSubmit', hookEvent: 'UserPromptSubmit', toolUseID: '00000000-0000-4000-8000-000000000000', stderr: 'JSON validation failed', stdout: 'MALFORMED_DECISION', exitCode: 1, command: prompt, durationMs: 1 }] : [] }))
}
test('prompt model conformance requires every control, exact private failure evidence and owned cleanup', () => {
  const native = fixture(), host = fixture()
  assert.equal(comparePromptModelEvidence(native, host, prompt).status, 'passed')
  for (const mutate of [rows => { rows.pop() }, rows => { rows[0].hookCalls = 0 }, rows => { rows[1].parentCalls = 1 }, rows => { rows[2].artifacts[0].stdout = '{"ok":"wrong"}' }, rows => { rows[2].artifacts[0].durationMs = -1 }, rows => { rows[3].artifacts.push(rows[2].artifacts[0]) }, rows => { rows[0].isolated = false }, rows => { rows[0].inputRetained = false }, rows => { rows[0].childRemoved = false }, rows => { rows.push(rows[0]) }]) {
    const changed = structuredClone(host); mutate(changed)
    assert.equal(comparePromptModelEvidence(native, changed, prompt).status, 'failed')
  }
  const invalidNative = fixture(); invalidNative[0].sideEffect = false
  assert.equal(comparePromptModelEvidence(invalidNative, host, prompt).status, 'failed')
})
