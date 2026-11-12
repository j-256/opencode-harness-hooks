import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

const catalog = async () => JSON.parse(await readFile(new URL('../conformance/catalog.json', import.meta.url), 'utf8'))
const library = () => import(new URL('../scripts/lib/conformance.mjs', import.meta.url).href)
const receipt = (dialect: string, status = 'passed') => ({ caseID: `${dialect}.v1.stop-load-rejection`, host: 'v1', nativeVersion: dialect === 'codex' ? '0.167.0' : '2.1.318', hostVersion: '1.19.5', status })

test('Stop exception evidence remains scoped to its dialect and never verifies native Stop', async () => {
  const { coverageReport } = await library()
  const data = await catalog()
  const partial = coverageReport(data, [], [receipt('claude-code')])
  const find = (report: any, dialect: string) => report.requirements.find((row: any) => row.id === `${dialect}.event.Stop.trigger`)
  assert.equal(find(partial, 'claude-code').targets.v1.status, 'exception-verified')
  assert.equal(find(partial, 'codex').targets.v1.status, 'exception-unverified')
  assert.deepEqual(partial.profiles.v1.missingExceptionEvidence, ['v1-stop-load-rejection'])
  const complete = coverageReport(data, [], [receipt('claude-code'), receipt('codex')])
  assert.equal(find(complete, 'codex').targets.v1.status, 'exception-verified')
  assert.equal(find(complete, 'codex').targets.v2.status, 'unverified')
  assert.deepEqual(complete.profiles.v1.missingExceptionEvidence, [])
  assert.ok(!complete.profiles.v1.blockers.includes('codex.event.Stop.trigger'))
  assert.equal(complete.profiles.v1.complete, false)
  assert.equal(complete.nativeConformant, false)
})

test('failed, duplicate or mismatched rejection receipts cannot clear the exception', async () => {
  const { coverageReport } = await library()
  const data = await catalog()
  const failed = coverageReport(data, [], [receipt('claude-code'), receipt('codex', 'failed')])
  assert.equal(failed.requirements.find((row: any) => row.id === 'codex.event.Stop.outputs').targets.v1.status, 'exception-failed')
  assert.deepEqual(failed.profiles.v1.missingExceptionEvidence, ['v1-stop-load-rejection'])
  for (const mutation of [{ host: 'v2' }, { nativeVersion: '2.1.318' }, { hostVersion: 'other' }, { caseID: 'v1.stop-load-rejection' }]) assert.throws(() => coverageReport(data, [], [{ ...receipt('codex'), ...mutation }]), /CONFORMANCE_RUN_INVALID/)
  assert.throws(() => coverageReport(data, [], [receipt('codex'), receipt('codex')]), /CONFORMANCE_RUN_INVALID/)
})

function rejectionReport(dialect = 'codex') {
  return { host: 'v1', hostVersion: '1.19.5', dialect, defaultEntrypoint: true, nativeOptions: true, expectedLoadRejection: true, rejectionReason: 'stop', expectedStopLoadRejection: true, incompatibleConfigsIdentified: true, unsupportedCapabilityIdentified: true, noModelOrHookExecution: true, hostErrorNoticeAccepted: true, equivalent: false }
}

test('Stop probe validation requires every promised observation and strips unrelated output', async () => {
  const { validateStopRejection } = await import(new URL('../scripts/lib/conformance-stop.mjs', import.meta.url).href)
  const report = rejectionReport()
  const result = validateStopRejection({ ...report, privatePayload: 'Must not be returned' }, 'codex', '1.19.5')
  assert.deepEqual(result, report)
  for (const key of Object.keys(report)) {
    const incomplete: any = { ...report }
    delete incomplete[key]
    assert.throws(() => validateStopRejection(incomplete, 'codex', '1.19.5'), /CONFORMANCE_STOP_OBSERVATION_INVALID/, key)
  }
  for (const mutation of [{ dialect: 'claude-code' }, { host: 'v2' }, { noModelOrHookExecution: false }, { expectedStopLoadRejection: false }, { hostErrorNoticeAccepted: false }, { equivalent: true }]) assert.throws(() => validateStopRejection({ ...report, ...mutation }, 'codex', '1.19.5'), /CONFORMANCE_STOP_OBSERVATION_INVALID/)
})

test('an exception case cannot masquerade as ordinary native coverage or another dialect', async () => {
  const { validateCatalog } = await library()
  const data = await catalog()
  for (const mutate of [
    (value: any) => { value.cases.find((row: any) => row.id === 'codex.v1.stop-load-rejection').requirements = ['codex.event.Stop.outputs'] },
    (value: any) => { value.exceptions[0].evidenceCases.codex = 'claude-code.v1.stop-load-rejection' },
    (value: any) => { delete value.exceptions[0].evidenceCases.codex },
  ]) {
    const candidate = structuredClone(data)
    mutate(candidate)
    assert.throws(() => validateCatalog(candidate), /CONFORMANCE_CATALOG_INVALID/)
  }
})

test('a timed-out rejection probe cleans up its host process group', { skip: process.platform === 'win32', timeout: 10000 }, async t => {
  const { mkdtemp, mkdir, writeFile, chmod, rm, access } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join, dirname, basename } = await import('node:path')
  const { setTimeout: delay } = await import('node:timers/promises')
  const { runStopRejection } = await import(new URL('../scripts/lib/conformance-stop.mjs', import.meta.url).href)
  const root = await mkdtemp(join(tmpdir(), 'conformance-stop-timeout-'))
  const pidFile = join(root, 'host.pid'), binary = join(root, 'opencode.cjs')
  t.after(async () => {
    let state
    try { state = JSON.parse(await readFile(pidFile, 'utf8')); process.kill(-state.pid, 'SIGKILL') } catch (error: any) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error }
    if (state?.fixtureTemp && basename(dirname(state.fixtureTemp)).startsWith('harness-package-')) await rm(dirname(state.fixtureTemp), { recursive: true, force: true })
    await rm(root, { recursive: true, force: true })
  })
  await Promise.all([mkdir(join(root, 'dist')), mkdir(join(root, 'scripts'))])
  for (const file of ['package.json', 'package-lock.json']) await writeFile(join(root, file), '{}')
  await writeFile(join(root, 'dist/index.js'), 'export {}')
  await writeFile(join(root, 'scripts/verify-plugin.mjs'), await readFile(new URL('../scripts/verify-plugin.mjs', import.meta.url)))
  await writeFile(binary, '#!' + process.execPath + '\nif(process.argv.includes("--version")){console.log("1.19.5")}else{const fs=require("node:fs");fs.writeFileSync(' + JSON.stringify(pidFile) + ',JSON.stringify({pid:process.pid,fixtureTemp:process.env.TMPDIR,fixtureCreated:fs.existsSync(process.env.TMPDIR)}));process.on("SIGTERM",()=>{});setInterval(()=>{},1000)}\n')
  await chmod(binary, 0o700)
  await assert.rejects(runStopRejection({ catalog: await catalog(), packageRoot: root, dialect: 'codex', opencodeBinary: binary, limits: { durationMs: 1500, graceMs: 50, maxBytes: 65536 } }), /CONFORMANCE_STOP_PROBE_FAILED/)
  const { pid, fixtureTemp, fixtureCreated } = JSON.parse(await readFile(pidFile, 'utf8'))
  assert.equal(fixtureCreated, true)
  let alive = true
  for (let attempt = 0; attempt < 20; attempt++) {
    try { process.kill(pid, 0) } catch (error: any) { if (error.code !== 'ESRCH') throw error; alive = false; break }
    await delay(20)
  }
  assert.equal(alive, false, 'Timed-out probe left its detached host running')
  await assert.rejects(access(fixtureTemp), { code: 'ENOENT' })
})
