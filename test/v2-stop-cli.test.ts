import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const script = fileURLToPath(new URL('../scripts/verify-v2-stop.mjs', import.meta.url))
const node = process.versions.bun ? execFileSync('node', ['-p', 'process.execPath'], { encoding: 'utf8', timeout: 5000 }).trim() : process.execPath
async function invoke(args: readonly string[], executableScript = script) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(node, [executableScript, ...args], { env: { PATH: '', HOME: '/nonexistent', LANG: 'C' }, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    const timer = setTimeout(() => { child.kill(); reject(new Error('CLI_TIMEOUT')) }, 5000)
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', status => { clearTimeout(timer); resolve({ status, stdout, stderr }) })
  })
}

test('V2 Stop core probe help needs no host executable or project build', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'harness-stop-help-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await mkdir(join(directory, 'scripts'))
  const isolatedScript = join(directory, 'scripts', 'probe.mjs')
  await copyFile(script, isolatedScript)
  for (const flag of ['-h', '--help']) {
    const result = await invoke([flag], isolatedScript)
    assert.equal(result.status, 0)
    assert.match(result.stdout, /^Usage:/)
    assert.ok(result.stdout.includes('--default-root'))
    assert.ok(result.stdout.includes('--history'))
    assert.ok(result.stdout.includes('--cancellation'))
    assert.ok(result.stdout.includes('--cancellation-stage'))
    assert.ok(result.stdout.includes('pending-ack'))
    assert.equal(result.stderr, '')
  }
})

test('V2 Stop core probe rejects invalid arguments before querying dependencies', async () => {
  for (const args of [['--unknown'], ['--binary'], ['--binary='], ['unexpected'], ['--', 'unexpected'], ['--history'], ['--cancellation'], ['--default-root', '--cancellation', '--history'], ['--default-root', '--cancellation-stage', 'after-feedback'], ['--default-root', '--cancellation', '--cancellation-stage', 'unknown'], ['--default-root', '--cancellation', '--cancellation-stage']]) {
    const result = await invoke(args)
    assert.equal(result.status, 2)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /USAGE_/)
  }
})

test('V2 Stop core probe reports missing and mismatched dependencies before starting the host', async () => {
  const missing = await invoke(['-b', '/missing/v2-stop-fixture'])
  assert.equal(missing.status, 3)
  assert.equal(missing.stdout, '')
  assert.match(missing.stderr, /DEPENDENCY_UNAVAILABLE/)
  for (const args of [['--binary=' + node], ['--binary', node], ['-b', node], ['-b' + node], ['--default-root', '-b', node], ['--default-root', '--history', '-b', node], ['--default-root', '--cancellation', '-b', node]]) {
    const mismatched = await invoke(args)
    assert.equal(mismatched.status, 2)
    assert.equal(mismatched.stdout, '')
    assert.match(mismatched.stderr, /HOST_VERSION_MISMATCH/)
  }
})

test('pending acknowledgement cancellation selects the controlled host profile before dependency checks', async () => {
  const result = await invoke(['--default-root', '--cancellation', '--cancellation-stage', 'pending-ack', '-b', '/missing/v2-stop-fixture'])
  assert.equal(result.status, 3)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /DEPENDENCY_UNAVAILABLE/)
})
