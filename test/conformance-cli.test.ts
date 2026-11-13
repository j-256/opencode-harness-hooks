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

test('repeatable cases reject duplicates and wrong targets before running either case', async () => {
  for (const args of [
    ['-c', 'claude.pretooluse.control', '-c', 'claude.pretooluse.control'],
    ['-c', 'codex.pretooluse.control', '-c', 'unknown'],
    ['-c', 'codex.v1.stop-load-rejection', '-H', 'v2'],
  ]) {
    const result = await invoke(args, { PATH: '' })
    assert.equal(result.status, 2)
    assert.match(result.stderr, /CONFORMANCE_USAGE_/)
  }
})

test('Codex and Stop cases check only their conditional binaries', { skip: process.platform === 'win32' }, async () => {
  const codex = await invoke(['-c', 'codex.pretooluse.control', '-X', '/missing/codex', '-C', '/missing/claude'])
  assert.equal(codex.status, 3)
  assert.equal(codex.stdout, '')
  assert.match(codex.stderr, /DEPENDENCY_UNAVAILABLE: codex/)
  const stop = await invoke(['-c', 'codex.v1.stop-load-rejection', '-o', '/missing/opencode', '-X', '/missing/codex', '-C', '/missing/claude'])
  assert.equal(stop.status, 3)
  assert.equal(stop.stdout, '')
  assert.match(stop.stderr, /DEPENDENCY_UNAVAILABLE: opencode/)
})

test('Codex binary option forms enforce the pinned native version', { skip: process.platform === 'win32' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'conformance-codex-version-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const binary = join(root, 'wrong-version.cjs')
  await writeFile(binary, '#!' + process.execPath + '\nif(process.argv[2]!=="--version")process.exit(99);console.log("codex-cli 9.9.9")\n')
  await chmod(binary, 0o700)
  for (const args of [['-X', binary], ['-X' + binary], ['--codex-binary', binary], ['--codex-binary=' + binary], ['-rX' + binary]]) {
    const result = await invoke(['-c', 'codex.pretooluse.control', ...args])
    assert.equal(result.status, 2)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /NATIVE_VERSION_MISMATCH/)
  }
})

test('input-rewrite cases appear in help and check only their own conditional native binary', { skip: process.platform === 'win32' }, async () => {
  const help = await invoke(['--help'], { PATH: '' })
  for (const prefix of ['claude', 'codex']) {
    const name = prefix + '.pretooluse.input-rewrite'
    assert.ok(help.stdout.includes(name), name)
    const result = await invoke(['-c', name, '-C', '/missing/claude', '-X', '/missing/codex'])
    assert.equal(result.status, 3)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, new RegExp('DEPENDENCY_UNAVAILABLE: ' + prefix))
    const wrongHost = await invoke(['-c', name, '-H', 'v2'], { PATH: '' })
    assert.equal(wrongHost.status, 2)
    assert.match(wrongHost.stderr, /CONFORMANCE_USAGE_CASE/)
  }
})

test('post-tool cases document conditional binaries and reject unsupported hosts', { skip: process.platform === 'win32' }, async () => {
  const help = await invoke(['--help'], { PATH: '' })
  for (const prefix of ['claude', 'codex']) {
    for (const suffix of ['.posttooluse.effects', '.tool-failures', ...(prefix === 'claude' ? ['.pretooluse.http', '.posttooluse.http', '.pretooluse.http-failures'] : [])]) {
      const name = prefix + suffix
      assert.ok(help.stdout.includes(name + ','))
      const result = await invoke(['-c', name, '-C', '/missing/claude', '-X', '/missing/codex'])
      assert.equal(result.status, 3); assert.equal(result.stdout, '')
      assert.match(result.stderr, new RegExp('DEPENDENCY_UNAVAILABLE: ' + prefix))
      const unsupported = await invoke(['-c', name, '-H', 'v2'], { PATH: '' })
      assert.equal(unsupported.status, 2); assert.match(unsupported.stderr, /CONFORMANCE_USAGE_CASE/)
    }
  }
})

test('HTTP cases do not advertise or execute unsupported Codex handler configurations', async () => {
  const help = await invoke(['--help'], { PATH: '' })
  for (const suffix of ['pretooluse.http', 'posttooluse.http', 'pretooluse.http-failures']) {
    assert.equal(help.stdout.includes('codex.' + suffix), false)
    const result = await invoke(['--case', 'codex.' + suffix], { PATH: '' })
    assert.equal(result.status, 2)
    assert.match(result.stderr, /CONFORMANCE_USAGE_CASE/)
  }
})
