import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { SessionStore } from '../src/session-store.js'

async function fixture(t: { after: (callback: () => Promise<void>) => void }, limits = {}) {
  const root = await mkdtemp(join(tmpdir(), 'native-session-store-')), project = join(root, 'project'), directory = join(root, 'state')
  await mkdir(project)
  const options = { directory, project, host: 'v1' as const, ...limits }, store = new SessionStore(options)
  t.after(async () => { await store.dispose(); await rm(root, { recursive: true, force: true }) })
  return { root, project, directory, options, store }
}

test('owned native state survives a fresh store with immutable payload and monotonically checked revisions', async t => {
  const f = await fixture(t), original = { command: 'original', startup: [{ id: 'record', created: 123, text: 'Context' }] }
  const absent = await f.store.load('session')
  assert.equal(absent.exists, false)
  const first = await f.store.save(absent, original)
  original.command = 'effective'
  assert.equal(first.payload!.command, 'original')
  assert.ok(Object.isFrozen(first) && Object.isFrozen(first.payload) && Object.isFrozen(first.payload!.startup))
  await f.store.dispose()
  const resumed = new SessionStore(f.options)
  t.after(() => resumed.dispose())
  assert.deepEqual((await resumed.load('session')).payload, first.payload)
  const next = await resumed.save(await resumed.load('session'), { original: first.payload })
  assert.ok(next.revision > first.revision)
  assert.equal((await lstat(join(f.directory, 'native-sessions.sqlite'))).mode & 0o077, 0)
})

test('independent writers reject stale revisions and preserve the accepted original', async t => {
  const f = await fixture(t), other = new SessionStore(f.options)
  t.after(() => other.dispose())
  const left = await f.store.load('session'), right = await other.load('session')
  await f.store.save(left, { input: 'original' })
  await assert.rejects(other.save(right, { input: 'unowned replacement' }), { code: 'SESSION_STORE_CONFLICT' })
  assert.deepEqual((await other.load('session')).payload, { input: 'original' })
  await assert.rejects(other.save(await f.store.load('session'), { input: 'foreign receipt' }), { code: 'SESSION_STORE_RECEIPT_INVALID' })
})

test('deletion survives restart and purging bounded tombstones cannot revive an old absent receipt', async t => {
  const f = await fixture(t, { maxSessions: 1 }), stale = await f.store.load('stale')
  const live = await f.store.save(await f.store.load('session'), { value: 'owned' })
  const deleted = await f.store.delete(live)
  assert.equal(deleted.deleted, true)
  await assert.rejects(f.store.save(deleted, { value: 'revived' }), { code: 'SESSION_STORE_DELETED' })
  await f.store.delete(await f.store.load('other'))
  await assert.rejects(f.store.save(stale, { value: 'stale' }), { code: 'SESSION_STORE_CONFLICT' })
  await f.store.dispose()
  const resumed = new SessionStore(f.options)
  t.after(() => resumed.dispose())
  assert.equal((await resumed.load('other')).deleted, true)
})

test('payload, aggregate byte and session budgets reject before replacing retained data', async t => {
  const f = await fixture(t, { maxPayloadBytes: 64, maxRetainedBytes: 80, maxSessions: 1 })
  const first = await f.store.save(await f.store.load('session'), { text: 'owned' })
  await assert.rejects(f.store.save(first, { text: 'x'.repeat(80) }), { code: 'SESSION_STORE_LIMIT' })
  await assert.rejects(f.store.save(await f.store.load('other'), { text: 'other' }), { code: 'SESSION_STORE_LIMIT' })
  assert.deepEqual((await f.store.load('session')).payload, { text: 'owned' })
})

test('unsafe database/sidecar files and foreign project ownership cannot be opened', async t => {
  const f = await fixture(t)
  await f.store.save(await f.store.load('session'), { input: 'owned' })
  await f.store.dispose()
  const other = join(f.root, 'other-project')
  await mkdir(other)
  const foreign = new SessionStore({ ...f.options, project: other })
  t.after(() => foreign.dispose())
  await assert.rejects(foreign.load('session'), { code: 'SESSION_STORE_OWNER_MISMATCH' })
  await chmod(join(f.directory, 'native-sessions.sqlite'), 0o666)
  const unsafe = new SessionStore(f.options)
  t.after(() => unsafe.dispose())
  await assert.rejects(unsafe.load('session'), { code: 'SESSION_STORE_FILE_UNSAFE' })
})

test('a symlinked sidecar cannot redirect SQLite writes and cancelled input cannot publish state', async t => {
  const f = await fixture(t), outside = join(f.root, 'outside')
  await mkdir(f.directory, { mode: 0o700 })
  await writeFile(outside, 'unchanged')
  await symlink(outside, join(f.directory, 'native-sessions.sqlite-wal'))
  await assert.rejects(f.store.load('session'), { code: 'SESSION_STORE_FILE_UNSAFE' })
  assert.equal(await readFile(outside, 'utf8'), 'unchanged')
  const cancelled = new SessionStore({ ...f.options, directory: join(f.root, 'cancelled') })
  t.after(() => cancelled.dispose())
  await assert.rejects(cancelled.load('session', AbortSignal.abort()), { code: 'SESSION_STORE_CANCELLED' })
})

test('constructor options are captured before asynchronous storage work', async t => {
  const f = await fixture(t), options = { ...f.options, directory: join(f.root, 'captured') }
  const captured = options.directory, store = new SessionStore(options)
  t.after(() => store.dispose())
  options.directory = join(f.root, 'foreign')
  await store.load('session')
  assert.ok((await lstat(join(captured, 'native-sessions.sqlite'))).isFile())
  await assert.rejects(lstat(options.directory), { code: 'ENOENT' })
})

test('aggregate byte limits are transactional independently of session-count limits', async t => {
  const f = await fixture(t, { maxPayloadBytes: 64, maxRetainedBytes: 80, maxSessions: 3 })
  await f.store.save(await f.store.load('first'), { text: 'x'.repeat(40) })
  await assert.rejects(f.store.save(await f.store.load('second'), { text: 'y'.repeat(40) }), { code: 'SESSION_STORE_LIMIT' })
  assert.equal((await f.store.load('second')).exists, false)
  assert.deepEqual((await f.store.load('first')).payload, { text: 'x'.repeat(40) })
})

test('a changed database safety boundary rejects writes after initialization', async t => {
  const f = await fixture(t), original = await f.store.save(await f.store.load('session'), { input: 'owned' })
  await chmod(join(f.directory, 'native-sessions.sqlite'), 0o666)
  await assert.rejects(f.store.save(original, { input: 'changed' }), { code: 'SESSION_STORE_FILE_UNSAFE' })
})

test('failure telemetry is attributable and excludes native payloads and database paths', async t => {
  const diagnostics: unknown[] = []
  const f = await fixture(t, { maxPayloadBytes: 32, diagnostic: (value: unknown) => { diagnostics.push(value) } })
  const original = await f.store.load('session')
  await assert.rejects(f.store.save(original, { input: 'PRIVATE_STATE_'.repeat(20) }), { code: 'SESSION_STORE_LIMIT' })
  const output = JSON.stringify(diagnostics)
  assert.ok(output.includes('SESSION_STORE_LIMIT') && output.includes('save') && output.includes('durationMs') && output.includes('operationID'))
  assert.ok(!output.includes('PRIVATE_STATE_') && !output.includes(f.directory))
})

test('checksum corruption is rejected and SQLite corruption is not misreported as missing runtime support', async t => {
  const f = await fixture(t)
  await f.store.save(await f.store.load('session'), { input: 'owned' })
  await f.store.dispose()
  const module = process.versions.bun ? 'bun:sqlite' : 'node:sqlite'
  const sqlite = await import(module)
  const db = process.versions.bun ? new sqlite.Database(join(f.directory, 'native-sessions.sqlite')) : new sqlite.DatabaseSync(join(f.directory, 'native-sessions.sqlite'))
  db.prepare('UPDATE sessions SET payload=? WHERE session_id=?').run('{"input":"other"}', 'session')
  db.close()
  const corrupted = new SessionStore(f.options)
  t.after(() => corrupted.dispose())
  await assert.rejects(corrupted.load('session'), { code: 'SESSION_STORE_CHECKSUM_INVALID' })
  const brokenDirectory = join(f.root, 'broken')
  await mkdir(brokenDirectory, { mode: 0o700 })
  await writeFile(join(brokenDirectory, 'native-sessions.sqlite'), 'invalid sqlite bytes', { mode: 0o600 })
  const broken = new SessionStore({ ...f.options, directory: brokenDirectory })
  t.after(() => broken.dispose())
  await assert.rejects(broken.load('session'), { code: 'SESSION_STORE_SCHEMA_INVALID' })
})

test('disposal drains accepted work, rejects new operations and counts failed telemetry observers', async t => {
  const f = await fixture(t, { diagnostic: () => { throw new Error('observer') } })
  const pending = f.store.load('session')
  const disposal = f.store.dispose()
  await pending
  await disposal
  await assert.rejects(f.store.load('session'), { code: 'SESSION_STORE_CLOSED' })
  assert.deepEqual(f.store.inspect(), { opened: false, closed: true, pending: 0, observerFailures: 1 })
})

test('a killed database writer cannot publish an uncommitted native state replacement', async t => {
  const f = await fixture(t)
  await f.store.save(await f.store.load('session'), { input: 'owned' })
  const node = process.versions.bun ? execFileSync('node', ['-p', 'process.execPath'], { encoding: 'utf8', timeout: 5000 }).trim() : process.execPath
  const script = `const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(process.argv[1]);db.exec('PRAGMA busy_timeout=1000;BEGIN IMMEDIATE');db.prepare('UPDATE sessions SET payload=? WHERE session_id=?').run('{"input":"other"}','session');process.stdout.write('LOCKED',()=>process.kill(process.pid,'SIGKILL'));`
  const child = spawn(node, ['--input-type=module', '-e', script, join(f.directory, 'native-sessions.sqlite')], { stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', chunk => { output += String(chunk) })
  try {
    const signal = await new Promise<NodeJS.Signals | null>((resolve, reject) => { child.once('close', (_code, signal) => resolve(signal)); child.once('error', reject) })
    assert.equal(signal, 'SIGKILL')
    assert.equal(output, 'LOCKED')
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') }
  await f.store.dispose()
  const recovered = new SessionStore(f.options)
  t.after(() => recovered.dispose())
  assert.deepEqual((await recovered.load('session')).payload, { input: 'owned' })
})

test('state serialization rejects accessors without executing caller code', async t => {
  const f = await fixture(t), previous = await f.store.load('session')
  let reads = 0
  const payload = Object.defineProperty({}, 'input', { enumerable: true, get: () => { reads++; return 'unowned' } })
  await assert.rejects(f.store.save(previous, payload), { code: 'SESSION_STORE_INPUT_INVALID' })
  assert.equal(reads, 0)
  assert.equal((await f.store.load('session')).exists, false)
})

test('unrelated session commits do not invalidate an owned absent-session receipt', async t => {
  const f = await fixture(t), left = await f.store.load('left'), right = await f.store.load('right')
  await f.store.save(left, { input: 'left' })
  await f.store.save(right, { input: 'right' })
  assert.deepEqual((await f.store.load('left')).payload, { input: 'left' })
  assert.deepEqual((await f.store.load('right')).payload, { input: 'right' })
})
