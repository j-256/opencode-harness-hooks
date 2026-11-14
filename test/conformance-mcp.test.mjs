import assert from 'node:assert/strict'
import { test } from 'node:test'
import { compareMcpEvidence } from '../scripts/lib/conformance-mcp.mjs'

const modes = ['allow', 'deny', 'error', 'multiple', 'empty', 'invalid', 'timeout']
function fixture() {
  return modes.map(mode => ({ mode, done: true, parentCalls: 2, sideEffect: !['deny', 'multiple'].includes(mode), hookCalls: 1, exactArguments: true, feedback: ['deny', 'multiple'].includes(mode), noRecursion: true, parentIdentity: true, transcriptIsolated: true, childRemoved: true, internalNetwork: 0, before: 1, after: ['deny', 'multiple'].includes(mode) ? 0 : 1 }))
}
test('MCP comparison requires every literal effect, exact invocation, isolation and failure control on both sides', () => {
  const native = fixture(), host = fixture()
  assert.equal(compareMcpEvidence(native, host).status, 'passed')
  for (const mutate of [rows => rows.pop(), rows => rows.push(rows[0]), rows => { rows[0].mode = 'deny' }, rows => { rows[0].hookCalls = 0 }, rows => { rows[0].exactArguments = false }, rows => { rows[1].sideEffect = true }, rows => { rows[1].feedback = false }, rows => { rows[0].noRecursion = false }, rows => { rows[0].before++ }, rows => { rows[1].after++ }, rows => { rows[0].parentIdentity = false }, rows => { rows[0].transcriptIsolated = false }, rows => { rows[0].childRemoved = false }, rows => { rows[0].internalNetwork++ }, rows => { rows[0].done = false }, rows => { rows[0].parentCalls++ }]) {
    const changed = structuredClone(host); mutate(changed)
    assert.equal(compareMcpEvidence(native, changed).status, 'failed')
    assert.equal(compareMcpEvidence(changed, native).status, 'failed')
  }
})
