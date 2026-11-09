import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const script = fileURLToPath(new URL('../scripts/verify-package.mjs', import.meta.url))
const node = process.versions.bun ? execFileSync('node', ['-p', 'process.execPath'], { encoding: 'utf8', timeout: 5000 }).trim() : process.execPath
function invoke(args: readonly string[], cwd?: string, target = script) {
  return new Promise<{ status: number; stdout: string; stderr: string }>(resolve => {
    execFile(node, [target, ...args], { cwd, timeout: 5000 }, (error, stdout, stderr) => resolve({ status: error ? typeof error.code === 'number' ? error.code : 1 : 0, stdout, stderr }))
  })
}
test('artifact probe help, options and dependency failures preserve its CLI contract', async () => {
  for (const flag of ['-h', '--help', '-hp/missing/npm']) {
    const result = await invoke([flag])
    assert.equal(result.status, 0)
    assert.equal(result.stderr, '')
    for (const field of ['--npm', 'npm run build', 'registry.npmjs.org', 'Exit status']) assert.ok(result.stdout.includes(field), field)
  }
  for (const args of [['--unknown'], ['-p'], ['--npm='], ['--', 'unexpected']]) {
    const result = await invoke(args)
    assert.equal(result.status, 2)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /USAGE_/)
  }
  for (const args of [['-p', '/missing/npm'], ['-p/missing/npm'], ['--npm=/missing/npm'], ['--npm', '/missing/npm']]) {
    const result = await invoke(args)
    assert.equal(result.status, 3)
    assert.equal(result.stdout, '')
    assert.equal(result.stderr, 'DEPENDENCY_UNAVAILABLE: npm\n')
  }
})

test('a relative npm executable keeps its invocation-directory meaning after the probe changes directory', async t => {
  if (process.platform === 'win32') return
  const root = await mkdtemp(join(tmpdir(), 'harness-package-cli-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const launch = join(root, 'launch')
  await Promise.all([mkdir(join(root, 'scripts')), mkdir(join(root, 'dist')), mkdir(launch)])
  const target = join(root, 'scripts/verify-package.mjs')
  await copyFile(script, target)
  await writeFile(join(root, 'dist/cli.js'), '')
  const marker = join(root, 'pack-called')
  await writeFile(join(launch, 'fixture'), '#!/bin/sh\nif [ "$1" = "--version" ]; then printf "fixture\\n"; exit 0; fi\nprintf "pack" > ' + "'" + marker.replaceAll("'", "'\"'\"'") + "'" + '\nexit 1\n', { mode: 0o700 })
  const result = await invoke(['--npm', './fixture'], launch, target)
  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, 'PACKAGE_CHECK_FAILED: pack\n')
  assert.equal(await readFile(marker, 'utf8'), 'pack')
})
