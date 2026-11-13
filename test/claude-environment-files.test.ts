import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { promisify } from 'node:util'
import type { LoadedSource, NativeEvent, Registration } from '../src/types.js'

const execute = promisify(execFile)
const DIGEST = 'a'.repeat(64)

test('environment deletion recognizes retained native files after source selection changes', async t => {
  const { ClaudeEnvironmentFiles } = await import('../src/claude-environment-files.js')
  const f = await fixture(t), selected = registrations(), files = new ClaudeEnvironmentFiles({ directory: f.directory, sources: [source(selected)] })
  const first = await files.prepare('first', selected), second = await files.prepare('second', selected)
  await writeFile(first.files[0]!.path, 'PRIVATE_ENV', { mode: 0o600 })
  const changed = new ClaudeEnvironmentFiles({ directory: f.directory, sources: [] })
  await changed.removeSession('first')
  await assert.rejects(lstat(first.directory!), { code: 'ENOENT' })
  assert.ok((await lstat(second.directory!)).isDirectory())
  await changed.removeSession('first')
  await assert.rejects(changed.prepare('first', []), { code: 'ENVIRONMENT_SESSION_DELETED' })
})

test('environment deletion preserves a replaced session directory and permits restoration retry', async t => {
  const { ClaudeEnvironmentFiles } = await import('../src/claude-environment-files.js')
  const f = await fixture(t), selected = registrations(), files = new ClaudeEnvironmentFiles({ directory: f.directory, sources: [source(selected)] })
  const plan = await files.prepare('session', selected), saved = plan.directory + '.owned'
  await rename(plan.directory!, saved); await mkdir(plan.directory!, { mode: 0o700 })
  const keep = join(plan.directory!, 'keep.txt'); await writeFile(keep, 'replacement')
  await assert.rejects(files.removeSession('session'), { code: 'ENVIRONMENT_DIRECTORY_UNSAFE' })
  assert.equal(await readFile(keep, 'utf8'), 'replacement')
  await rm(plan.directory!, { recursive: true }); await rename(saved, plan.directory!)
  await files.removeSession('session')
})

for (const unsafe of ['unknown', 'symlink', 'hardlink'] as const) test(`environment deletion validates every entry before mutation (${unsafe})`, async t => {
  const { ClaudeEnvironmentFiles } = await import('../src/claude-environment-files.js')
  const f = await fixture(t), selected = registrations(), files = new ClaudeEnvironmentFiles({ directory: f.directory, sources: [source(selected)] })
  const plan = await files.prepare('session', selected), outside = join(f.root, 'outside')
  await writeFile(outside, 'outside', { mode: 0o600 }); await writeFile(plan.files[0]!.path, 'owned', { mode: 0o600 })
  const path = unsafe === 'unknown' ? join(plan.directory!, 'keep.txt') : plan.files[1]!.path
  if (unsafe === 'unknown') await writeFile(path, 'keep')
  else if (unsafe === 'symlink') await symlink(outside, path)
  else await link(outside, path)
  await assert.rejects(files.removeSession('session'), { code: unsafe === 'unknown' ? 'ENVIRONMENT_LAYOUT_UNSUPPORTED' : 'ENVIRONMENT_FILE_UNSAFE' })
  assert.equal(await readFile(plan.files[0]!.path, 'utf8'), 'owned')
  assert.equal(await readFile(outside, 'utf8'), 'outside')
  await rm(path)
  await files.removeSession('session')
})

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

function source(registrations: readonly Registration[], id = 'source', digest = DIGEST): LoadedSource {
  return { id, dialect: 'claude-code', path: `/fixtures/${id}.json`, digest, enabled: true, excluded: [], registrations }
}

function fileOptions(directory: string, selected = registrations(), digest = DIGEST) {
  return { directory, sources: [source(selected, 'source', digest)] }
}

test('native matcher changes reuse ordinals and retain prior files when the selected count changes', async t => {
  const { ClaudeEnvironmentFiles } = await import('../src/claude-environment-files.js')
  const { dispatchEvent } = await import('../src/engine.js')
  const { loadSources } = await import('../src/config.js')
  const { selectRegistrations } = await import('../src/matchers.js')
  const { root, directory } = await fixture(t)
  const script = join(root, 'write.cjs')
  await writeFile(script, `require('node:fs').appendFileSync(process.env.CLAUDE_ENV_FILE,'export '+process.argv[2]+'=value\\n')`)
  const handler = (name: string) => ({ type: 'command', command: process.execPath, args: [script, name] })
  for (const [mode, initial, resumed] of [
    ['fewer', [handler('A'), handler('B')], [handler('A')]],
    ['more', [handler('A')], [handler('A'), handler('B')]],
  ] as const) {
    const path = join(root, mode + '.json')
    await writeFile(path, JSON.stringify({ hooks: { SessionStart: [{ matcher: 'startup', hooks: initial }, { matcher: 'resume', hooks: resumed }] } }))
    const sources = await loadSources([{ id: 'source', dialect: 'claude-code', path }])
    const options = { directory: join(directory, mode), sources }
    const plans = []
    for (const name of ['startup', 'resume']) {
      const event = { ...startup(root), data: { ...startup(root).data, source: name } }
      const selected = selectRegistrations(sources, event)
      const plan = await new ClaudeEnvironmentFiles(options).prepare('session', selected)
      plans.push(plan)
      const result = await dispatchEvent(sources, event, { environment: {}, projectRoot: root, registrationContext: plan.registrationContext })
      assert.ok(result.entries.every(entry => entry.result.status === 'success'))
    }
    assert.equal(plans[0]!.files.length, mode === 'fewer' ? 2 : 1)
    assert.equal(plans[1]!.files.length, mode === 'fewer' ? 1 : 2)
    assert.equal(plans[0]!.files[0]!.path, plans[1]!.files[0]!.path)
    assert.notEqual(plans[0]!.files[0]!.registrationID, plans[1]!.files[0]!.registrationID)
    assert.equal(await readFile(plans[0]!.files[0]!.path, 'utf8'), 'export A=value\nexport A=value\n')
    const second = (mode === 'fewer' ? plans[0] : plans[1])!.files[1]!
    assert.equal(await readFile(second.path, 'utf8'), 'export B=value\n')
  }
})

test('binds all reviewed Claude sources independently of which source matches the activation', async t => {
  const { ClaudeEnvironmentFiles } = await import('../src/claude-environment-files.js')
  const { root, directory } = await fixture(t)
  const first = registrations()[0]!
  const second = { ...first, id: 'other:SessionStart:0:0', sourceID: 'other' }
  const sources = [source([first]), source([second], 'other')]
  const options = { directory, sources }
  const initial = await new ClaudeEnvironmentFiles(options).prepare('session', [first])
  await writeFile(initial.files[0]!.path, 'export INITIAL=value\n')
  const resumed = await new ClaudeEnvironmentFiles(options).prepare('session', [second])
  assert.equal(resumed.files[0]!.path, initial.files[0]!.path)
  assert.equal(await readFile(resumed.files[0]!.path, 'utf8'), 'export INITIAL=value\n')
  const changed = { directory, sources: [{ ...sources[0]!, digest: 'b'.repeat(64), registrations: [{ ...first, sourceDigest: 'b'.repeat(64) }] }, sources[1]!] }
  await assert.rejects(new ClaudeEnvironmentFiles(changed).prepare('session', [second]), { code: 'ENVIRONMENT_LAYOUT_UNSUPPORTED' })
  for (const foreign of [{ ...second, id: 'unreviewed' }, { ...second, handler: { type: 'command' as const, command: 'PRIVATE_UNREVIEWED' } }]) {
    await assert.rejects(new ClaudeEnvironmentFiles(options).prepare('new-session', [foreign]), { code: 'ENVIRONMENT_REGISTRATION_UNREVIEWED' })
  }
  const mixed = { directory, sources: [...sources, { ...source([], 'codex'), dialect: 'codex' as const }] }
  assert.equal((await new ClaudeEnvironmentFiles(mixed).prepare('session', [second])).files[0]!.path, initial.files[0]!.path)
  assert.deepEqual((await readdir(root)).sort(), ['state'])
})

test('captures the full reviewed snapshot and rejects later mutation and disabled registrations', async t => {
  const { ClaudeEnvironmentFiles } = await import('../src/claude-environment-files.js')
  const { root, directory } = await fixture(t)
  const registration = { ...registrations()[0]!, handler: { type: 'command' as const, command: ':' } }
  const original = { ...registration, handler: { ...registration.handler } }
  const sources = [source([registration])]
  const store = new ClaudeEnvironmentFiles({ directory, sources })
  registration.handler.command = 'PRIVATE_LATER_MUTATION'
  await assert.rejects(store.prepare('session', [registration]), { code: 'ENVIRONMENT_REGISTRATION_UNREVIEWED' })
  const disabled = { directory, sources: [{ ...source([original]), enabled: false }] }
  await assert.rejects(new ClaudeEnvironmentFiles(disabled).prepare('session', [original]), { code: 'ENVIRONMENT_REGISTRATION_UNREVIEWED' })
  assert.deepEqual(await readdir(root), [])
  const plan = await store.prepare('session', [original])
  assert.equal(plan.files.length, 1)
  const expanded = { directory, sources: [source([original], 'source', DIGEST), source([], 'other')] }
  await assert.rejects(new ClaudeEnvironmentFiles(expanded).prepare('session', [original]), { code: 'ENVIRONMENT_LAYOUT_UNSUPPORTED' })
})

test('bounds and validates source snapshots without writing storage or exposing hook content', async t => {
  const { ClaudeEnvironmentFiles } = await import('../src/claude-environment-files.js')
  const { root, directory } = await fixture(t)
  const selected = registrations()
  const oversized = { ...selected[0]!, handler: { type: 'command' as const, command: 'PRIVATE_HOOK_BODY'.repeat(600_000) } }
  for (const sources of [Array.from({ length: 65 }, (_, index) => source([], 'source-' + index)), [source(Array.from({ length: 4097 }, () => selected[0]!))], [source([oversized])]]) {
    assert.throws(() => new ClaudeEnvironmentFiles({ directory, sources }), { code: 'ENVIRONMENT_SNAPSHOT_LIMIT' })
  }
  const aggregate = Array.from({ length: 4 }, (_, index) => ({ ...selected[0]!, id: `source:SessionStart:0:${index}`, handlerIndex: index, handler: { type: 'command' as const, command: 'x'.repeat(2_500_000) } }))
  assert.throws(() => new ClaudeEnvironmentFiles({ directory, sources: [source(aggregate)] }), { code: 'ENVIRONMENT_SNAPSHOT_LIMIT' })
  for (const sources of [[source(selected), source(selected)], [{ ...source(selected), digest: 'PRIVATE_INVALID_REVISION' }], [{ ...source([selected[0]!, selected[0]!]), enabled: false }]]) {
    assert.throws(() => new ClaudeEnvironmentFiles({ directory, sources }), error => {
      assert.ok(error instanceof Error)
      assert.equal(error.message, 'ENVIRONMENT_SOURCE_INVALID')
      assert.equal(JSON.stringify(error).includes('PRIVATE_'), false)
      return true
    })
  }
  assert.deepEqual(await readdir(root), [])
})

test('reserves absent independent files in configured order and executes unchanged duplicate hooks', async t => {
  const { ClaudeEnvironmentFiles } = await import('../src/claude-environment-files.js')
  const { dispatchEvent } = await import('../src/engine.js')
  const { root, directory } = await fixture(t)
  const hook = join(root, 'write.cjs')
  await writeFile(hook, `require('node:fs').appendFileSync(process.env.CLAUDE_ENV_FILE,'export SESSION_VALUE=value\\n')`)
  const selected = registrations(`"${process.execPath}" "${hook}"`)
  const files = await new ClaudeEnvironmentFiles(fileOptions(directory, selected)).prepare('session', selected)
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
  const first = await new ClaudeEnvironmentFiles(fileOptions(directory)).prepare('session', selected)
  await writeFile(first.files[0]!.path, 'fixture() { printf startup; }\n')
  const module = new URL('../src/claude-environment-files.ts', import.meta.url).href
  const code = `import {ClaudeEnvironmentFiles} from ${JSON.stringify(module)};import{appendFile}from'node:fs/promises';const input=JSON.parse(process.argv[1]);const files=await new ClaudeEnvironmentFiles({directory:input.directory,sources:input.sources}).prepare('session',input.registrations);await appendFile(files.files[0].path,'export RESUMED=yes\\n');process.stdout.write(JSON.stringify(files));`
  const child = await execute(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code, JSON.stringify({ directory, registrations: selected, sources: [source(selected)] })], { timeout: 10_000, maxBuffer: 64 * 1024 })
  assert.equal(child.stderr, '')
  assert.equal(child.stdout, JSON.stringify(first))
  assert.equal(await readFile(first.files[0]!.path, 'utf8'), 'fixture() { printf startup; }\nexport RESUMED=yes\n')
  const other = await new ClaudeEnvironmentFiles(fileOptions(directory)).prepare('../other-session', selected)
  assert.notEqual(dirname(other.files[0]!.path), dirname(first.files[0]!.path))
  assert.equal(dirname(dirname(other.files[0]!.path)), directory)
  assert.equal((await lstat(directory)).mode & 0o777, 0o700)
  assert.deepEqual((await readdir(root)).sort(), ['state'])
})

test('concurrent reservations cannot replace a different source revision or configured order', async t => {
  const { ClaudeEnvironmentFiles } = await import('../src/claude-environment-files.js')
  const { directory } = await fixture(t)
  const selected = registrations()
  const stores = [new ClaudeEnvironmentFiles(fileOptions(directory)), new ClaudeEnvironmentFiles(fileOptions(directory))]
  const concurrent = await Promise.all(stores.map(store => store.prepare('session', selected)))
  assert.deepEqual(concurrent[0], concurrent[1])
  await assert.rejects(stores[0]!.prepare('session', selected.toReversed()), { code: 'ENVIRONMENT_REGISTRATION_ORDER_INVALID' })
  const changed = selected.map(row => ({ ...row, sourceDigest: 'b'.repeat(64) }))
  await assert.rejects(new ClaudeEnvironmentFiles(fileOptions(directory, changed, 'b'.repeat(64))).prepare('session', changed), { code: 'ENVIRONMENT_LAYOUT_UNSUPPORTED' })
  assert.deepEqual(await stores[1]!.prepare('session', selected), concurrent[0])
  const competing = [selected, selected.map(row => ({ ...row, sourceDigest: 'c'.repeat(64) }))]
  const contenders = [new ClaudeEnvironmentFiles(fileOptions(directory)), new ClaudeEnvironmentFiles(fileOptions(directory, competing[1]!, 'c'.repeat(64)))]
  const race = await Promise.allSettled(contenders.map((store, index) => store.prepare('racing-session', competing[index]!)))
  assert.equal(race.filter(row => row.status === 'fulfilled').length, 1)
  const rejected = race.find(row => row.status === 'rejected')
  assert.ok(rejected?.status === 'rejected')
  assert.equal((rejected.reason as { code: string }).code, 'ENVIRONMENT_LAYOUT_UNSUPPORTED')
  const winner = race.findIndex(row => row.status === 'fulfilled')
  assert.deepEqual(await contenders[winner]!.prepare('racing-session', competing[winner]!), (race[winner] as PromiseFulfilledResult<unknown>).value)
})

test('rejects unsafe directories and hook-created file aliases without following them', async t => {
  const { ClaudeEnvironmentFiles } = await import('../src/claude-environment-files.js')
  const { root, directory } = await fixture(t)
  const selected = registrations()
  const files = await new ClaudeEnvironmentFiles(fileOptions(directory, selected)).prepare('session', selected)
  const foreign = join(root, 'foreign')
  await writeFile(foreign, 'PRIVATE_FOREIGN_VALUE')
  await symlink(foreign, files.files[0]!.path)
  await assert.rejects(new ClaudeEnvironmentFiles(fileOptions(directory)).prepare('session', selected), { code: 'ENVIRONMENT_FILE_UNSAFE' })
  assert.equal(await readFile(foreign, 'utf8'), 'PRIVATE_FOREIGN_VALUE')
  await rm(files.files[0]!.path)
  await link(foreign, files.files[0]!.path)
  await assert.rejects(new ClaudeEnvironmentFiles(fileOptions(directory)).prepare('session', selected), { code: 'ENVIRONMENT_FILE_UNSAFE' })
  const alias = join(root, 'state-alias')
  await symlink(directory, alias)
  await assert.rejects(new ClaudeEnvironmentFiles(fileOptions(alias)).prepare('session', selected), { code: 'ENVIRONMENT_DIRECTORY_UNSAFE' })
  await chmod(directory, 0o755)
  await assert.rejects(new ClaudeEnvironmentFiles(fileOptions(directory)).prepare('session', selected), { code: 'ENVIRONMENT_DIRECTORY_UNSAFE' })
})

test('rejects altered and aliased manifests with bounded errors that exclude private paths and bytes', async t => {
  const { ClaudeEnvironmentFiles } = await import('../src/claude-environment-files.js')
  const { root, directory } = await fixture(t)
  const selected = registrations()
  const plan = await new ClaudeEnvironmentFiles(fileOptions(directory)).prepare('session', selected)
  const manifest = join(dirname(plan.files[0]!.path), 'manifest.json')
  assert.equal((await lstat(manifest)).mode & 0o777, 0o600)
  await writeFile(manifest, 'PRIVATE_MANIFEST_BYTES'.repeat(1000))
  await assert.rejects(new ClaudeEnvironmentFiles(fileOptions(directory)).prepare('session', selected), error => {
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
  await assert.rejects(new ClaudeEnvironmentFiles(fileOptions(directory)).prepare('session', selected), { code: 'ENVIRONMENT_FILE_UNSAFE' })
  assert.equal(await readFile(foreign, 'utf8'), 'PRIVATE_FOREIGN_MANIFEST')
})

test('snapshots the revision plan before I/O and cancellation preserves files needed for resume', async t => {
  const { ClaudeEnvironmentFiles } = await import('../src/claude-environment-files.js')
  const { directory } = await fixture(t)
  const selected = registrations()
  const input = [...selected]
  const preparing = new ClaudeEnvironmentFiles(fileOptions(directory)).prepare('session', input)
  input.reverse()
  const plan = await preparing
  assert.deepEqual(plan.files.map(file => file.registrationID), ['source:SessionStart:0:0', 'source:SessionStart:0:1'])
  await writeFile(plan.files[0]!.path, 'export PRESERVED=yes\n')
  const controller = new AbortController()
  const cancelled = new ClaudeEnvironmentFiles(fileOptions(directory)).prepare('session', selected, controller.signal)
  controller.abort()
  await assert.rejects(cancelled, { code: 'ENVIRONMENT_CANCELLED' })
  assert.equal(await readFile(plan.files[0]!.path, 'utf8'), 'export PRESERVED=yes\n')
  assert.deepEqual(await new ClaudeEnvironmentFiles(fileOptions(directory)).prepare('session', selected), plan)
})

test('bounds and validates the complete registration plan before touching durable storage', async t => {
  const { ClaudeEnvironmentFiles } = await import('../src/claude-environment-files.js')
  const { root, directory } = await fixture(t)
  const store = new ClaudeEnvironmentFiles({ ...fileOptions(directory), maxRegistrations: 1 })
  const selected = registrations()
  await assert.rejects(store.prepare('session', selected), { code: 'ENVIRONMENT_REGISTRATION_LIMIT' })
  await assert.rejects(store.prepare('', [selected[0]!]), { code: 'ENVIRONMENT_SESSION_INVALID' })
  await assert.rejects(store.prepare('x'.repeat(4097), [selected[0]!]), { code: 'ENVIRONMENT_SESSION_INVALID' })
  await assert.rejects(store.prepare('session', [{ ...selected[0]!, sourceDigest: 'invalid' }]), { code: 'ENVIRONMENT_SOURCE_REVISION_UNAVAILABLE' })
  await assert.rejects(store.prepare('session', [{ ...selected[0]!, event: 'Setup' }]), { code: 'ENVIRONMENT_EVENT_UNSUPPORTED' })
  await assert.rejects(new ClaudeEnvironmentFiles(fileOptions(directory)).prepare('session', [selected[0]!, selected[0]!]), { code: 'ENVIRONMENT_REGISTRATION_INVALID' })
  const aborted = AbortSignal.abort()
  await assert.rejects(store.prepare('session', [selected[0]!], aborted), { code: 'ENVIRONMENT_CANCELLED' })
  assert.deepEqual(await readdir(root), [])
  assert.throws(() => new ClaudeEnvironmentFiles(fileOptions('relative/path')), { code: 'ENVIRONMENT_OPTIONS_INVALID' })
  assert.throws(() => new ClaudeEnvironmentFiles({ ...fileOptions(directory), maxRegistrations: 0 }), { code: 'ENVIRONMENT_OPTIONS_INVALID' })
})

test('an empty selection creates no durable state and does not prevent later registration ownership', async t => {
  const { ClaudeEnvironmentFiles } = await import('../src/claude-environment-files.js')
  const { root, directory } = await fixture(t)
  const store = new ClaudeEnvironmentFiles(fileOptions(directory))
  const empty = await store.prepare('session', [])
  assert.equal(empty.files.length, 0)
  assert.deepEqual(Object.keys(empty.registrationContext), [])
  assert.deepEqual(await readdir(root), [])
  const selected = await store.prepare('session', registrations())
  assert.equal(selected.files.length, 2)
})

test('an empty resumed selection exposes the retained environment directory without rewriting it', async t => {
  const { ClaudeEnvironmentFiles } = await import('../src/claude-environment-files.js')
  const { root, directory } = await fixture(t)
  const store = new ClaudeEnvironmentFiles(fileOptions(directory))
  const first = await store.prepare('session', registrations())
  await writeFile(first.files[0]!.path, 'export RETAINED=yes\n')
  const resumed = await store.prepare('session', [])
  assert.equal(resumed.directory, dirname(first.files[0]!.path))
  assert.equal(await readFile(join(resumed.directory!, 'sessionstart-hook-0.sh'), 'utf8'), 'export RETAINED=yes\n')
  assert.notEqual(resumed.directory, root)
})
