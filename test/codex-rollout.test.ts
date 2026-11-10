import assert from 'node:assert/strict'
import { constants, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, open, readFile, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { CodexRollout } from '../src/codex-rollout.js'
import type { CodexRolloutHistoryRecord } from '../src/codex-rollout.js'
import type { CodexStopPromptArtifacts } from '../src/codex-stop-prompts.js'
import { loadSources } from '../src/config.js'
import { bindCodexStopInventory } from '../src/codex-stop-inventory.js'
import { compileCodexStopPrompt } from '../src/codex-stop-prompts.js'
import { createRuntime } from '../src/runtime.js'

const scenario = JSON.parse(readFileSync(new URL('./fixtures/codex-stop-artifact-oracle.json', import.meta.url), 'utf8')).cases[0]
const timestamp = new Date(scenario.identity.createTime * 1000).toISOString()
const FIFO_RESCUE_MS = 2000
async function fixture(t: TestContext, limits: { readonly maxSessionBytes?: number; readonly maxTotalBytes?: number; readonly maxSessions?: number } = {}) {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'harness-rollout-test-')))
  const rollout = new CodexRollout({ temporaryParent: parent, now: () => scenario.identity.completedAtMs + 1, ...limits })
  t.after(async () => { await rollout.dispose(); await rm(parent, { recursive: true, force: true }) })
  const metadata = { session_id: scenario.identity.threadID, id: scenario.identity.threadID, timestamp, cwd: parent, originator: 'opencode-harness-hooks', cli_version: '0.1.0', source: 'unknown', model_provider: 'fixture', base_instructions: { text: 'Synthetic' }, history_mode: 'legacy' }
  const history: CodexRolloutHistoryRecord[] = [
    { timestamp, type: 'event_msg', payload: { type: 'task_started', turn_id: scenario.identity.turnID, model_context_window: null } },
    { timestamp, type: 'response_item', payload: { type: 'message', id: 'msg_user', role: 'user', content: [{ type: 'input_text', text: 'Question' }] } },
    { timestamp, type: 'event_msg', payload: { type: 'user_message', message: 'Question', images: [], local_images: [], text_elements: [] } },
    { timestamp, type: 'response_item', payload: { type: 'message', id: 'msg_assistant', role: 'assistant', content: [{ type: 'output_text', text: 'Answer' }] } },
    { timestamp, type: 'event_msg', payload: { type: 'agent_message', message: 'Answer', phase: 'final_answer' } },
  ]
  const artifacts: CodexStopPromptArtifacts = { ...scenario.expected, origins: [] }
  return { rollout, parent, metadata, history, artifacts, threadID: scenario.identity.threadID }
}

test('persists native rollout metadata and Stop envelopes with stable inode and exact payloads', async t => {
  const f = await fixture(t), path = await f.rollout.create({ metadata: f.metadata, history: f.history })
  const before = await stat(path)
  assert.equal(before.mode & 0o777, 0o600)
  await f.rollout.appendStop(f.threadID, f.artifacts)
  const after = await stat(path), rows = (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.equal(before.ino, after.ino)
  assert.deepEqual(rows.map(row => row.ordinal), rows.map((_, index) => index))
  assert.deepEqual(rows.at(-2).payload, f.artifacts.response)
  assert.deepEqual(rows.at(-1).payload, f.artifacts.event)
  assert.equal(rows[0].type, 'session_meta')
  assert.deepEqual(rows[0].payload, f.metadata)
  assert.equal(f.rollout.inspect().pending, 0)
})

test('idempotent Stop admission preserves bytes and changed retries fail without changing the file', async t => {
  const f = await fixture(t), path = await f.rollout.create({ metadata: f.metadata, history: f.history })
  await Promise.all([f.rollout.appendStop(f.threadID, f.artifacts), f.rollout.appendStop(f.threadID, f.artifacts)])
  const before = await readFile(path)
  await f.rollout.appendStop(f.threadID, f.artifacts)
  assert.deepEqual(await readFile(path), before)
  const changed = structuredClone(f.artifacts) as unknown as { event: { item: { fragments: { text: string }[] } } }
  changed.event.item.fragments[0]!.text = 'Different'
  await assert.rejects(f.rollout.appendStop(f.threadID, changed as unknown as CodexStopPromptArtifacts), { code: 'CODEX_ROLLOUT_STOP_CONFLICT' })
  assert.deepEqual(await readFile(path), before)
})

test('rolls back a cancelled pending sync and a write failure before retrying the same Stop identity', async t => {
  const f = await fixture(t), path = await f.rollout.create({ metadata: f.metadata, history: f.history }), before = await readFile(path)
  const handle = await open(join(f.parent, 'prototype'), 'w')
  const prototype = Object.getPrototypeOf(handle) as { sync: (this: FileHandle) => Promise<void> }, original = prototype.sync
  await handle.close()
  let entered!: () => void, release!: () => void
  const syncing = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
  const controller = new AbortController()
  prototype.sync = async function () { await original.call(this); entered(); await gate }
  try {
    const pending = f.rollout.appendStop(f.threadID, f.artifacts, controller.signal)
    await syncing
    controller.abort(); release()
    await assert.rejects(pending, { code: 'CODEX_ROLLOUT_CANCELLED' })
  } finally { release(); prototype.sync = original }
  assert.deepEqual(await readFile(path), before)
  let failed = false
  prototype.sync = async function () { if (!failed) { failed = true; throw new Error('PRIVATE_IO_DETAIL') } await original.call(this) }
  try { await assert.rejects(f.rollout.appendStop(f.threadID, f.artifacts), { code: 'CODEX_ROLLOUT_IO_FAILED' }) } finally { prototype.sync = original }
  assert.deepEqual(await readFile(path), before)
  await f.rollout.appendStop(f.threadID, f.artifacts)
  const records = (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.equal(records.filter(row => row.type === 'event_msg' && row.payload.type === 'item_completed').length, 1)
  assert.equal(f.rollout.inspect().reservedBytes, 0)
})

test('cancellation during close rolls back and a replaced pathname never reports admission', async t => {
  const f = await fixture(t), path = await f.rollout.create({ metadata: f.metadata, history: f.history }), before = await readFile(path)
  const handle = await open(join(f.parent, 'close-prototype'), 'w')
  const prototype = Object.getPrototypeOf(handle) as { sync: (this: FileHandle) => Promise<void> }
  const io = f.rollout as unknown as { close: (file: FileHandle) => Promise<void> }
  const close = io.close, sync = prototype.sync
  await handle.close()
  let entered!: () => void, release!: () => void
  const closing = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
  const controller = new AbortController()
  io.close = async function (file) { await close.call(f.rollout, file); entered(); await gate }
  try {
    const pending = f.rollout.appendStop(f.threadID, f.artifacts, controller.signal)
    await Promise.race([closing, pending.then(() => assert.fail('admitted before close gate'))])
    controller.abort(); release()
    await assert.rejects(pending, { code: 'CODEX_ROLLOUT_CANCELLED' })
  } finally { release(); io.close = close }
  assert.deepEqual(await readFile(path), before)
  let replaced = false
  prototype.sync = async function () {
    await sync.call(this)
    if (!replaced) { replaced = true; await rename(path, path + '.displaced'); await writeFile(path, 'EXTERNAL_REPLACEMENT') }
  }
  try { await assert.rejects(f.rollout.appendStop(f.threadID, f.artifacts), { code: 'CODEX_ROLLOUT_RECOVERY_REQUIRED' }) } finally { prototype.sync = sync }
  assert.equal(await readFile(path, 'utf8'), 'EXTERNAL_REPLACEMENT')
  assert.equal(f.rollout.inspect().bytes, (await stat(path + '.displaced')).size)
  assert.ok(f.rollout.inspect().uncertainBytes > 0)
  await assert.rejects(f.rollout.appendStop(f.threadID, f.artifacts), { code: 'CODEX_ROLLOUT_RECOVERY_REQUIRED' })
  await assert.rejects(f.rollout.dispose(), { code: 'CODEX_ROLLOUT_FILE_CHANGED' })
  const preserved = join(f.parent, 'replacement-preserved')
  await rename(path, preserved)
  await rename(path + '.displaced', path)
  await f.rollout.dispose()
  assert.equal(await readFile(preserved, 'utf8'), 'EXTERNAL_REPLACEMENT')
  assert.equal(f.rollout.inspect().bytes, 0)
})

test('disposal preserves a replacement root directory and can retry after owned state is restored', async t => {
  const f = await fixture(t), path = await f.rollout.create({ metadata: f.metadata, history: f.history })
  const root = path.slice(0, path.lastIndexOf('/sessions/')), preserved = root + '.preserved', replacement = root + '.replacement'
  await rename(root, preserved)
  await mkdir(root)
  await writeFile(join(root, 'unowned'), 'keep')
  await assert.rejects(f.rollout.dispose(), { code: 'CODEX_ROLLOUT_ROOT_CHANGED' })
  assert.equal(await readFile(join(root, 'unowned'), 'utf8'), 'keep')
  await rename(root, replacement)
  await rename(preserved, root)
  await f.rollout.dispose()
  assert.equal(await readFile(join(replacement, 'unowned'), 'utf8'), 'keep')
})

test('a replaced FIFO cannot block an idempotent admission check', async t => {
  const f = await fixture(t), path = await f.rollout.create({ metadata: f.metadata, history: f.history })
  await f.rollout.appendStop(f.threadID, f.artifacts)
  await rename(path, path + '.regular')
  execFileSync('mkfifo', [path])
  let rescued = false
  const rescue = setTimeout(() => { rescued = true; void open(path, constants.O_WRONLY | constants.O_NONBLOCK).then(file => file.close()).catch(() => {}) }, FIFO_RESCUE_MS)
  try { await assert.rejects(f.rollout.appendStop(f.threadID, f.artifacts), { code: 'CODEX_ROLLOUT_FILE_CHANGED' }); assert.equal(rescued, false) } finally { clearTimeout(rescue) }
  await rename(path, join(f.parent, 'fifo-preserved'))
  await rename(path + '.regular', path)
})

test('replaced intermediate directories cannot redirect creation outside owned state', async t => {
  const f = await fixture(t), path = await f.rollout.create({ metadata: f.metadata, history: f.history })
  const root = path.slice(0, path.lastIndexOf('/sessions/')), sessions = join(root, 'sessions'), original = join(root, 'original-sessions'), outside = join(f.parent, 'outside')
  await rename(sessions, original)
  await mkdir(outside)
  await symlink(outside, sessions)
  const otherID = '00000000-0000-4000-8000-000000000002'
  await assert.rejects(f.rollout.create({ metadata: { ...f.metadata, id: otherID, session_id: otherID }, history: [] }), { code: 'CODEX_ROLLOUT_DIRECTORY_CHANGED' })
  await assert.rejects(f.rollout.dispose(), { code: 'CODEX_ROLLOUT_DIRECTORY_CHANGED' })
  await rename(sessions, join(f.parent, 'symlink-preserved'))
  await rename(original, sessions)
  await f.rollout.dispose()
  assert.ok((await stat(outside)).isDirectory())
})

test('unexpected files remain for recovery instead of being recursively removed', async t => {
  const f = await fixture(t), path = await f.rollout.create({ metadata: f.metadata, history: f.history })
  const root = path.slice(0, path.lastIndexOf('/sessions/')), unowned = join(root, 'unowned-note'), preserved = join(f.parent, 'unowned-preserved')
  await writeFile(unowned, 'keep')
  await assert.rejects(f.rollout.dispose(), { code: 'CODEX_ROLLOUT_RECOVERY_REQUIRED' })
  assert.equal(await readFile(unowned, 'utf8'), 'keep')
  await rename(unowned, preserved)
  await f.rollout.dispose()
  assert.equal(await readFile(preserved, 'utf8'), 'keep')
})

test('same-inode corruption during initial sync or writer close cannot admit an invalid journal', async t => {
  const f = await fixture(t), handle = await open(join(f.parent, 'initial-prototype'), 'w')
  const prototype = Object.getPrototypeOf(handle) as { sync: (this: FileHandle) => Promise<void> }, sync = prototype.sync
  await handle.close()
  let corrupted = false
  prototype.sync = async function () {
    await sync.call(this)
    if (!corrupted) { corrupted = true; await this.write(Buffer.from('CORRUPTED'), 0, 9, 0); await sync.call(this) }
  }
  try { await assert.rejects(f.rollout.create({ metadata: f.metadata, history: f.history }), { code: 'CODEX_ROLLOUT_FILE_CHANGED' }) } finally { prototype.sync = sync }
  assert.equal(f.rollout.inspect().sessions, 0)
  const io = f.rollout as unknown as { close: (file: FileHandle) => Promise<void> }, close = io.close
  let corruptClose = true
  io.close = async function (file) {
    if (corruptClose) { corruptClose = false; await file.write(Buffer.from('CORRUPTED'), 0, 9, 0); await file.sync() }
    await close.call(f.rollout, file)
  }
  try { await assert.rejects(f.rollout.create({ metadata: f.metadata, history: f.history }), { code: 'CODEX_ROLLOUT_FILE_CHANGED' }) } finally { io.close = close }
  assert.equal(f.rollout.inspect().sessions, 0)
  const path = await f.rollout.create({ metadata: f.metadata, history: f.history })
  assert.equal(JSON.parse((await readFile(path, 'utf8')).split('\n')[0]!).type, 'session_meta')
})

test('corruption during rollback requires recovery and retains the failed-write budget', async t => {
  const f = await fixture(t), path = await f.rollout.create({ metadata: f.metadata, history: f.history })
  const handle = await open(join(f.parent, 'rollback-prototype'), 'w')
  const prototype = Object.getPrototypeOf(handle) as { sync: (this: FileHandle) => Promise<void> }, sync = prototype.sync
  await handle.close()
  const controller = new AbortController()
  let calls = 0
  prototype.sync = async function () {
    await sync.call(this)
    calls++
    if (calls === 1) controller.abort()
    if (calls === 2) { await this.write(Buffer.from('CORRUPTED'), 0, 9, 0); await sync.call(this) }
  }
  try { await assert.rejects(f.rollout.appendStop(f.threadID, f.artifacts, controller.signal), { code: 'CODEX_ROLLOUT_RECOVERY_REQUIRED' }) } finally { prototype.sync = sync }
  assert.ok(f.rollout.inspect().uncertainBytes > 0)
  await assert.rejects(f.rollout.appendStop(f.threadID, f.artifacts), { code: 'CODEX_ROLLOUT_RECOVERY_REQUIRED' })
  assert.ok((await readFile(path, 'utf8')).startsWith('CORRUPTED'))
})

test('rejects contradictory native response and event payloads before any file mutation', async t => {
  const f = await fixture(t), path = await f.rollout.create({ metadata: f.metadata, history: f.history }), before = await readFile(path)
  for (const change of ['text', 'provenance', 'timing'] as const) {
    const artifacts = structuredClone(f.artifacts) as unknown as { response: { content: { text: string }[]; internal_chat_message_metadata_passthrough: { content_item_kinds: string[] } }; event: { completed_at_ms: number } }
    if (change === 'text') artifacts.response.content[0]!.text = 'Different'
    if (change === 'provenance') artifacts.response.internal_chat_message_metadata_passthrough.content_item_kinds[0] = 'text'
    if (change === 'timing') artifacts.event.completed_at_ms = -1
    await assert.rejects(f.rollout.appendStop(f.threadID, artifacts as unknown as CodexStopPromptArtifacts), /CODEX_ROLLOUT_/)
    assert.deepEqual(await readFile(path), before)
  }
})

test('reserves concurrent session capacity before asynchronous creation', async t => {
  const f = await fixture(t, { maxSessions: 1 })
  const otherID = '00000000-0000-4000-8000-000000000001'
  const results = await Promise.allSettled([f.rollout.create({ metadata: f.metadata, history: f.history }), f.rollout.create({ metadata: { ...f.metadata, id: otherID, session_id: otherID }, history: [] })])
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult
  assert.equal(rejected.reason.code, 'CODEX_ROLLOUT_LIMIT')
})

test('rejects mismatched Stop identities, closed turns and changed owned files before extending them', async t => {
  const f = await fixture(t), path = await f.rollout.create({ metadata: f.metadata, history: f.history })
  const before = await readFile(path)
  const foreign = { ...f.artifacts, event: { ...f.artifacts.event, thread_id: 'foreign' } }
  await assert.rejects(f.rollout.appendStop(f.threadID, foreign), { code: 'CODEX_ROLLOUT_IDENTITY_MISMATCH' })
  assert.deepEqual(await readFile(path), before)
  await f.rollout.appendHistory(f.threadID, [{ timestamp, type: 'event_msg', payload: { type: 'task_complete', turn_id: scenario.identity.turnID, last_agent_message: 'Answer' } }])
  await assert.rejects(f.rollout.appendStop(f.threadID, f.artifacts), { code: 'CODEX_ROLLOUT_TURN_UNAVAILABLE' })
  await assert.rejects(f.rollout.appendHistory(f.threadID, [{ timestamp, type: 'event_msg', payload: { type: 'task_started', turn_id: scenario.identity.turnID } }]), { code: 'CODEX_ROLLOUT_TURN_UNAVAILABLE' })
  await writeFile(path, 'PRIVATE_EXTERNAL_CHANGE')
  await assert.rejects(f.rollout.appendHistory(f.threadID, []), { code: 'CODEX_ROLLOUT_FILE_CHANGED' })
  assert.equal(await readFile(path, 'utf8'), 'PRIVATE_EXTERNAL_CHANGE')
})

test('bounds snapshots before serialization, rejects getters and snapshots input before asynchronous I/O', async t => {
  const f = await fixture(t)
  let reads = 0
  const metadata = { ...f.metadata }
  Object.defineProperty(metadata, 'originator', { enumerable: true, get() { reads++; return 'private' } })
  await assert.rejects(f.rollout.create({ metadata, history: f.history }), { code: 'CODEX_ROLLOUT_INPUT_INVALID' })
  assert.equal(reads, 0)
  const pending = f.rollout.create({ metadata: f.metadata, history: f.history })
  f.history[0] = { timestamp, type: 'event_msg', payload: { type: 'invalid' } }
  const path = await pending
  assert.equal(JSON.parse((await readFile(path, 'utf8')).split('\n')[1]!).payload.type, 'task_started')
  const small = await fixture(t, { maxSessionBytes: 256, maxTotalBytes: 512 })
  await assert.rejects(small.rollout.create({ metadata: { ...small.metadata, originator: 'x'.repeat(1024) }, history: [] }), { code: 'CODEX_ROLLOUT_LIMIT' })
  assert.equal(small.rollout.inspect().created, false)
})

test('pre-cancelled operations leave the rollout unchanged and disposal removes only owned state', async t => {
  const f = await fixture(t), sentinel = join(f.parent, 'keep')
  await writeFile(sentinel, 'keep')
  const path = await f.rollout.create({ metadata: f.metadata, history: f.history }), before = await readFile(path)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(f.rollout.appendStop(f.threadID, f.artifacts, controller.signal), { code: 'CODEX_ROLLOUT_CANCELLED' })
  assert.deepEqual(await readFile(path), before)
  await f.rollout.dispose()
  assert.equal(await readFile(sentinel, 'utf8'), 'keep')
  await assert.rejects(stat(path), { code: 'ENOENT' })
  await assert.rejects(f.rollout.appendStop(f.threadID, f.artifacts), { code: 'CODEX_ROLLOUT_CANCELLED' })
})

test('core Stop dispatch binds native inventory, compiles feedback and admits it to the real rollout', async t => {
  const f = await fixture(t), path = await f.rollout.create({ metadata: f.metadata, history: f.history })
  const declaration = JSON.parse(readFileSync(new URL('./fixtures/codex-stop-inventory-oracle.json', import.meta.url), 'utf8')).cases.find((row: { name: string }) => row.name === 'dispatch-feedback')
  const sourcePath = join(f.parent, 'hooks.json')
  await writeFile(sourcePath, JSON.stringify({ hooks: { Stop: [{ hooks: [declaration.handler] }] } }))
  const spec = { id: 'native', dialect: 'codex' as const, path: sourcePath }, sources = await loadSources([spec])
  const inventory = { data: [{ cwd: f.parent, errors: [], hooks: [{ key: sourcePath + ':stop:0:0', sourcePath, displayOrder: scenario.ordinals[0], eventName: 'stop', handlerType: 'command', command: declaration.handler.command, async: false, matcher: null, timeoutSec: 600, statusMessage: null, additionalContextLimit: null, currentHash: declaration.expected.currentHash, enabled: true, isManaged: false, source: 'user', pluginId: null, environmentId: null, trustStatus: 'untrusted' }] }] }
  const registrations = bindCodexStopInventory({ sources, nativeVersion: '0.167.0', cwd: f.parent, inventory })
  const runtime = await createRuntime('v2', f.parent, { sources: [spec], reviewedDigests: { native: sources[0]!.digest }, permissionMode: 'default' }, {
    report: () => {}, dispatchDiagnostic: () => {}, host: { environment: { SHELL: '/bin/sh' } },
    stop: { diagnostic: () => {}, async admit(delivery) {
      const artifacts = compileCodexStopPrompt({ dispatch: delivery.dispatch, sources, registrations, identity: { ...scenario.identity, messageID: 'msg_dispatched' } })!
      await f.rollout.appendStop(f.threadID, artifacts, delivery.signal)
    } },
  })
  t.after(() => runtime.dispose())
  runtime.sessions.prompt(f.threadID, scenario.identity.turnID, 'fixture')
  const receipt = await runtime.stop({ host: 'v2', event: 'Stop', sessionID: f.threadID, messageID: scenario.identity.turnID, completionID: 'completed', cwd: f.parent, data: { transcript_path: path, last_assistant_message: 'Answer' } })
  assert.equal(receipt.control, 'continue')
  const rows = (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(rows.at(-1).payload.item.fragments, [{ text: 'Inventory feedback', hookRunId: 'stop:' + scenario.ordinals[0] + ':' + sourcePath }])
})
