import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const script = fileURLToPath(new URL('../scripts/verify-conformance.mjs', import.meta.url))
function invoke(args: string[], env: NodeJS.ProcessEnv = process.env) {
  return new Promise<{ status: number; stdout: string; stderr: string }>(resolve => execFile(process.execPath, [script, ...args], { env, timeout: 10000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => resolve({ status: error ? typeof error.code === 'number' ? error.code : 1 : 0, stdout, stderr })))
}

test('conformance help requires no host, build or external executable', async () => {
  for (const args of [['-h'], ['--help']]) {
    const result = await invoke(args, { PATH: '' })
    assert.equal(result.status, 0)
    assert.equal(result.stderr, '')
    for (const term of ['--case', '--host', '--claude-binary', '--opencode-binary', '--require-complete', 'Exit status', 'loopback', '0.167.0', '2.1.318']) assert.ok(result.stdout.includes(term), term)
  }
})

test('metadata inventory works offline and reports existing evidence without verifying it', async () => {
  const result = await invoke([], { PATH: '' })
  assert.equal(result.status, 0)
  assert.equal(result.stderr, '')
  const report = JSON.parse(result.stdout)
  assert.equal(report.nativeConformant, false)
  assert.equal(report.profiles.v1.complete, false)
  assert.equal(report.profiles.v2.complete, false)
  assert.deepEqual(report.runs, [])
  assert.ok(report.evidence.some((row: any) => row.id === 'codex-output-source-oracle' && row.available))
})

test('the complete-profile gate emits its incomplete report and exits distinctly', async () => {
  for (const args of [['--require-complete'], ['-r']]) {
    const result = await invoke(args, { PATH: '' })
    assert.equal(result.status, 4)
    assert.equal(result.stderr, '')
    assert.ok(JSON.parse(result.stdout).profiles.v1.blockers.length > 0)
  }
})

test('invalid conformance options fail before dependency checks', async () => {
  for (const args of [['--unknown'], ['--case'], ['--case='], ['--case', 'unknown'], ['--host', 'v3'], ['--claude-binary='], ['--case', 'claude.pretooluse.control', '--host', 'v2'], ['--', 'unexpected']]) {
    const result = await invoke(args, { PATH: '' })
    assert.equal(result.status, 2, args.join(' '))
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /CONFORMANCE_USAGE_/)
  }
})

test('only execution mode requires native binaries and missing executables are dependency failures', { skip: process.platform === 'win32' }, async () => {
  const result = await invoke(['-c', 'claude.pretooluse.control', '-C', '/missing/claude', '-o', '/missing/opencode'])
  assert.equal(result.status, 3)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /DEPENDENCY_UNAVAILABLE: claude/)
})

test('equivalent native binary option forms enforce the pinned version', { skip: process.platform === 'win32' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'conformance-version-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const binary = join(root, 'wrong-version.cjs')
  await writeFile(binary, '#!' + process.execPath + '\nif(process.argv[2]!=="--version")process.exit(99);console.log("9.9.9 (Claude Code)")\n')
  await chmod(binary, 0o700)
  for (const args of [['-C', binary], ['-C' + binary], ['--claude-binary', binary], ['--claude-binary=' + binary], ['-rC' + binary]]) {
    const result = await invoke(['--case=claude.pretooluse.control', ...args])
    assert.equal(result.status, 2)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /NATIVE_VERSION_MISMATCH/)
  }
})
