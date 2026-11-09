import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, link, lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { promisify } from 'node:util'
import type { NativeEvent, Registration } from '../src/types.js'

const execute = promisify(execFile)
const DIGEST = 'a'.repeat(64)

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'harness-environment-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return { root, directory: join(root, 'state') }
}

function registrations(command = ':'): Registration[] {
  return [0, 1].map(handlerIndex => ({ id: `source:SessionStart:0:${handlerIndex}`, sourceID: 'source', sourceDigest: DIGEST, dialect: 'claude-code', event: 'SessionStart', groupIndex: 0, handlerIndex, handler: { type: 'command', command } }))
}

function startup(cwd: string): NativeEvent {
  return { event: 'SessionStart', sessionID: 'session', cwd, data: { source: 'startup', transcript_path: '/artifacts/transcript.jsonl' } }
}

test('reserves absent independent files in configured order and executes unchanged duplicate hooks', async t => {
  const { ClaudeEnvironmentFiles } = await import('../src/claude-environment-files.js')
  const { dispatchEvent } = await import('../src/engine.js')
  const { root, directory } = await fixture(t)
  const hook = join(root, 'write.cjs')
  await writeFile(hook, `require('node:fs').appendFileSync(process.env.CLAUDE_ENV_FILE,'export SESSION_VALUE=value\\n')`)
  const selected = registrations(`"${process.execPath}" "${hook}"`)
  const files = await new ClaudeEnvironmentFiles({ directory }).prepare('session', selected)
  assert.deepEqual(files.files.map(file => file.registrationID), ['source:SessionStart:0:0', 'source:SessionStart:0:1'])
  assert.equal(new Set(files.files.map(file => file.path)).size, 2)
  for (const file of files.files) {
    await assert.rejects(lstat(file.path), { code: 'ENOENT' })
    assert.equal((await lstat(dirname(file.path))).mode & 0o777, 0o700)
  }
  const sources = [{ id: 'source', dialect: 'claude-code' as const, digest: DIGEST, path: '/fixtures/hooks.json', enabled: true, excluded: [], registrations: selected }]
  const result = await dispatchEvent(sources, startup(root), { environment: {}, projectRoot: root, registrationContext: files.registrationContext })
  assert.deepEqual(result.entries.map(entry => entry.result.status), ['success', 'success'])
  for (const file of files.files) assert.equal(await readFile(file.path, 'utf8'), 'export SESSION_VALUE=value\n')
  assert.equal(JSON.stringify(result.diagnostic).includes(directory), false)
  assert.ok(Object.isFrozen(files) && Object.isFrozen(files.files) && Object.isFrozen(files.files[0]) && Object.isFrozen(files.registrationContext))
})

test('a fresh process recovers the same session paths and preserves appended native shell code', async t => {
  const { ClaudeEnvironmentFiles } = await import('../src/claude-environment-files.js')
  const { root, directory } = await fixture(t)
  const selected = registrations()
  const first = await new ClaudeEnvironmentFiles({ directory }).prepare('session', selected)
  await writeFile(first.files[0]!.path, 'fixture() { printf startup; }\n')
  const module = new URL('../src/claude-environment-files.ts', import.meta.url).href
  const code = `import {ClaudeEnvironmentFiles} from ${JSON.stringify(module)};import{appendFile}from'node:fs/promises';const input=JSON.parse(process.argv[1]);const files=await new ClaudeEnvironmentFiles({directory:input.directory}).prepare('session',input.registrations);await appendFile(files.files[0].path,'export RESUMED=yes\\n');process.stdout.write(JSON.stringify(files));`
  const child = await execute(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code, JSON.stringify({ directory, registrations: selected })], { timeout: 10_000, maxBuffer: 64 * 1024 })
  assert.equal(child.stderr, '')
  assert.equal(child.stdout, JSON.stringify(first))
  assert.equal(await readFile(first.files[0]!.path, 'utf8'), 'fixture() { printf startup; }\nexport RESUMED=yes\n')
  const other = await new ClaudeEnvironmentFiles({ directory }).prepare('../other-session', selected)
  assert.notEqual(dirname(other.files[0]!.path), dirname(first.files[0]!.path))
  assert.equal(dirname(dirname(other.files[0]!.path)), directory)
  assert.equal((await lstat(directory)).mode & 0o777, 0o700)
  assert.deepEqual((await readdir(root)).sort(), ['state'])
})

test('concurrent reservations cannot replace a different source revision or configured order', async t => {
  const { ClaudeEnvironmentFiles } = await import('../src/claude-environment-files.js')
  const { directory } = await fixture(t)
  const selected = registrations()
  const stores = [new ClaudeEnvironmentFiles({ directory }), new ClaudeEnvironmentFiles({ directory })]
  const concurrent = await Promise.all(stores.map(store => store.prepare('session', selected)))
  assert.deepEqual(concurrent[0], concurrent[1])
  for (const changed of [selected.toReversed(), selected.map(row => ({ ...row, sourceDigest: 'b'.repeat(64) }))]) {
    await assert.rejects(stores[0]!.prepare('session', changed), { code: 'ENVIRONMENT_LAYOUT_UNSUPPORTED' })
  }
  assert.deepEqual(await stores[1]!.prepare('session', selected), concurrent[0])
  const competing = [selected, selected.map(row => ({ ...row, sourceDigest: 'c'.repeat(64) }))]
  const race = await Promise.allSettled(stores.map((store, index) => store.prepare('racing-session', competing[index]!)))
  assert.equal(race.filter(row => row.status === 'fulfilled').length, 1)
  const rejected = race.find(row => row.status === 'rejected')
  assert.ok(rejected?.status === 'rejected')
  assert.equal((rejected.reason as { code: string }).code, 'ENVIRONMENT_LAYOUT_UNSUPPORTED')
  const winner = race.findIndex(row => row.status === 'fulfilled')
  assert.deepEqual(await stores[0]!.prepare('racing-session', competing[winner]!), (race[winner] as PromiseFulfilledResult<unknown>).value)
})

test('rejects unsafe directories and hook-created file aliases without following them', async t => {
  const { ClaudeEnvironmentFiles } = await import('../src/claude-environment-files.js')
  const { root, directory } = await fixture(t)
  const selected = registrations()
  const files = await new ClaudeEnvironmentFiles({ directory }).prepare('session', selected)
  const foreign = join(root, 'foreign')
  await writeFile(foreign, 'PRIVATE_FOREIGN_VALUE')
  await symlink(foreign, files.files[0]!.path)
  await assert.rejects(new ClaudeEnvironmentFiles({ directory }).prepare('session', selected), { code: 'ENVIRONMENT_FILE_UNSAFE' })
  assert.equal(await readFile(foreign, 'utf8'), 'PRIVATE_FOREIGN_VALUE')
  await rm(files.files[0]!.path)
  await link(foreign, files.files[0]!.path)
  await assert.rejects(new ClaudeEnvironmentFiles({ directory }).prepare('session', selected), { code: 'ENVIRONMENT_FILE_UNSAFE' })
  const alias = join(root, 'state-alias')
  await symlink(directory, alias)
  await assert.rejects(new ClaudeEnvironmentFiles({ directory: alias }).prepare('session', selected), { code: 'ENVIRONMENT_DIRECTORY_UNSAFE' })
  await chmod(directory, 0o755)
  await assert.rejects(new ClaudeEnvironmentFiles({ directory }).prepare('session', selected), { code: 'ENVIRONMENT_DIRECTORY_UNSAFE' })
})

test('rejects altered and aliased manifests with bounded errors that exclude private paths and bytes', async t => {
  const { ClaudeEnvironmentFiles } = await import('../src/claude-environment-files.js')
  const { root, directory } = await fixture(t)
  const selected = registrations()
  const plan = await new ClaudeEnvironmentFiles({ directory }).prepare('session', selected)
  const manifest = join(dirname(plan.files[0]!.path), 'manifest.json')
  assert.equal((await lstat(manifest)).mode & 0o777, 0o600)
  await writeFile(manifest, 'PRIVATE_MANIFEST_BYTES'.repeat(1000))
  await assert.rejects(new ClaudeEnvironmentFiles({ directory }).prepare('session', selected), error => {
    assert.ok(error instanceof Error)
    assert.equal(error.message, 'ENVIRONMENT_LAYOUT_UNSUPPORTED')
    assert.equal(JSON.stringify(error).includes(root), false)
    assert.equal(JSON.stringify(error).includes('PRIVATE_MANIFEST_BYTES'), false)
    return true
  })
  const foreign = join(root, 'foreign-manifest')
  await writeFile(foreign, 'PRIVATE_FOREIGN_MANIFEST')
  await rm(manifest)
  await symlink(foreign, manifest)
  await assert.rejects(new ClaudeEnvironmentFiles({ directory }).prepare('session', selected), { code: 'ENVIRONMENT_FILE_UNSAFE' })
  assert.equal(await readFile(foreign, 'utf8'), 'PRIVATE_FOREIGN_MANIFEST')
})

test('snapshots the revision plan before I/O and cancellation preserves files needed for resume', async t => {
  const { ClaudeEnvironmentFiles } = await import('../src/claude-environment-files.js')
  const { directory } = await fixture(t)
  const selected = registrations()
  const input = [...selected]
  const preparing = new ClaudeEnvironmentFiles({ directory }).prepare('session', input)
  input.reverse()
  const plan = await preparing
  assert.deepEqual(plan.files.map(file => file.registrationID), ['source:SessionStart:0:0', 'source:SessionStart:0:1'])
  await writeFile(plan.files[0]!.path, 'export PRESERVED=yes\n')
  const controller = new AbortController()
  const cancelled = new ClaudeEnvironmentFiles({ directory }).prepare('session', selected, controller.signal)
  controller.abort()
  await assert.rejects(cancelled, { code: 'ENVIRONMENT_CANCELLED' })
  assert.equal(await readFile(plan.files[0]!.path, 'utf8'), 'export PRESERVED=yes\n')
  assert.deepEqual(await new ClaudeEnvironmentFiles({ directory }).prepare('session', selected), plan)
})

test('bounds and validates the complete registration plan before touching durable storage', async t => {
  const { ClaudeEnvironmentFiles } = await import('../src/claude-environment-files.js')
  const { root, directory } = await fixture(t)
  const store = new ClaudeEnvironmentFiles({ directory, maxRegistrations: 1 })
  const selected = registrations()
  await assert.rejects(store.prepare('session', selected), { code: 'ENVIRONMENT_REGISTRATION_LIMIT' })
  await assert.rejects(store.prepare('', [selected[0]!]), { code: 'ENVIRONMENT_SESSION_INVALID' })
  await assert.rejects(store.prepare('x'.repeat(4097), [selected[0]!]), { code: 'ENVIRONMENT_SESSION_INVALID' })
  await assert.rejects(store.prepare('session', [{ ...selected[0]!, sourceDigest: undefined } as unknown as Registration]), { code: 'ENVIRONMENT_SOURCE_REVISION_UNAVAILABLE' })
  await assert.rejects(store.prepare('session', [{ ...selected[0]!, event: 'Setup' }]), { code: 'ENVIRONMENT_EVENT_UNSUPPORTED' })
  await assert.rejects(new ClaudeEnvironmentFiles({ directory }).prepare('session', [selected[0]!, selected[0]!]), { code: 'ENVIRONMENT_REGISTRATION_INVALID' })
  const aborted = AbortSignal.abort()
  await assert.rejects(store.prepare('session', [selected[0]!], aborted), { code: 'ENVIRONMENT_CANCELLED' })
  assert.deepEqual(await readdir(root), [])
  assert.throws(() => new ClaudeEnvironmentFiles({ directory: 'relative/path' }), { code: 'ENVIRONMENT_OPTIONS_INVALID' })
  assert.throws(() => new ClaudeEnvironmentFiles({ directory, maxRegistrations: 0 }), { code: 'ENVIRONMENT_OPTIONS_INVALID' })
})

test('an empty selection creates no durable state and does not prevent later registration ownership', async t => {
  const { ClaudeEnvironmentFiles } = await import('../src/claude-environment-files.js')
  const { root, directory } = await fixture(t)
  const store = new ClaudeEnvironmentFiles({ directory })
  const empty = await store.prepare('session', [])
  assert.equal(empty.files.length, 0)
  assert.deepEqual(Object.keys(empty.registrationContext), [])
  assert.deepEqual(await readdir(root), [])
  const selected = await store.prepare('session', registrations())
  assert.equal(selected.files.length, 2)
})
