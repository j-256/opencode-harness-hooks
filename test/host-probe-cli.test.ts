import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFile } from 'node:child_process'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('../scripts/verify-v2.mjs', import.meta.url))
function invoke(args: readonly string[], env: NodeJS.ProcessEnv = process.env) {
  return new Promise<{ status: number; stdout: string; stderr: string }>(resolve => {
    execFile(process.execPath, [script, ...args], { env, timeout: 5000 }, (error, stdout, stderr) => resolve({ status: error ? typeof error.code === 'number' ? error.code : 1 : 0, stdout, stderr }))
  })
}

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
