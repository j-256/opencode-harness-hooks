import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFile, execFileSync } from 'node:child_process'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('../scripts/verify-v2.mjs', import.meta.url))
const packageProbe = fileURLToPath(new URL('../scripts/verify-plugin.mjs', import.meta.url))
const transcriptProbe = fileURLToPath(new URL('../scripts/verify-claude-transcript.mjs', import.meta.url))
const lifecycleProbe = fileURLToPath(new URL('../scripts/verify-claude-lifecycle.mjs', import.meta.url))
// The probes require Node even when the library tests run in Bun
const node = process.versions.bun ? execFileSync('node', ['-p', 'process.execPath'], { encoding: 'utf8', timeout: 5000 }).trim() : process.execPath
function invoke(args: readonly string[], env: NodeJS.ProcessEnv = process.env, target = script) {
  return new Promise<{ status: number; stdout: string; stderr: string }>(resolve => {
    execFile(node, [target, ...args], { env, timeout: 5000 }, (error, stdout, stderr) => resolve({ status: error ? typeof error.code === 'number' ? error.code : 1 : 0, stdout, stderr }))
  })
}

test('Claude lifecycle oracle help and preconditions require no live configuration or model account', async () => {
  for (const flag of ['-h', '--help']) {
    const result = await invoke([flag], { PATH: '' }, lifecycleProbe)
    assert.equal(result.status, 0)
    assert.match(result.stdout, /SessionStart/)
    assert.match(result.stdout, /environment/)
    assert.match(result.stdout, /--resume-mode/)
    assert.match(result.stdout, /2\.1\.318/)
    assert.equal(result.stderr, '')
  }
  for (const args of [['--unknown'], ['-b'], ['--binary='], ['--resume-mode=other'], ['-r'], ['--', 'unexpected']]) {
    const result = await invoke(args, process.env, lifecycleProbe)
    assert.equal(result.status, 2)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /USAGE_/)
  }
  for (const args of [['-b', node], ['-b' + node], ['--binary=' + node], ['-rid', '-b', node], ['--resume-mode=path', '-b', node]]) {
    const result = await invoke(args, process.env, lifecycleProbe)
    assert.equal(result.status, 2)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /NATIVE_VERSION_MISMATCH/)
  }
  const missing = await invoke([], { PATH: '', CLAUDE_BINARY: '/missing/lifecycle-claude' }, lifecycleProbe)
  assert.equal(missing.status, 3)
  assert.equal(missing.stdout, '')
  assert.equal(missing.stderr, 'DEPENDENCY_UNAVAILABLE: Claude Code\n')
})

test('Claude transcript oracle help, arguments and dependency failures preserve its CLI contract', async () => {
  for (const flag of ['-h', '--help']) {
    const result = await invoke([flag], { PATH: '' }, transcriptProbe)
    assert.equal(result.status, 0)
    assert.match(result.stdout, /2\.1\.318/)
    assert.match(result.stdout, /--binary/)
    assert.match(result.stdout, /Exit status/)
    assert.match(result.stdout, /4 required native reader fidelity differs/)
    assert.equal(result.stderr, '')
  }
  for (const args of [['--unknown'], ['-b'], ['--binary='], ['--', 'unexpected']]) {
    const result = await invoke(args, process.env, transcriptProbe)
    assert.equal(result.status, 2)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /USAGE_/)
  }
  for (const args of [['-b', node], ['-b' + node], ['--binary=' + node]]) {
    const result = await invoke(args, process.env, transcriptProbe)
    assert.equal(result.status, 2)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /NATIVE_VERSION_MISMATCH/)
  }
  const missing = await invoke([], { PATH: '', CLAUDE_BINARY: '/missing/harness-claude' }, transcriptProbe)
  assert.equal(missing.status, 3)
  assert.equal(missing.stdout, '')
  assert.equal(missing.stderr, 'DEPENDENCY_UNAVAILABLE: Claude Code\n')
})

test('both help forms work without Git or an OpenCode executable', async () => {
  for (const flag of ['-h', '--help']) {
    const result = await invoke([flag], { PATH: '', OPENCODE_V2_BINARY: '/missing/executable' })
    assert.equal(result.status, 0)
    assert.match(result.stdout, /2\.2\.5/)
    assert.match(result.stdout, /--binary/)
    assert.match(result.stdout, /Exit status/)
    assert.equal(result.stderr, '')
  }
})

test('package probe help and invalid host/options require no executable and preserve output channels', async () => {
  for (const flag of ['-h', '--help']) {
    const result = await invoke([flag], { PATH: '' }, packageProbe)
    assert.equal(result.status, 0)
    assert.match(result.stdout, /--host v1\|v2/)
    assert.match(result.stdout, /1\.19\.5/)
    assert.match(result.stdout, /2\.2\.5/)
    assert.match(result.stdout, /--dialect/)
    assert.match(result.stdout, /mixed/)
    assert.match(result.stdout, /--preapproval/)
    assert.match(result.stdout, /--prompts/)
    assert.equal(result.stderr, '')
  }
  for (const args of [[], ['--host'], ['--host', 'v3'], ['--host', 'constructor'], ['--unknown'], ['--host=v1', '--binary='], ['--host=v1', '--dialect=other'], ['--host=v1', '--preapproval'], ['--host=v2', '--dialect=codex', '--preapproval'], ['--', 'v1']]) {
    const result = await invoke(args, process.env, packageProbe)
    assert.equal(result.status, 2, String(args))
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /USAGE_/)
  }
})

test('package probe honors literal binary forms and the selected host environment', async () => {
  for (const args of [['--host=v1', '-b', process.execPath], ['--host', 'v2', '-b' + process.execPath], ['--host=v1', '--binary=' + process.execPath], ['--host=v2', '--dialect=claude-code', '-b', process.execPath], ['--host=v1', '--dialect=mixed', '-b', process.execPath], ['--host=v1', '--dialect=claude-code', '--preapproval', '-b', process.execPath], ['--host=v2', '--dialect=mixed', '--preapproval', '-b', process.execPath]]) {
    const result = await invoke(args, process.env, packageProbe)
    assert.equal(result.status, 2)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /HOST_VERSION_MISMATCH/)
  }
  const result = await invoke(['--host=v1'], { ...process.env, OPENCODE_V1_BINARY: '/missing/harness-fixture' }, packageProbe)
  assert.equal(result.status, 3)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, 'DEPENDENCY_UNAVAILABLE: OpenCode\n')
})

test('invalid options and missing or empty binary arguments are usage errors', async () => {
  for (const args of [['--unknown'], ['-b'], ['--binary'], ['--binary='], ['--', 'unexpected'], ['unexpected', '--help']]) {
    const result = await invoke(args)
    assert.equal(result.status, 2, String(args))
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /USAGE_/)
  }
})

test('binary option forms use literal execution and reject a different runtime before starting a server', async () => {
  for (const args of [['-b', process.execPath], [`-b${process.execPath}`], ['--binary', process.execPath], [`--binary=${process.execPath}`]]) {
    const result = await invoke(args)
    assert.equal(result.status, 2)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /HOST_VERSION_MISMATCH/)
  }
  const missing = await invoke(['-b', '/missing/harness-test-executable'])
  assert.equal(missing.status, 3)
  assert.equal(missing.stdout, '')
  assert.equal(missing.stderr, 'DEPENDENCY_UNAVAILABLE: OpenCode\n')
})

test('the configured environment binary is honored and Git is a conditional dependency of execution', async t => {
  const root = await mkdtemp(join(tmpdir(), 'harness-host-cli-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const binary = join(root, 'fixture')
  await writeFile(binary, '#!/bin/sh\nprintf "opencode v2.2.5\\n"\n', { mode: 0o700 })
  const result = await invoke([], { PATH: '', OPENCODE_V2_BINARY: binary })
  assert.equal(result.status, 3)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, 'DEPENDENCY_UNAVAILABLE: Git\n')
  const failedHost = await invoke(['--binary', binary])
  assert.equal(failedHost.status, 1)
  assert.equal(failedHost.stdout, '')
  assert.equal(failedHost.stderr, 'HOST_EXITED_BEFORE_READY\n')
})
