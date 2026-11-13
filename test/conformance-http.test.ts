import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const library = () => import(new URL('../scripts/lib/conformance-http.mjs', import.meta.url).href)

test('HTTP fixture receives native POSTs, executes only its trusted endpoint program and preserves source selection', async t => {
  const { startHttpHook, httpSource } = await library()
  const project = await mkdtemp(join(tmpdir(), 'http-hook-fixture-')), hook = join(project, 'hook.cjs'), capture = join(project, 'payload.json')
  await writeFile(hook, `const fs=require('node:fs');const p=JSON.parse(fs.readFileSync(0,'utf8'));fs.writeFileSync(${JSON.stringify(capture)},JSON.stringify(p));console.log(JSON.stringify({hookSpecificOutput:{hookEventName:p.hook_event_name,additionalContext:'HTTP_CONTEXT'}}))`)
  const endpoint = await startHttpHook({ hook, project })
  t.after(async () => { await endpoint.close(); await rm(project, { recursive: true, force: true }) })
  const payload = { hook_event_name: 'PostToolUse', tool_input: { command: 'OPAQUE_INPUT' } }
  const response = await fetch(endpoint.url, { method: 'POST', body: JSON.stringify(payload) })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).hookSpecificOutput.additionalContext, 'HTTP_CONTEXT')
  assert.deepEqual(JSON.parse(await readFile(capture, 'utf8')), payload)
  assert.deepEqual(endpoint.inspect(), { requests: 1, redirectsFollowed: 0, errors: 0 })
  const source = JSON.stringify({ hooks: { PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'PRIVATE_COMMAND' }] }] } })
  const parsed = JSON.parse(httpSource(source, endpoint.url))
  assert.equal(parsed.hooks.PostToolUse[0].matcher, 'Bash')
  assert.deepEqual(parsed.hooks.PostToolUse[0].hooks, [{ type: 'http', url: endpoint.url, timeout: 1 }])
  assert.equal(JSON.stringify(parsed).includes('PRIVATE_COMMAND'), false)
})

test('HTTP fixture faults have explicit status/body/redirect behavior and bounded timeout cleanup', async t => {
  const { startHttpHook } = await library()
  const project = await mkdtemp(join(tmpdir(), 'http-hook-faults-')), hook = join(project, 'hook.cjs')
  await writeFile(hook, 'process.stdin.resume();process.stdin.on("end",()=>console.log("{}"))')
  t.after(() => rm(project, { recursive: true, force: true }))
  for (const mode of ['status', 'invalid', 'redirect', 'timeout']) {
    const endpoint = await startHttpHook({ hook, project, mode, reason: 'HTTP_UNTRUSTED_BODY' })
    try {
      if (mode === 'timeout') await assert.rejects(async () => { const res = await fetch(endpoint.url, { method: 'POST', body: '{}', signal: AbortSignal.timeout(400) }); await res.text() })
      else {
        const response = await fetch(endpoint.url, { method: 'POST', body: '{}', redirect: 'manual' })
        assert.equal(response.status, mode === 'status' ? 500 : mode === 'redirect' ? 302 : 200)
        if (mode !== 'redirect') assert.equal(await response.text(), 'HTTP_UNTRUSTED_BODY')
      }
      assert.equal(endpoint.inspect().requests, 1)
      assert.equal(endpoint.inspect().redirectsFollowed, 0)
    } finally { await endpoint.close() }
  }
})

function trace(): any {
  return { sourceDigest: 'a'.repeat(64), hookDigest: 'b'.repeat(64), controls: ['deny', 'allow'].map(id => ({ id, hookInvocations: 1, event: 'PreToolUse', tool: 'Bash', cwdMatches: true, commandMatches: true, identityValid: true, transcriptExists: true, resultOwned: true, reasonDelivered: false, sideEffect: true, primaryModelCalls: 2, httpTransportValid: true, httpFailureBodyAbsent: true })) }
}

test('HTTP failure comparisons require literal nonblocking disposition and healthy transport on both backends', async () => {
  const { evaluateControlObservations } = await import(new URL('../scripts/lib/conformance.mjs', import.meta.url).href)
  const options = { http: true, nonblockingHttpFailure: true }
  assert.equal(evaluateControlObservations(trace(), trace(), options).status, 'passed')
  for (const field of ['sideEffect', 'httpTransportValid', 'httpFailureBodyAbsent']) {
    const wrong = trace(); wrong.controls[0][field] = false
    const result = evaluateControlObservations(wrong, structuredClone(wrong), options)
    assert.equal(result.status, 'failed', field)
    assert.equal(result.comparison.observations.host[0][field], false)
  }
  const leaked = trace(); leaked.controls[0].reasonDelivered = true
  assert.equal(evaluateControlObservations(leaked, leaked, options).status, 'failed')
})

test('HTTP failure bodies cannot leak through separate context, foreign results or provider system content', async () => {
  const { httpFailureBodyAbsent } = await import(new URL('../scripts/lib/conformance-pretool.mjs', import.meta.url).href)
  const marker = 'CONFORMANCE_OWNED_DENIAL_REASON'
  const owned = { role: 'tool', tool_call_id: 'owned', content: 'Executed output' }
  assert.equal(httpFailureBodyAbsent({ messages: [owned] }), true)
  for (const extra of [{ role: 'system', content: marker }, { role: 'user', content: marker }, { role: 'tool', tool_call_id: 'foreign', content: marker }]) assert.equal(httpFailureBodyAbsent({ messages: [owned, extra] }), false)
  assert.equal(httpFailureBodyAbsent({ system: [{ type: 'text', text: marker }], messages: [owned] }), false)
})

test('Codex HTTP source rejection and the HTTP catalog retain the pinned native format boundary', async t => {
  const { loadSources } = await import('../src/config.js')
  const directory = await mkdtemp(join(tmpdir(), 'codex-http-format-')), path = join(directory, 'hooks.json')
  t.after(() => rm(directory, { recursive: true, force: true }))
  await writeFile(path, JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'http', url: 'http://127.0.0.1/hook', timeout: 1 }] }] } }))
  await assert.rejects(loadSources([{ id: 'codex-http', dialect: 'codex', path }]), /SOURCE_HANDLER/)
  const catalog = JSON.parse(await readFile(new URL('../conformance/catalog.json', import.meta.url), 'utf8'))
  const { coverageReport } = await import(new URL('../scripts/lib/conformance.mjs', import.meta.url).href)
  for (const suffix of ['pretooluse.http', 'posttooluse.http', 'pretooluse.http-failures']) {
    assert.ok(!catalog.cases.some((row: any) => row.id === 'codex.' + suffix))
    const report = coverageReport(catalog, [], [{ caseID: 'claude.' + suffix, host: 'v1', nativeVersion: catalog.versions.native['claude-code'], hostVersion: '1.19.5', status: 'passed' }])
    const requirement = report.requirements.find((row: any) => row.id === 'claude-code.' + suffix)
    assert.equal(requirement.targets.v1.status, 'verified')
    assert.equal(requirement.targets.v2.status, 'unverified')
    assert.equal(report.requirements.find((row: any) => row.id === 'claude-code.event.PreToolUse.outputs').targets.v1.status, 'unverified')
  }
})
