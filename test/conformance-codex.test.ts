import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

test('Codex native controls verify only their own narrow V1 requirements', async () => {
  const { coverageReport } = await import(new URL('../scripts/lib/conformance.mjs', import.meta.url).href)
  const catalog = JSON.parse(await readFile(new URL('../conformance/catalog.json', import.meta.url), 'utf8'))
  const report = coverageReport(catalog, [], [{ caseID: 'codex.pretooluse.control', host: 'v1', nativeVersion: '0.167.0', hostVersion: '1.19.5', status: 'passed' }])
  assert.equal(report.requirements.find((row: any) => row.id === 'codex.pretooluse.deny').targets.v1.status, 'verified')
  assert.equal(report.requirements.find((row: any) => row.id === 'codex.pretooluse.allow-control').targets.v1.status, 'verified')
  assert.equal(report.requirements.find((row: any) => row.id === 'claude-code.pretooluse.deny').targets.v1.status, 'unverified')
  assert.equal(report.requirements.find((row: any) => row.id === 'codex.event.PreToolUse.payload').targets.v1.status, 'unverified')
  assert.equal(report.requirements.find((row: any) => row.id === 'codex.pretooluse.deny').targets.v2.status, 'unverified')
  assert.equal(report.nativeConformant, false)
})

test('Codex identity needs its own actual turn, model and owned call relationship', async () => {
  const { controlIdentityValid } = await import(new URL('../scripts/lib/conformance-pretool.mjs', import.meta.url).href)
  const input = { session_id: 'session', turn_id: 'turn', tool_use_id: 'owned-call', permission_mode: 'bypassPermissions', model: 'fixture' }
  assert.equal(controlIdentityValid(input, 'codex', 'owned-call'), true)
  for (const mutation of [{ session_id: '' }, { turn_id: '' }, { model: 'other' }, { tool_use_id: 'other-call' }, { permission_mode: 'default' }]) assert.equal(controlIdentityValid({ ...input, ...mutation }, 'codex', 'owned-call'), false)
  assert.equal(controlIdentityValid({ ...input, turn_id: undefined, model: undefined }, 'claude-code', 'owned-call'), true)
})

test('a real control mismatch remains a failed receipt with safe native and host observations', async () => {
  const { evaluateControlObservations, conformanceExitStatus, coverageReport } = await import(new URL('../scripts/lib/conformance.mjs', import.meta.url).href)
  const trace = () => ({ sourceDigest: 'a'.repeat(64), hookDigest: 'b'.repeat(64), controls: [
    { id: 'deny', hookInvocations: 1, event: 'PreToolUse', tool: 'Bash', cwdMatches: true, commandMatches: true, identityValid: true, transcriptExists: true, resultOwned: true, reasonDelivered: true, sideEffect: false, primaryModelCalls: 2 },
    { id: 'allow', hookInvocations: 1, event: 'PreToolUse', tool: 'Bash', cwdMatches: true, commandMatches: true, identityValid: true, transcriptExists: true, resultOwned: true, reasonDelivered: false, sideEffect: true, primaryModelCalls: 2 },
  ] })
  const native = trace(), host = trace()
  host.controls[0]!.transcriptExists = false
  const result = evaluateControlObservations(native, host)
  assert.equal(result.status, 'failed')
  assert.equal(result.comparison.match, false)
  assert.equal(result.comparison.sourceDigest, native.sourceDigest)
  assert.equal(result.comparison.hookDigest, native.hookDigest)
  assert.equal(result.comparison.failure, 'CONFORMANCE_CONTROL_FAILED: host.deny.transcriptExists')
  assert.equal(result.comparison.observations.native[0].transcriptExists, true)
  assert.equal(result.comparison.observations.host[0].transcriptExists, false)
  host.controls[0]!.event = 'Private payload must not appear'
  assert.ok(!JSON.stringify(evaluateControlObservations(native, host)).includes('Private payload'))
  const catalog = JSON.parse(await readFile(new URL('../conformance/catalog.json', import.meta.url), 'utf8'))
  const report = coverageReport(catalog, [], [{ caseID: 'codex.pretooluse.control', host: 'v1', nativeVersion: '0.167.0', hostVersion: '1.19.5', ...result }])
  assert.equal(report.requirements.find((row: any) => row.id === 'codex.pretooluse.deny').targets.v1.status, 'failed')
  assert.equal(conformanceExitStatus(report, 'v1', false), 1)
  assert.equal(conformanceExitStatus(report, 'v1', true), 1)
  assert.equal(conformanceExitStatus(coverageReport(catalog, []), 'v1', true), 4)
})

test('model-visible denial is attached to exactly one owned tool result and actual text', async () => {
  const { controlToolResult } = await import(new URL('../scripts/lib/conformance-pretool.mjs', import.meta.url).href)
  const reason = 'CONFORMANCE_OWNED_DENIAL_REASON'
  const scenarios = [
    { transport: 'responses', messages: [{ type: 'function_call_output', call_id: 'owned', output: reason }] },
    { transport: 'anthropic', messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'owned', content: reason }] }] },
    { transport: 'chat', messages: [{ role: 'tool', tool_call_id: 'owned', content: reason }] },
  ]
  for (const { transport, messages } of scenarios) {
    assert.deepEqual(controlToolResult(messages, transport, 'owned'), { resultOwned: true, reasonDelivered: true })
    const wrong = JSON.parse(JSON.stringify(messages).replaceAll('owned', 'wrong-call'))
    assert.deepEqual(controlToolResult(wrong, transport, 'owned'), { resultOwned: false, reasonDelivered: false })
    assert.equal(controlToolResult([...messages, ...messages], transport, 'owned').resultOwned, false)
    const metadataOnly = transport === 'anthropic' ? [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'owned', content: 'Unrelated output', metadata: reason }] }] : [{ ...messages[0], output: 'Unrelated output', content: 'Unrelated output', metadata: reason }]
    assert.deepEqual(controlToolResult(metadataOnly, transport, 'owned'), { resultOwned: true, reasonDelivered: false })
  }
})
