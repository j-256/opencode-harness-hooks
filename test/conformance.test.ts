import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { HOOK_EVENTS, CONTRACT_VERSIONS, HOST_VERSIONS } from '../src/contracts.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const catalog = async () => JSON.parse(await readFile(new URL('../conformance/catalog.json', import.meta.url), 'utf8'))
const library = () => import(new URL('../scripts/lib/conformance.mjs', import.meta.url).href)

test('the independent conformance inventory covers every declared source event and pins both hosts', async () => {
  const { validateCatalog, requirements } = await library()
  const data = await catalog()
  validateCatalog(data)
  assert.deepEqual(data.versions.native, { 'claude-code': CONTRACT_VERSIONS['claude-code'], codex: CONTRACT_VERSIONS.codex })
  assert.deepEqual(data.versions.hosts, HOST_VERSIONS)
  for (const dialect of ['claude-code', 'codex'] as const) assert.deepEqual(new Set(data.events[dialect]), new Set(HOOK_EVENTS[dialect]))
  const rows = requirements(data)
  for (const id of ['claude-code.event.PreToolUse.trigger', 'codex.event.Interrupt.payload', 'claude-code.event.SessionEnd.outputs', 'claude-code.pretooluse.deny', 'codex.execution.background', 'claude-code.sources.trust']) assert.ok(rows.some((row: any) => row.id === id), id)
})

test('existing evidence is available without being mistaken for a fresh differential pass', async () => {
  const { readInventory, coverageReport } = await library()
  const data = await catalog()
  const inventory = await readInventory(data, root)
  assert.ok(inventory.some((row: any) => row.id === 'claude-transcript-reference' && row.available))
  assert.ok(inventory.some((row: any) => row.id === 'codex-output-source-oracle' && row.level === 'source-oracle'))
  const report = coverageReport(data, inventory, [])
  assert.equal(report.profiles.v1.complete, false)
  assert.equal(report.profiles.v2.complete, false)
  assert.equal(report.nativeConformant, false)
  assert.ok(report.requirements.every((row: any) => Object.values(row.targets).every((target: any) => target.status !== 'verified')))
})

test('a passing narrow native differential cannot verify its entire event or another host', async () => {
  const { coverageReport } = await library()
  const data = await catalog()
  const run = { caseID: 'claude.pretooluse.control', host: 'v1', nativeVersion: '2.1.318', hostVersion: '1.19.5', status: 'passed' }
  const report = coverageReport(data, [], [run])
  assert.equal(report.requirements.find((row: any) => row.id === 'claude-code.pretooluse.deny').targets.v1.status, 'verified')
  assert.equal(report.requirements.find((row: any) => row.id === 'claude-code.pretooluse.deny').targets.v2.status, 'unverified')
  assert.equal(report.requirements.find((row: any) => row.id === 'claude-code.event.PreToolUse.payload').targets.v1.status, 'unverified')
  assert.equal(report.profiles.v1.complete, false)
  assert.equal(report.nativeConformant, false)
})

test('wrong native versions, host versions and unavailable case targets cannot promote coverage', async () => {
  const { coverageReport } = await library()
  const data = await catalog()
  const run = { caseID: 'claude.pretooluse.control', host: 'v1', nativeVersion: '2.1.318', hostVersion: '1.19.5', status: 'passed' }
  for (const mutation of [{ nativeVersion: 'other' }, { hostVersion: 'other' }, { host: 'v2' }, { caseID: 'unknown' }]) assert.throws(() => coverageReport(data, [], [{ ...run, ...mutation }]), /CONFORMANCE_RUN_INVALID/)
  const failed = coverageReport(data, [], [{ ...run, status: 'failed' }])
  assert.equal(failed.requirements.find((row: any) => row.id === 'claude-code.pretooluse.deny').targets.v1.status, 'failed')
})

test('V1 Stop is an explicit exception with missing rejection evidence, while V2 Stop remains required', async () => {
  const { coverageReport } = await library()
  const report = coverageReport(await catalog(), [], [])
  const stop = report.requirements.find((row: any) => row.id === 'claude-code.event.Stop.trigger')
  assert.equal(stop.targets.v1.status, 'exception-unverified')
  assert.equal(stop.targets.v2.status, 'unverified')
  assert.equal(report.profiles.v1.complete, false)
  assert.ok(report.profiles.v1.missingExceptionEvidence.includes('v1-stop-load-rejection'))
  assert.equal(report.nativeConformant, false)
})

test('catalog validation rejects duplicate obligations and unsafe or unclassified evidence', async () => {
  const { validateCatalog } = await library()
  const data = await catalog()
  for (const mutate of [
    (value: any) => { value.requirements.push(value.requirements[0]) },
    (value: any) => { value.events.codex.push(value.events.codex[0]) },
    (value: any) => { value.evidence[0].artifacts[0] = '../private.json' },
    (value: any) => { value.evidence[0].artifacts[0] = '/private.json' },
    (value: any) => { value.evidence[0].level = 'verified' },
    (value: any) => { value.cases[0].requirements = ['unknown'] },
  ]) {
    const candidate = structuredClone(data)
    mutate(candidate)
    assert.throws(() => validateCatalog(candidate), /CONFORMANCE_CATALOG_INVALID/)
  }
})

function controlTrace() {
  return { sourceDigest: 'a'.repeat(64), hookDigest: 'b'.repeat(64), controls: [
    { id: 'deny', hookInvocations: 1, event: 'PreToolUse', tool: 'Bash', cwdMatches: true, commandMatches: true, identityValid: true, transcriptExists: true, resultOwned: true, reasonDelivered: true, sideEffect: false, primaryModelCalls: 2 },
    { id: 'allow', hookInvocations: 1, event: 'PreToolUse', tool: 'Bash', cwdMatches: true, commandMatches: true, identityValid: true, transcriptExists: true, resultOwned: true, reasonDelivered: false, sideEffect: true, primaryModelCalls: 2 },
  ] }
}

test('the control comparison accepts matching native behavior and an actually executed allow control', async () => {
  const { compareControlObservations } = await library()
  const result = compareControlObservations(controlTrace(), controlTrace())
  assert.equal(result.match, true)
  assert.ok(result.compared.includes('sideEffect'))
  assert.ok(result.compared.includes('hookInvocations'))
})

test('matching but wrong native and host observations cannot produce a vacuous conformance pass', async () => {
  const { compareControlObservations } = await library()
  for (const mutate of [
    (trace: any) => { trace.controls[0].hookInvocations = 0 },
    (trace: any) => { trace.controls[0].hookInvocations = 2 },
    (trace: any) => { trace.controls[0].reasonDelivered = false },
    (trace: any) => { trace.controls[0].sideEffect = true },
    (trace: any) => { trace.controls[1].sideEffect = false },
    (trace: any) => { trace.controls[1].reasonDelivered = true },
    (trace: any) => { trace.controls[0].commandMatches = false },
    (trace: any) => { trace.controls[0].resultOwned = false },
    (trace: any) => { trace.controls[0].primaryModelCalls = 1 },
    (trace: any) => { trace.controls[0].tool = 'Read' },
    (trace: any) => { trace.controls.reverse() },
  ]) {
    const observation = controlTrace()
    mutate(observation)
    assert.throws(() => compareControlObservations(observation, structuredClone(observation)), /CONFORMANCE_CONTROL_FAILED/)
  }
})

test('comparison rejects source substitutions, absent controls and malformed evidence digests', async () => {
  const { compareControlObservations } = await library()
  const different = controlTrace()
  different.sourceDigest = 'c'.repeat(64)
  assert.throws(() => compareControlObservations(controlTrace(), different), /CONFORMANCE_SOURCE_MISMATCH/)
  for (const mutate of [(value: any) => { value.controls.pop() }, (value: any) => { value.hookDigest = '' }]) {
    const value = controlTrace()
    mutate(value)
    assert.throws(() => compareControlObservations(controlTrace(), value), /CONFORMANCE_OBSERVATION_INVALID/)
  }
})

test('control failures identify the backend, control and observable without disclosing payloads', async () => {
  const { compareControlObservations } = await library()
  const trace = controlTrace()
  trace.controls[0]!.identityValid = false
  assert.throws(() => compareControlObservations(trace, controlTrace()), { message: 'CONFORMANCE_CONTROL_FAILED: native.deny.identityValid' })
})

test('the native hello request is classified separately from model calls and unknown routes', async () => {
  const { providerRoute } = await import(new URL('../scripts/lib/conformance-pretool.mjs', import.meta.url).href)
  assert.equal(providerRoute('/native/api/hello'), 'native-hello')
  assert.equal(providerRoute('/native/v1/messages?beta=true'), 'native-model')
  assert.equal(providerRoute('/native/v1/messages/count_tokens'), 'native-count-tokens')
  assert.equal(providerRoute('/host/v1/chat/completions'), 'host-model')
  assert.equal(providerRoute('/native/unexpected/messages'), undefined)
  assert.equal(providerRoute('/host/unexpected'), undefined)
})

test('adapter provenance changes when a compiled dependency changes even if the entrypoint is unchanged', async t => {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { fingerprintAdapter } = await import(new URL('../scripts/lib/conformance-pretool.mjs', import.meta.url).href)
  const root = await mkdtemp(join(tmpdir(), 'conformance-build-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'dist', 'hosts'), { recursive: true })
  await writeFile(join(root, 'package.json'), '{}')
  await writeFile(join(root, 'package-lock.json'), '{}')
  await writeFile(join(root, 'dist', 'index.js'), 'export {}')
  await writeFile(join(root, 'dist', 'hosts', 'v1.js'), 'const first = true')
  const first = await fingerprintAdapter(root)
  assert.equal(await fingerprintAdapter(root), first)
  await writeFile(join(root, 'dist', 'hosts', 'v1.js'), 'const first = false')
  assert.notEqual(await fingerprintAdapter(root), first)
})

test('evidence through a parent-directory symlink cannot escape the repository inventory', async t => {
  const { mkdtemp, mkdir, writeFile, symlink, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { readInventory } = await library()
  const base = await mkdtemp(join(tmpdir(), 'conformance-inventory-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  const root = join(base, 'repo'), outside = join(base, 'outside')
  await Promise.all([mkdir(root), mkdir(outside)])
  await writeFile(join(outside, 'reference.json'), 'Outside fixture')
  await symlink(outside, join(root, 'linked'), 'junction')
  const data = await catalog()
  data.evidence[0].artifacts = ['linked/reference.json']
  const inventory = await readInventory(data, root)
  const first = inventory.find((row: any) => row.id === data.evidence[0].id)
  assert.equal(first.available, false)
  assert.equal(first.artifacts[0].sha256, undefined)
})

test('host cleanup terminates descendants after the host parent has exited', { skip: process.platform === 'win32', timeout: 10000 }, async t => {
  const { spawn } = await import('node:child_process')
  const { EventEmitter } = await import('node:events')
  const { stopHost } = await import(new URL('../scripts/lib/conformance-pretool.mjs', import.meta.url).href)
  const parentCode = 'require("node:child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"inherit"}).unref()'
  const child = spawn(process.execPath, ['-e', parentCode], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const done = EventEmitter.once(child, 'close')
  t.after(async () => {
    try { process.kill(-child.pid!, 'SIGKILL') } catch (error: any) { if (error.code !== 'ESRCH') throw error }
    await done
  })
  await EventEmitter.once(child, 'exit')
  assert.equal(child.exitCode, 0)
  await stopHost(child, done)
  assert.throws(() => process.kill(-child.pid!, 0), { code: 'ESRCH' })
})
