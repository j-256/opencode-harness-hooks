import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url))
const loader = import.meta.resolve('tsx')
const node = process.versions.bun ? execFileSync('node', ['-p', 'process.execPath'], { encoding: 'utf8', timeout: 5000 }).trim() : process.execPath
const run = promisify(execFile)
function invoke(args: readonly string[], cwd?: string) {
  return new Promise<{ status: number; stdout: string; stderr: string }>(resolve => {
    execFile(node, ['--import', loader, cli, ...args], { cwd, timeout: 5000 }, (error, stdout, stderr) => resolve({ status: error ? typeof error.code === 'number' ? error.code : 1 : 0, stdout, stderr }))
  })
}
const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'"
async function fixture(t: { after: (callback: () => Promise<void>) => void }) {
  const directory = await mkdtemp(join(tmpdir(), 'harness-inspect-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const sentinel = join(directory, 'must-not-execute')
  const command = quote(node) + ' -e ' + quote('require("node:fs").writeFileSync(' + JSON.stringify(sentinel) + ', "executed")')
  const hooks = { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command }, { type: 'command', command }] }], Stop: [{ hooks: [{ type: 'command', command }] }] }
  const claude = JSON.stringify({ unrelated: 'UNRELATED_PRIVATE_VALUE', hooks })
  const codex = JSON.stringify({ hooks })
  const options = { sources: [{ id: 'claude', dialect: 'claude-code', path: 'claude.json', selection: { events: ['PreToolUse'] } }, { id: 'codex', dialect: 'codex', path: 'codex.json' }], reviewedDigests: { codex: createHash('sha256').update(codex).digest('hex') }, permissionMode: 'default' }
  await Promise.all([writeFile(join(directory, 'claude.json'), claude), writeFile(join(directory, 'codex.json'), codex), writeFile(join(directory, '-options.json'), JSON.stringify(options))])
  return { directory, sentinel, command, claude, codex, options, path: join(directory, '-options.json') }
}

test('inspection help documents invocation, input schema and statuses without opening a config', async () => {
  for (const flag of ['-h', '--help']) {
    const result = await invoke([flag])
    assert.equal(result.status, 0)
    assert.equal(result.stderr, '')
    for (const field of ['inspect', '--host', '--directory', 'sources', 'codexConfig', 'reviewedDigests', '--require-equivalent', 'Exit status']) assert.ok(result.stdout.includes(field), field)
  }
})

test('inspection preserves registrations and exclusions without execution, mutation or source text disclosure', async t => {
  const f = await fixture(t)
  const result = await invoke(['inspect', '--host', 'v2', '--directory', f.directory, f.path])
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stderr, '')
  const report = JSON.parse(result.stdout)
  assert.equal(report.host, 'v2')
  assert.equal(report.hostContractVersion, '2.2.5')
  assert.equal(report.installedHostVerified, false)
  assert.equal(report.equivalent, false)
  assert.ok(report.unresolved.includes('migration-parity'))
  assert.ok(report.unresolved.includes('codex-config-layer-state'))
  assert.ok(!report.unresolved.includes('native-handler-deduplication'))
  assert.deepEqual(report.sources.map((source: any) => [source.id, source.reviewed, source.selected.length]), [['claude', false, 2], ['codex', true, 3]])
  assert.deepEqual(report.sources[0].excluded.map((item: any) => item.reason), ['event-excluded'])
  assert.deepEqual(report.sources[1].unwiredEvents, ['Stop'])
  assert.ok(!result.stdout.includes(f.command) && !result.stdout.includes(f.directory) && !result.stdout.includes('UNRELATED_PRIVATE_VALUE'))
  await assert.rejects(access(f.sentinel))
  assert.equal(await readFile(join(f.directory, 'claude.json'), 'utf8'), f.claude)
  assert.equal(await readFile(join(f.directory, 'codex.json'), 'utf8'), f.codex)
})

test('option forms, interleaving, bundles and end-of-options preserve the same inspection', async t => {
  const f = await fixture(t)
  await writeFile(join(f.directory, '--help'), JSON.stringify(f.options))
  const cases = [
    ['inspect', '-Hv1', '-d' + f.directory, f.path],
    ['--host=v1', 'inspect', f.path, '--directory=' + f.directory],
    ['inspect', '-H', 'v1', '-d', f.directory, '--', '-options.json'],
    ['inspect', '-Hv1', '-d', f.directory, '--', '--help'],
  ]
  let expected: unknown
  for (const args of cases) {
    const result = await invoke(args, f.directory)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stderr, '')
    const report = JSON.parse(result.stdout)
    if (expected === undefined) expected = report
    else assert.deepEqual(report, expected)
  }
  const help = await invoke(['-hHv2'])
  assert.equal(help.status, 0)
  assert.match(help.stdout, /Usage:/)
  const required = await invoke(['inspect', '-Hv1', '-d', f.directory, '--require-equivalent', f.path])
  assert.equal(required.status, 4)
  assert.equal(required.stderr, '')
  assert.equal(JSON.parse(required.stdout).equivalent, false)
})

test('invalid usage and file failures have documented statuses and private diagnostics', async t => {
  const f = await fixture(t)
  for (const args of [[], ['inspect'], ['other', '-Hv1', f.path], ['inspect', '-Hv3', f.path], ['inspect', '--host='], ['inspect', '--directory='], ['inspect', '-Hv1', '--unknown', f.path], ['inspect', '-Hv1', f.path, 'extra'], ['inspect', '-H']]) {
    const result = await invoke(args)
    assert.equal(result.status, 2, JSON.stringify(args))
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /^USAGE_/)
  }
  const missing = await invoke(['inspect', '-Hv1', join(f.directory, 'missing-private-path')])
  assert.equal(missing.status, 1)
  assert.equal(missing.stdout, '')
  assert.equal(missing.stderr, 'INSPECT_CONFIG_READ\n')
  for (const content of ['PRIVATE_INVALID_JSON', JSON.stringify({ sources: [], secret: 'PRIVATE_VALUE' }), Buffer.from([0xff])]) {
    await writeFile(f.path, content)
    const result = await invoke(['inspect', '-Hv1', f.path])
    assert.equal(result.status, 2)
    assert.equal(result.stdout, '')
    assert.ok(!result.stderr.includes('PRIVATE') && !result.stderr.includes(f.directory))
  }
})

test('inspection bounds options and rejects pipes without waiting for a writer', async t => {
  const f = await fixture(t)
  await writeFile(f.path, Buffer.alloc(1024 * 1024 + 1, ' '))
  const oversized = await invoke(['inspect', '-Hv1', f.path])
  assert.equal(oversized.status, 2)
  assert.equal(oversized.stdout, '')
  assert.equal(oversized.stderr, 'INSPECT_CONFIG_SIZE\n')
  if (process.platform === 'win32') return
  const pipe = join(f.directory, 'fifo')
  await run('mkfifo', [pipe])
  const configPipe = await invoke(['inspect', '-Hv1', pipe])
  assert.equal(configPipe.status, 1)
  assert.equal(configPipe.stderr, 'INSPECT_CONFIG_READ\n')
  await writeFile(f.path, JSON.stringify({ sources: [{ id: 'pipe', dialect: 'claude-code', path: pipe }] }))
  const sourcePipe = await invoke(['inspect', '-Hv1', f.path])
  assert.equal(sourcePipe.status, 1)
  assert.equal(sourcePipe.stderr, 'SOURCE_READ: pipe\n')
})
