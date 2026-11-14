import assert from 'node:assert/strict'
import { test } from 'node:test'
import { compareAgentModelEvidence } from '../scripts/lib/conformance-agent-model.mjs'

const cases = ['read', 'deny', 'write-denied', 'write-allowed', 'invalid', 'incomplete', 'timeout', 'api-error', 'turn-limit']
function fixture() {
  return cases.map(mode => ({ mode, hookCalls: mode === 'invalid' || mode === 'turn-limit' ? 50 : mode === 'api-error' ? 4 : mode === 'timeout' ? 1 : 2, parentCalls: mode === 'deny' ? 0 : 2, done: mode !== 'deny', sideEffect: mode !== 'deny', evaluatorWrite: mode === 'write-allowed', isolated: true, inputRetained: true, childRemoved: true, callerInstructionObserved: mode !== 'deny', readResult: ['read', 'deny', 'invalid', 'turn-limit'].includes(mode), artifacts: [], tools: (['timeout', 'api-error', 'incomplete'].includes(mode) ? [] : mode === 'turn-limit' ? Array.from({ length: 49 }, (_, i) => ['PreToolUse', 'PostToolUse'].map(event => ({ event, tool: 'Read', callID: 'read-' + i }))).flat() : [{ event: 'PreToolUse', tool: mode.startsWith('write') ? 'Bash' : 'Read', callID: 'first' }, ...(mode !== 'write-denied' ? [{ event: 'PostToolUse', tool: mode.startsWith('write') ? 'Bash' : 'Read', callID: 'first' }] : []), ...(mode !== 'invalid' ? [{ event: 'PreToolUse', tool: 'StructuredOutput', callID: 'verdict' }, { event: 'PostToolUse', tool: 'StructuredOutput', callID: 'verdict' }] : [])]).map(row => ({ ...row, parentIdentity: true, permissionMode: 'dontAsk', transcriptExists: false })), parentContext: mode === 'deny' ? null : { permissionMode: 'bypassPermissions', transcriptExists: true, evaluatorIDsAbsent: true } }))
}

test('agent comparison requires literal native effects, nested tool boundaries and every failure control', () => {
  const native = fixture(), host = fixture()
  assert.equal(compareAgentModelEvidence(native, host).status, 'passed')
  for (const mutate of [rows => rows.pop(), rows => rows.push(rows[0]), rows => { rows[0].hookCalls = 0 }, rows => { rows[0].tools.pop() }, rows => { rows[0].tools.push(rows[0].tools[0]) }, rows => { rows[0].tools[0].parentIdentity = false }, rows => { rows[0].tools[0].permissionMode = 'bypassPermissions' }, rows => { rows[0].tools[0].transcriptExists = true }, rows => { rows[0].tools[1].callID = 'foreign' }, rows => { rows[0].parentContext.evaluatorIDsAbsent = false }, rows => { rows[1].parentCalls = 1 }, rows => { rows[2].evaluatorWrite = true }, rows => { rows[3].evaluatorWrite = false }, rows => { rows[4].tools.push({ ...rows[0].tools[2] }) }, rows => { rows[5].hookCalls = 1 }, rows => { rows[6].artifacts.push({ type: 'hook_non_blocking_error' }) }, rows => { rows[7].hookCalls = 1 }, rows => { rows[8].hookCalls = 51 }, rows => { rows[0].callerInstructionObserved = false }, rows => { rows[0].isolated = false }, rows => { rows[0].inputRetained = false }, rows => { rows[0].childRemoved = false }, rows => { rows[0].readResult = false }]) {
    const changed = structuredClone(host); mutate(changed)
    assert.equal(compareAgentModelEvidence(native, changed).status, 'failed')
  }
  const invalid = fixture(); invalid[0].sideEffect = false
  assert.equal(compareAgentModelEvidence(invalid, host).status, 'failed')
})
