import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const script = fileURLToPath(new URL('../scripts/verify-codex-sources.mjs', import.meta.url))
const node = process.versions.bun ? execFileSync('node', ['-p', 'process.execPath'], { encoding: 'utf8', timeout: 5000 }).trim() : process.execPath
function invoke(args: readonly string[], env: NodeJS.ProcessEnv = process.env, timeout = 5000) {
  return new Promise<{ status: number; stdout: string; stderr: string }>(resolve => {
    execFile(node, [script, ...args], { env, timeout }, (error, stdout, stderr) => resolve({ status: error ? typeof error.code === 'number' ? error.code : 1 : 0, stdout, stderr }))
  })
}

test('native Codex source help requires no executable, dependencies or build', async () => {
  for (const flag of ['-h', '--help']) {
    const result = await invoke([flag], { PATH: '' })
    assert.equal(result.status, 0)
    for (const text of ['--binary', 'CODEX_BINARY', '0.167.0', 'hooks/list', 'Exit status', 'config.toml', 'hooks.json']) assert.ok(result.stdout.includes(text), text)
    assert.equal(result.stderr, '')
  }
})

test('native Codex source options fail before dependency checks', async () => {
  for (const args of [['--unknown'], ['-b'], ['--binary='], ['--binary', ' '], ['--', 'unexpected']]) {
    const result = await invoke(args, { PATH: '' })
    assert.equal(result.status, 2)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /USAGE_/)
  }
})

test('native Codex source binary argument forms enforce the pinned version', async () => {
  for (const args of [['-b', node], ['-b' + node], ['--binary', node], ['--binary=' + node]]) {
    const result = await invoke(args)
    assert.equal(result.status, 2)
    assert.equal(result.stdout, '')
    assert.equal(result.stderr, 'NATIVE_VERSION_MISMATCH\n')
  }
})

test('native Codex source default environment binary reports a missing dependency distinctly', async () => {
  const result = await invoke([], { PATH: '', CODEX_BINARY: '/missing/codex-source-reference' })
  assert.equal(result.status, 3)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, 'DEPENDENCY_UNAVAILABLE: codex\n')
})

test('native Codex version timeout escalates and removes uncooperative descendants without leaking output', { timeout: 15000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'harness-version-timeout-')), binary = join(root, 'fake.cjs'), pids = join(root, 'pids.jsonl')
  t.after(async () => {
    try { for (const pid of (await readFile(pids, 'utf8')).trim().split('\n').map(Number)) try { process.kill(pid, 'SIGKILL') } catch {} } catch {}
    await rm(root, { recursive: true, force: true })
  })
  const child = `const fs=require('node:fs');process.on('SIGTERM',()=>{});fs.appendFileSync(${JSON.stringify(pids)},process.pid+'\\n');setInterval(()=>{},1000)`
  await writeFile(binary, `#!/usr/bin/env node\nconst fs=require('node:fs');process.on('SIGTERM',()=>{});fs.appendFileSync(${JSON.stringify(pids)},process.pid+'\\n');require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:'inherit'});process.stdout.write('PRIVATE_VERSION_OUTPUT');setInterval(()=>{},1000)\n`)
  await chmod(binary, 0o700)
  const result = await invoke(['-b', binary], process.env, 12000)
  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, 'DEPENDENCY_QUERY_FAILED: codex\n')
  const owned = (await readFile(pids, 'utf8')).trim().split('\n').map(Number)
  assert.equal(owned.length, 2)
  for (const pid of owned) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
})
