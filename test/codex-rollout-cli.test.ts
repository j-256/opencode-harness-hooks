import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { chmod, cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const script = fileURLToPath(new URL('../scripts/verify-codex-rollout.mjs', import.meta.url))
const CLI_TIMEOUT_MS = 5000
const node = process.versions.bun ? execFileSync('node', ['-p', 'process.execPath'], { encoding: 'utf8', timeout: CLI_TIMEOUT_MS }).trim() : process.execPath
function invoke(args: readonly string[], env: NodeJS.ProcessEnv = process.env) {
  return new Promise<{ status: number; stdout: string; stderr: string }>(resolve => execFile(node, [script, ...args], { env, timeout: CLI_TIMEOUT_MS }, (error, stdout, stderr) => resolve({ status: error ? typeof error.code === 'number' ? error.code : 1 : 0, stdout, stderr })))
}
test('Codex rollout reference help requires no binary or build and declares its integration boundary', async () => {
  for (const flag of ['-h', '--help']) {
    const result = await invoke([flag], { PATH: '' })
    assert.equal(result.status, 0)
    assert.equal(result.stderr, '')
    for (const value of ['--binary', 'CODEX_BINARY', '0.167.0', 'npm run build', 'thread/read', 'Exit status', 'trust', 'default']) assert.ok(result.stdout.includes(value), value)
  }
})
test('Codex rollout reference validates options, dependencies and version without native execution', async () => {
  for (const args of [['--unknown'], ['-b'], ['--binary='], ['--binary', ' '], ['--', 'unexpected']]) assert.equal((await invoke(args, { PATH: '' })).status, 2)
  const missing = await invoke([], { PATH: '', CODEX_BINARY: '/missing/codex-rollout-reference' })
  assert.equal(missing.status, 3)
  assert.equal(missing.stdout, '')
  assert.equal(missing.stderr, 'DEPENDENCY_UNAVAILABLE: codex\n')
  for (const args of [['-b', node], ['-b' + node], ['--binary', node], ['--binary=' + node]]) {
    const wrong = await invoke(args)
    assert.equal(wrong.status, 2)
    assert.equal(wrong.stdout, '')
    assert.equal(wrong.stderr, 'NATIVE_VERSION_MISMATCH\n')
  }
})

test('Codex rollout reference reports its missing build before native inventory or hooks run', async t => {
  const root = await mkdtemp(join(tmpdir(), 'harness-rollout-cli-build-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'scripts'))
  await cp(script, join(root, 'scripts', 'verify-codex-rollout.mjs'))
  await cp(new URL('../scripts/lib', import.meta.url), join(root, 'scripts', 'lib'), { recursive: true })
  const binary = join(root, 'version-only.cjs')
  await writeFile(binary, '#!' + node + '\nif(process.argv[2]!=="--version")process.exit(99);console.log("codex-cli 0.167.0")\n')
  await chmod(binary, 0o700)
  const result = await new Promise<{ status: number; stdout: string; stderr: string }>(resolve => execFile(node, [join(root, 'scripts', 'verify-codex-rollout.mjs'), '-b', binary], { timeout: CLI_TIMEOUT_MS }, (error, stdout, stderr) => resolve({ status: error ? typeof error.code === 'number' ? error.code : 1 : 0, stdout, stderr })))
  assert.equal(result.status, 3)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, 'DEPENDENCY_UNAVAILABLE: built adapter\n')
})
