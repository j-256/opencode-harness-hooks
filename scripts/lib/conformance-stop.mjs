import { createHash } from 'node:crypto'
import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ConformanceError } from './conformance.mjs'
import { fingerprintAdapter, verifyPinnedVersion } from './conformance-pretool.mjs'
import { runNativeProcess } from './native-process.mjs'

const LIMITS = Object.freeze({ durationMs: 60000, graceMs: 1000, maxBytes: 2 * 1024 * 1024 })
export function validateStopRejection(report, dialect, hostVersion) {
  const expected = { host: 'v1', hostVersion, dialect, defaultEntrypoint: true, nativeOptions: true, expectedLoadRejection: true, rejectionReason: 'stop', expectedStopLoadRejection: true, incompatibleConfigsIdentified: true, unsupportedCapabilityIdentified: true, noModelOrHookExecution: true, hostErrorNoticeAccepted: true, equivalent: false }
  if (!['claude-code', 'codex'].includes(dialect) || !report || Object.entries(expected).some(([key, value]) => report[key] !== value)) throw new ConformanceError('CONFORMANCE_STOP_OBSERVATION_INVALID')
  return expected
}

export async function runStopRejection({ catalog, packageRoot, dialect, opencodeBinary, limits = LIMITS }) {
  if (process.platform === 'win32') throw new ConformanceError('PLATFORM_UNAVAILABLE: POSIX process groups', 2)
  const hostVersion = await verifyPinnedVersion(opencodeBinary, 'opencode', catalog.versions.hosts.v1)
  try { await access(join(packageRoot, 'dist/index.js')) } catch { throw new ConformanceError('DEPENDENCY_UNAVAILABLE: built adapter', 3) }
  const environment = { PATH: process.env.PATH, LANG: 'C', HARNESS_PROBE_INHERIT_PROCESS_GROUP: '1' }
  try { await runNativeProcess('git', ['--version'], '', packageRoot, environment) } catch (error) { throw new ConformanceError('DEPENDENCY_UNAVAILABLE: git', ['ENOENT', 'EACCES'].includes(error.systemCode) ? 3 : 1) }
  const adapterBuildSha256 = await fingerprintAdapter(packageRoot)
  const probe = join(packageRoot, 'scripts/verify-plugin.mjs')
  const probeSha256 = createHash('sha256').update(await readFile(probe)).digest('hex')
  let execution
  try { execution = await runNativeProcess(process.execPath, [probe, '--host', 'v1', '--dialect', dialect, '--binary', opencodeBinary, '--stop-rejection'], '', packageRoot, environment, limits) }
  catch { throw new ConformanceError('CONFORMANCE_STOP_PROBE_FAILED') }
  let comparison
  try { comparison = validateStopRejection(JSON.parse(execution.stdout), dialect, hostVersion) }
  catch { throw new ConformanceError('CONFORMANCE_STOP_OBSERVATION_INVALID') }
  if (await fingerprintAdapter(packageRoot) !== adapterBuildSha256 || createHash('sha256').update(await readFile(probe)).digest('hex') !== probeSha256) throw new ConformanceError('CONFORMANCE_BUILD_CHANGED')
  return { caseID: `${dialect}.v1.stop-load-rejection`, host: 'v1', nativeVersion: catalog.versions.native[dialect], hostVersion, status: 'passed', kind: 'exception', nativeExecution: false, platform: process.platform, architecture: process.arch, adapterBuildSha256, probeSha256, comparison, limits: ['Expected V1 incompatibility, not native Stop parity', 'Native version identifies the pinned contract; no native binary is required or executed'] }
}
