import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { test } from 'node:test'

const library = () => import(new URL('../scripts/lib/conformance-rewrite.mjs', import.meta.url).href)
const run = promisify(execFile)
function trace() {
  return { sourceDigest: 'a'.repeat(64), hookDigest: 'b'.repeat(64), controls: ['rewrite', 'unchanged'].map(id => ({ id, preInvocations: 1, postInvocations: 1, eventOrderValid: true, toolValid: true, cwdMatches: true, preInputMatches: true, postInputMatches: true, identitiesValid: true, transcriptExists: true, sideEffectContentsValid: true, originalSideEffect: false, replacementSideEffect: id === 'rewrite', controlSideEffect: id === 'unchanged', resultOwned: true, resultMatches: true, primaryModelCalls: 2 })) }
}

test('rewrite comparison requires literal positive and unchanged controls, not merely equal observations', async () => {
  const { evaluateRewriteObservations } = await library()
  assert.equal(evaluateRewriteObservations(trace(), trace()).status, 'passed')
  for (const [field, value] of Object.entries({ preInvocations: 0, postInvocations: 2, eventOrderValid: false, toolValid: false, cwdMatches: false, preInputMatches: false, postInputMatches: false, identitiesValid: false, transcriptExists: false, sideEffectContentsValid: false, originalSideEffect: true, replacementSideEffect: false, resultOwned: false, resultMatches: false, primaryModelCalls: 1 })) {
    const native = trace(); (native.controls[0] as any)[field] = value
    const result = evaluateRewriteObservations(native, structuredClone(native))
    assert.equal(result.status, 'failed', field)
    assert.equal(result.comparison.failure, 'CONFORMANCE_REWRITE_FAILED: native.rewrite.' + field)
  }
  const host = trace(); host.controls[1]!.controlSideEffect = false
  assert.equal(evaluateRewriteObservations(trace(), host).status, 'failed')
})

test('rewrite receipts reject substituted sources and malformed traces and exclude private values', async () => {
  const { evaluateRewriteObservations } = await library()
  const host = trace(); host.hookDigest = 'c'.repeat(64)
  assert.throws(() => evaluateRewriteObservations(trace(), host), /CONFORMANCE_SOURCE_MISMATCH/)
  for (const mutate of [(value: any) => { value.controls.pop() }, (value: any) => { value.sourceDigest = '' }]) {
    const value = trace(); mutate(value)
    assert.throws(() => evaluateRewriteObservations(trace(), value), /CONFORMANCE_OBSERVATION_INVALID/)
  }
  const privateTrace = trace(); (privateTrace.controls[0] as any).postInputMatches = 'PRIVATE_COMMAND'; (privateTrace.controls[0] as any).payload = 'PRIVATE_PAYLOAD'
  const failed = evaluateRewriteObservations(trace(), privateTrace)
  assert.equal(failed.status, 'failed')
  assert.ok(!JSON.stringify(failed).includes('PRIVATE_'))
  assert.equal(failed.comparison.observations.host[0].postInputMatches, null)
})

test('rewrite result checks require exactly one owned result with the literal output rather than metadata', async () => {
  const { rewriteToolResult } = await library()
  for (const transport of ['responses', 'anthropic', 'chat']) {
    const result = (id: string, text: unknown) => transport === 'responses' ? { type: 'function_call_output', call_id: id, output: text } : transport === 'anthropic' ? { type: 'tool_result', tool_use_id: id, content: text } : { role: 'tool', tool_call_id: id, content: text }
    const wrap = (rows: any[]) => transport === 'anthropic' ? [{ role: 'user', content: rows }] : rows
    const owned = result('owned', 'Wrapped EXPECTED output')
    assert.deepEqual(rewriteToolResult(wrap([owned]), transport, 'owned', 'EXPECTED', ['ORIGINAL']), { resultOwned: true, resultMatches: true })
    assert.equal(rewriteToolResult(wrap([result('other', 'EXPECTED'), result('owned', 'Other output')]), transport, 'owned', 'EXPECTED', []).resultMatches, false)
    assert.equal(rewriteToolResult(wrap([owned, owned]), transport, 'owned', 'EXPECTED', []).resultOwned, false)
    assert.equal(rewriteToolResult(wrap([result('other', 'EXPECTED')]), transport, 'owned', 'EXPECTED', []).resultOwned, false)
    assert.deepEqual(rewriteToolResult(wrap([owned, result('never-emitted', 'EXPECTED ORIGINAL')]), transport, 'owned', 'EXPECTED', ['ORIGINAL']), { resultOwned: false, resultMatches: false })
    assert.deepEqual(rewriteToolResult(wrap([owned, result('never-emitted', 'Other output')]), transport, 'owned', 'EXPECTED', ['ORIGINAL']), { resultOwned: false, resultMatches: false })
    assert.equal(rewriteToolResult(wrap([result('owned', 'EXPECTED EXPECTED')]), transport, 'owned', 'EXPECTED', []).resultMatches, false)
    assert.equal(rewriteToolResult(wrap([{ ...result('owned', 'Other output'), metadata: 'EXPECTED' }]), transport, 'owned', 'EXPECTED', []).resultMatches, false)
    assert.equal(rewriteToolResult(wrap([result('owned', 'EXPECTED ORIGINAL')]), transport, 'owned', 'EXPECTED', ['ORIGINAL']).resultMatches, false)
  }
})

test('one unchanged hook script captures both events and rewrites only its owned positive command', async t => {
  const { createRewriteFixture } = await library()
  const project = await mkdtemp(join(tmpdir(), "conformance-rewrite-'owned-"))
  t.after(() => rm(project, { recursive: true, force: true }))
  const hook = join(project, 'hook.cjs'), capture = join(project, 'capture.jsonl')
  const fixture = createRewriteFixture({ project, hook, trace: capture, node: process.execPath })
  for (const id of ['rewrite', 'unchanged']) assert.ok(!fixture.command(id).includes(fixture.expectedOutput(id)))
  assert.ok(!fixture.replacementCommand.includes(fixture.expectedOutput('rewrite')))
  await writeFile(hook, fixture.hookText)
  const source = JSON.parse(fixture.sourceText)
  assert.deepEqual(source.hooks.PreToolUse, source.hooks.PostToolUse)
  const pre = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: fixture.command('rewrite') } }
  const invoke = (input: unknown) => new Promise<{ stdout: string }>((resolve, reject) => {
    const child = execFile(process.execPath, [hook], { timeout: 5000 }, (error, stdout) => error ? reject(error) : resolve({ stdout }))
    child.stdin!.end(JSON.stringify(input))
  })
  const decision = JSON.parse((await invoke(pre)).stdout).hookSpecificOutput
  assert.equal(decision.permissionDecision, 'allow')
  assert.equal(decision.updatedInput.command, fixture.replacementCommand)
  const execution = await run('/bin/sh', ['-c', decision.updatedInput.command], { cwd: project })
  assert.equal(execution.stdout, fixture.expectedOutput('rewrite'))
  await assert.rejects(access(fixture.markerPaths.original), { code: 'ENOENT' })
  assert.equal(await readFile(fixture.markerPaths.replacement, 'utf8'), 'CONFORMANCE_REWRITTEN')
  assert.equal((await invoke({ ...pre, tool_input: { command: fixture.command('unchanged') } })).stdout, '')
  assert.equal((await invoke({ ...pre, hook_event_name: 'PostToolUse', tool_input: decision.updatedInput })).stdout, '')
  const captured = (await readFile(capture, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.equal(captured.length, 3)
  assert.equal(captured[0].input.tool_input.command, fixture.command('rewrite'))
  assert.equal(captured[2].input.tool_input.command, fixture.replacementCommand)
})

test('rewrite observers bind actual side effects to both events and the same owned call', async t => {
  const { createRewriteFixture, observeRewrite } = await library()
  const project = await mkdtemp(join(tmpdir(), 'conformance-rewrite-observer-'))
  t.after(() => rm(project, { recursive: true, force: true }))
  const fixture = createRewriteFixture({ project, hook: join(project, 'hook.cjs'), trace: join(project, 'trace'), node: process.execPath })
  await run('/bin/sh', ['-c', fixture.replacementCommand], { cwd: project })
  const input = { session_id: 'session', turn_id: 'turn', tool_use_id: 'owned', permission_mode: 'bypassPermissions', model: 'fixture', tool_name: 'Bash', cwd: project }
  const lines = [{ input: { ...input, hook_event_name: 'PreToolUse', tool_input: { command: fixture.command('rewrite') } }, transcriptExists: true }, { input: { ...input, hook_event_name: 'PostToolUse', tool_input: { command: fixture.replacementCommand } }, transcriptExists: true }]
  const options = { fixture, lines, requests: { count: 2, resultOwned: true, resultMatches: true }, dialect: 'codex', toolUseID: 'owned', project, id: 'rewrite' }
  assert.deepEqual(await observeRewrite(options), trace().controls[0])
  lines[1]!.input.session_id = 'foreign'
  assert.equal((await observeRewrite(options)).identitiesValid, false)
  lines[1]!.input.session_id = 'session'
  lines[1]!.input.tool_input.command = fixture.command('rewrite')
  assert.equal((await observeRewrite(options)).postInputMatches, false)
  await writeFile(fixture.markerPaths.replacement, 'Other content')
  assert.equal((await observeRewrite(options)).sideEffectContentsValid, false)
  assert.equal((await observeRewrite({ ...options, lines: [] })).eventOrderValid, false)
})

test('rewrite cases verify only their own narrow dialect and V1 requirements', async () => {
  const catalog = JSON.parse(await readFile(new URL('../conformance/catalog.json', import.meta.url), 'utf8'))
  const { coverageReport, conformanceExitStatus } = await import(new URL('../scripts/lib/conformance.mjs', import.meta.url).href)
  for (const [dialect, prefix, version] of [['claude-code', 'claude', '2.1.318'], ['codex', 'codex', '0.167.0']]) {
    const caseID = prefix + '.pretooluse.input-rewrite'
    assert.ok(catalog.cases.some((row: any) => row.id === caseID), caseID)
    const run = { caseID, host: 'v1', nativeVersion: version, hostVersion: '1.19.5', status: 'passed' }
    const report = coverageReport(catalog, [], [run])
    assert.equal(report.requirements.find((row: any) => row.id === dialect + '.pretooluse.input-rewrite').targets.v1.status, 'verified')
    assert.equal(report.requirements.find((row: any) => row.id === dialect + '.posttooluse.rewritten-input').targets.v1.status, 'verified')
    assert.equal(report.requirements.find((row: any) => row.id === dialect + '.effects.input').targets.v1.status, 'unverified')
    assert.equal(report.requirements.find((row: any) => row.id === dialect + '.event.PostToolUse.payload').targets.v1.status, 'unverified')
    assert.equal(report.requirements.find((row: any) => row.id === dialect + '.pretooluse.input-rewrite').targets.v2.status, 'unverified')
    assert.equal(report.nativeConformant, false)
    assert.equal(conformanceExitStatus(report, 'v1', true), 4)
    const failed = coverageReport(catalog, [], [{ ...run, status: 'failed' }])
    assert.equal(conformanceExitStatus(failed, 'v1', true), 1)
    const mixed = coverageReport(catalog, [], [{ caseID: 'claude.pretooluse.control', host: 'v1', nativeVersion: '2.1.318', hostVersion: '1.19.5', status: 'passed' }, { ...run, status: 'failed' }])
    assert.equal(mixed.requirements.find((row: any) => row.id === 'claude-code.pretooluse.deny').targets.v1.status, 'verified')
    assert.equal(mixed.requirements.find((row: any) => row.id === dialect + '.pretooluse.input-rewrite').targets.v1.status, 'failed')
    assert.equal(conformanceExitStatus(mixed, 'v1', true), 1)
  }
})
