import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const library = () => import(new URL('../scripts/lib/conformance-posttool.mjs', import.meta.url).href)
const effect = 'POSTTOOL_OWNED_CONTEXT'
const options = { firstID: 'first', nextID: 'next', firstOutput: 'FIRST_OUTPUT', nextOutput: 'NEXT_OUTPUT', effect, replacement: false }
function trace(dialect = 'claude-code'): any {
  const controls = (dialect === 'codex' ? ['replacement', 'noop'] : ['context', 'feedback', 'noop']).map(id => {
    const effectView = id === 'noop' ? [] : [{ role: id === 'replacement' ? 'tool' : 'user', placement: id === 'replacement' ? 'tool-result' : 'message', order: id === 'replacement' ? 'inside' : 'after', occurrences: 1 }]
    return { id, postInvocations: 2, primaryModelCalls: 3, hookOrderValid: true, toolValid: true, cwdMatches: true, identitiesValid: true, inputMatches: true, transcriptExists: true, sideEffectsValid: true, resultOwned: true, firstResultValid: true, firstOriginalOutputPresent: id !== 'replacement', firstEffectTextPresent: id !== 'noop', nextResultClean: true, effectCountValid: true, effectView, nextEffectView: effectView.map(row => ({ ...row, nextOrder: 'before' })) }
  })
  return { sourceDigest: 'a'.repeat(64), hookDigest: 'b'.repeat(64), diagnostics: [], controls }
}

test('post-tool message observation distinguishes separate context from tool-result insertion', async () => {
  const { posttoolModelView } = await library()
  const native = posttoolModelView([{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'first', content: 'FIRST_OUTPUT' }, { type: 'text', text: effect }] }], 'anthropic', options, 'first')
  const host = posttoolModelView([{ role: 'tool', tool_call_id: 'first', content: 'FIRST_OUTPUT\n' + effect }], 'chat', options, 'first')
  assert.equal(native.resultOwned, true); assert.equal(native.resultValid, true)
  assert.deepEqual(native.effectView, [{ role: 'user', placement: 'message', order: 'after', occurrences: 1 }])
  assert.deepEqual(host.effectView, [{ role: 'tool', placement: 'tool-result', order: 'inside', occurrences: 1 }])
})

test('post-tool observation excludes arguments and metadata and rejects foreign or duplicate results', async () => {
  const { posttoolModelView } = await library()
  const result = { type: 'function_call_output', call_id: 'first', output: 'FIRST_OUTPUT' }
  const view = (rows: unknown[]) => posttoolModelView(rows, 'responses', options, 'first')
  assert.equal(view([result, { type: 'function_call', call_id: 'next', arguments: effect }, { type: 'message', role: 'user', content: [], metadata: effect }]).effectCountValid, false)
  assert.equal(view([result, result]).resultOwned, false)
  assert.equal(view([result, { ...result, call_id: 'foreign' }]).resultOwned, false)
  assert.equal(posttoolModelView([{ role: 'assistant', content: [{ type: 'tool_result', tool_use_id: 'first', content: 'FIRST_OUTPUT' }] }], 'anthropic', options, 'first').resultOwned, false)
})

test('post-tool replacement and later-call isolation inspect owned text rather than historical marker presence', async () => {
  const { posttoolModelView } = await library()
  const replacement = { ...options, effect: 'POSTTOOL_OWNED_REPLACEMENT', replacement: true }
  const first = { role: 'tool', tool_call_id: 'first', content: replacement.effect }
  const replaced = posttoolModelView([first], 'chat', replacement, 'first')
  assert.equal(replaced.resultValid, true); assert.equal(replaced.originalOutputPresent, false); assert.equal(replaced.effectTextPresent, true)
  const unreplaced = posttoolModelView([{ ...first, content: 'FIRST_OUTPUT' }], 'chat', replacement, 'first')
  assert.equal(unreplaced.originalOutputPresent, true); assert.equal(unreplaced.effectTextPresent, false)
  assert.equal(posttoolModelView([{ ...first, content: 'FIRST_OUTPUT\n' + replacement.effect }], 'chat', replacement, 'first').resultValid, false)
  const next = { role: 'tool', tool_call_id: 'next', content: 'NEXT_OUTPUT' }
  assert.equal(posttoolModelView([first, next], 'chat', replacement, 'next').resultValid, true)
  const leaked = posttoolModelView([first, { ...next, content: 'NEXT_OUTPUT\n' + replacement.effect }], 'chat', replacement, 'next')
  assert.equal(leaked.resultValid, false); assert.equal(leaked.effectCountValid, false)
  const noop = posttoolModelView([{ role: 'tool', tool_call_id: 'first', content: 'FIRST_OUTPUT' }], 'chat', { ...options, effect: undefined }, 'first')
  assert.equal(noop.resultValid, true); assert.equal(noop.effectCountValid, true); assert.deepEqual(noop.effectView, [])
})

test('post-tool comparisons preserve layout mismatches and unsupported diagnostics without false coverage', async () => {
  const { evaluatePosttoolObservations } = await library()
  assert.equal(evaluatePosttoolObservations(trace(), trace(), 'claude-code').status, 'passed')
  const host = trace(); host.controls[0].effectView[0].role = 'tool'; host.controls[0].effectView[0].placement = 'tool-result'; host.controls[0].effectView[0].order = 'inside'
  const mismatch = evaluatePosttoolObservations(trace(), host, 'claude-code')
  assert.equal(mismatch.status, 'failed'); assert.ok(mismatch.comparison.failures.includes('host.context.effectLayout'))
  for (const field of ['resultOwned', 'firstResultValid', 'nextResultClean', 'effectCountValid', 'sideEffectsValid', 'hookOrderValid']) {
    const value = trace(); value.controls[0][field] = false
    assert.equal(evaluatePosttoolObservations(value, structuredClone(value), 'claude-code').status, 'failed', field)
  }
  const unsupported = trace('codex'); unsupported.diagnostics = ['HOST_EFFECT_UNAVAILABLE']; unsupported.controls[0].firstResultValid = false
  const failed = evaluatePosttoolObservations(trace('codex'), unsupported, 'codex')
  assert.equal(failed.status, 'failed'); assert.ok(failed.comparison.failures.includes('host.diagnostics'))
  assert.deepEqual(failed.comparison.observations.host.diagnostics, ['HOST_EFFECT_UNAVAILABLE'])
})

test('post-tool receipts reject source substitutions and exclude arbitrary private fields', async () => {
  const { evaluatePosttoolObservations } = await library()
  const host = trace(); host.hookDigest = 'c'.repeat(64)
  assert.throws(() => evaluatePosttoolObservations(trace(), host, 'claude-code'), /CONFORMANCE_SOURCE_MISMATCH/)
  const bad = trace(); bad.controls[0].effectView[0].role = 'PRIVATE_ROLE'; bad.controls[0].secret = 'PRIVATE_PAYLOAD'
  assert.ok(!JSON.stringify(evaluatePosttoolObservations(trace(), bad, 'claude-code')).includes('PRIVATE_'))
})

test('later model requests cannot relocate a retained effect or move it past the next result', async () => {
  const { posttoolModelView, evaluatePosttoolObservations } = await library()
  const host = trace(); host.controls[0].nextEffectView = [{ role: 'developer', placement: 'message', order: 'after', occurrences: 1, nextOrder: 'after' }]
  assert.ok(evaluatePosttoolObservations(trace(), host, 'claude-code').comparison.failures.includes('host.context.nextEffectLayout'))
  const first = { role: 'tool', tool_call_id: 'first', content: 'FIRST_OUTPUT\n' + effect }, next = { role: 'tool', tool_call_id: 'next', content: 'NEXT_OUTPUT' }
  const retained = posttoolModelView([first, next], 'chat', options, 'next')
  assert.equal(retained.resultValid, true)
  assert.equal(retained.effectView[0].nextOrder, 'before')
  const relocated = posttoolModelView([{ ...first, content: 'FIRST_OUTPUT' }, next, { role: 'developer', content: effect }], 'chat', options, 'next')
  assert.equal(relocated.resultOwned, true); assert.equal(relocated.resultValid, true)
  assert.equal(relocated.effectView[0].nextOrder, 'after')
  host.controls[0].nextEffectView = relocated.effectView
  assert.ok(evaluatePosttoolObservations(trace(), host, 'claude-code').comparison.failures.includes('host.context.nextEffectLayout'))
  const moved = trace(); moved.controls[0].nextEffectView[0].nextOrder = 'after'
  assert.ok(evaluatePosttoolObservations(trace(), moved, 'claude-code').comparison.failures.includes('host.context.nextEffectLayout'))
  const changedRole = trace(); changedRole.controls[0].nextEffectView[0].role = 'developer'
  assert.ok(evaluatePosttoolObservations(trace(), changedRole, 'claude-code').comparison.failures.includes('host.context.nextEffectLayout'))
  assert.equal(evaluatePosttoolObservations(changedRole, structuredClone(changedRole), 'claude-code').status, 'failed')
  assert.equal(evaluatePosttoolObservations(trace(), trace(), 'claude-code').status, 'passed')
})

test('the post-tool fixture captures completed side effects and affects only the first call', async t => {
  const { createPosttoolFixture } = await library()
  const project = await mkdtemp(join(tmpdir(), "posttool-fixture-'owned-"))
  t.after(() => rm(project, { recursive: true, force: true }))
  const hook = join(project, 'hook.cjs'), capture = join(project, 'trace.jsonl')
  const fixture = createPosttoolFixture({ project, hook, trace: capture, node: process.execPath, dialect: 'claude-code' })
  await writeFile(hook, fixture.hookText)
  assert.deepEqual(fixture.cases, ['context', 'feedback', 'noop'])
  const invoke = (command: string) => new Promise<string>((resolve, reject) => { const child = execFile(process.execPath, [hook], (error, stdout) => error ? reject(error) : resolve(stdout)); child.stdin!.end(JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command } })) })
  const command = fixture.command('context', 'first')
  assert.ok(!command.includes(fixture.modelOptions('context', 'a', 'b').firstOutput))
  await new Promise<void>((resolve, reject) => execFile('/bin/sh', ['-c', command], error => error ? reject(error) : resolve()))
  assert.equal(JSON.parse(await invoke(command)).hookSpecificOutput.additionalContext, effect)
  assert.equal(await invoke(fixture.command('context', 'next')), '')
  const rows = (await readFile(capture, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.equal(rows[0].completedSideEffect, true); assert.equal(rows[1].completedSideEffect, false)
})

test('post-tool effects are narrow V1 requirements and a measured gap remains failed evidence', async () => {
  const catalog = JSON.parse(await readFile(new URL('../conformance/catalog.json', import.meta.url), 'utf8'))
  const { coverageReport, conformanceExitStatus } = await import(new URL('../scripts/lib/conformance.mjs', import.meta.url).href)
  for (const [dialect, prefix, nativeVersion] of [['claude-code', 'claude', '2.1.318'], ['codex', 'codex', '0.167.0']]) {
    const caseID = prefix + '.posttooluse.effects'
    assert.ok(catalog.cases.some((row: any) => row.id === caseID))
    const run = { caseID, host: 'v1', nativeVersion, hostVersion: '1.19.5', status: 'passed' }
    const report = coverageReport(catalog, [], [run])
    assert.equal(report.requirements.find((row: any) => row.id === dialect + '.posttooluse.effects').targets.v1.status, 'verified')
    for (const id of [dialect + '.effects.result', dialect + '.event.PostToolUse.outputs']) assert.equal(report.requirements.find((row: any) => row.id === id).targets.v1.status, 'unverified')
    assert.equal(report.requirements.find((row: any) => row.id === dialect + '.posttooluse.effects').targets.v2.status, 'unverified')
    assert.equal(conformanceExitStatus(report, 'v1', true), 4)
    const failed = coverageReport(catalog, [], [{ ...run, status: 'failed' }])
    assert.equal(failed.requirements.find((row: any) => row.id === dialect + '.posttooluse.effects').targets.v1.status, 'failed')
    assert.equal(conformanceExitStatus(failed, 'v1', true), 1)
  }
})
