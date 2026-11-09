import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const script = fileURLToPath(new URL('../scripts/verify-native-stop.mjs', import.meta.url))
const node = process.versions.bun ? execFileSync('node', ['-p', 'process.execPath'], { encoding: 'utf8', timeout: 5000 }).trim() : process.execPath
function invoke(args: readonly string[], env: NodeJS.ProcessEnv = process.env) {
  return new Promise<{ status: number; stdout: string; stderr: string }>(resolve => {
    execFile(node, [script, ...args], { env, timeout: 5000 }, (error, stdout, stderr) => resolve({ status: error ? typeof error.code === 'number' ? error.code : 1 : 0, stdout, stderr }))
  })
}

test('native Stop help documents both harnesses without binaries, dependencies or a package build', async () => {
  for (const flag of ['-h', '--help']) {
    const result = await invoke([flag], { PATH: '' })
    assert.equal(result.status, 0)
    for (const value of ['--dialect', '--binary', 'claude-code', 'codex', '2.1.318', '0.167.0', 'Exit status', 'trust']) assert.ok(result.stdout.includes(value), value)
    assert.equal(result.stderr, '')
  }
})

test('native Stop invalid options and values fail before dependency checks', async () => {
  for (const args of [['--unknown'], ['-b'], ['--binary='], ['-d'], ['--dialect=other'], ['--', 'unexpected']]) {
    const result = await invoke(args, { PATH: '' })
    assert.equal(result.status, 2, String(args))
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /USAGE_/)
  }
})

test('native Stop dialect, aggregation and binary argument forms reject the wrong executable version', async () => {
  for (const args of [['-dclaude-code', '-b', node], ['--dialect=codex', '--binary=' + node], ['-dcodex', '-b' + node], ['--dialect', 'claude-code', '--binary', node], ['--aggregation', '-dclaude-code', '-b', node], ['--aggregation', '-dcodex', '-b', node]]) {
    const result = await invoke(args)
    assert.equal(result.status, 2)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /NATIVE_VERSION_MISMATCH/)
  }
})

test('native Stop selects the correct environment binary and identifies missing dependencies', async () => {
  for (const [dialect, key] of [['claude-code', 'CLAUDE_BINARY'], ['codex', 'CODEX_BINARY']] as const) {
    const result = await invoke(['--dialect', dialect], { PATH: '', [key]: '/missing/native-stop-fixture' })
    assert.equal(result.status, 3)
    assert.equal(result.stdout, '')
    assert.equal(result.stderr, 'DEPENDENCY_UNAVAILABLE: ' + dialect + '\n')
  }
})
