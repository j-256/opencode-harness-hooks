import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { BackgroundRecords } from '../src/background-records.js'
import { V1Background } from '../src/hosts/background-v1.js'
import { Sessions } from '../src/sessions.js'
import type { Registration } from '../src/types.js'
import type { BackgroundWork } from '../src/background-types.js'

const digest = 'a'.repeat(64)
const registration = (dialect: 'claude-code' | 'codex'): Registration => ({ id: dialect, sourceID: dialect, sourceDigest: digest, dialect, event: 'UserPromptSubmit', groupIndex: 0, handlerIndex: 0, handler: { type: 'command', command: 'fixture', async: true } })
async function fixture(t: { after(callback: () => unknown): void }, options: { checkpoint?: () => Promise<void>; toast?: (text: string) => Promise<void>; maxJobs?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'background-v1-')), sessions = new Sessions(), records = new BackgroundRecords(), diagnostics: unknown[] = [], checkpoints: unknown[] = []
  sessions.prompt('session', 'turn')
  const background = new V1Background({ records, state: { ensure: async () => {}, checkpoint: async session => { await options.checkpoint?.(); checkpoints.push(records.snapshotV1(session.sessionID)) } }, ...(options.toast ? { toast: options.toast } : {}), ...(options.maxJobs ? { maxJobs: options.maxJobs } : {}), diagnostic: row => { diagnostics.push(row) } })
  background.attach(sessions, [registration('claude-code'), registration('codex')])
  t.after(async () => { await background.dispose(); records.dispose(); sessions.dispose(); await rm(root, { recursive: true, force: true }) })
  const owner = () => sessions.get('session')
  const work = (dialect: 'claude-code' | 'codex', script: string): BackgroundWork => ({ registration: registration(dialect), event: { event: 'UserPromptSubmit', sessionID: 'session', cwd: root }, sessionSignal: owner().signal, invocation: { command: process.execPath, args: ['-e', script], cwd: root, env: { PATH: process.env.PATH }, stdin: '{}', timeoutMs: 5000 } })
  return { background, records, sessions, owner, work, diagnostics, checkpoints }
}
const context = `process.stdout.write('{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"MODEL_ONLY"}}')`
const warning = `process.stdout.write('{"systemMessage":"UI_ONLY","hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"MODEL_ONLY"}}')`
const anchor = { kind: 'prompt' as const, sessionID: 'session', turnID: 'turn', messageID: 'turn', signature: 'b'.repeat(64) }

test('default execution retains completed session-owned output without inference and binds only through the persistence barrier', async t => {
  const f = await fixture(t); assert.equal(f.background.supportsRewake, false)
  assert.equal(f.background.enqueue(f.work('claude-code', context)).status, 'accepted')
  await f.background.settled('session')
  assert.equal(f.records.read(f.owner()).length, 1); assert.equal(f.records.read(f.owner())[0]!.anchor, undefined); assert.ok(f.checkpoints.length > 0)
  await f.background.prepare(f.owner(), anchor, f.owner().turnSignal)
  assert.equal(f.records.read(f.owner())[0]!.anchor!.messageID, 'turn')
  assert.ok(JSON.stringify(f.checkpoints.at(-1)).includes('"messageID":"turn"'))
  assert.equal(JSON.stringify(f.diagnostics).includes('MODEL_ONLY'), false)
})

test('slow UI delivery stays independent of model context, and missing or rejected UI delivery retains retryable warnings', async t => {
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve }), seen: string[] = []
  const f = await fixture(t, { toast: async text => { seen.push(text); await held } })
  f.background.enqueue(f.work('codex', warning)); await f.background.completed('session')
  await f.background.prepare(f.owner(), anchor, f.owner().turnSignal)
  assert.deepEqual(f.records.read(f.owner())[0]!.model, ['MODEL_ONLY']); assert.deepEqual(f.records.warnings(f.owner())[0]!.texts, ['UI_ONLY'])
  release(); await f.background.settled('session'); assert.deepEqual(seen, ['UI_ONLY']); assert.deepEqual(f.records.warnings(f.owner()), [])
  const missing = await fixture(t); missing.background.enqueue(missing.work('codex', warning)); await missing.background.settled('session')
  assert.equal(missing.records.warnings(missing.owner()).length, 1); assert.ok(JSON.stringify(missing.diagnostics).includes('HOST_BACKGROUND_UI_UNAVAILABLE'))
  let refused = true
  const rejected = await fixture(t, { toast: async () => { if (refused) throw new Error('UI refused') } })
  rejected.background.enqueue(rejected.work('codex', warning)); await rejected.background.settled('session')
  assert.equal(rejected.records.warnings(rejected.owner()).length, 1)
  refused = false; await rejected.background.settled('session'); assert.deepEqual(rejected.records.warnings(rejected.owner()), [])
})

test('unreviewed commands, foreign session lifetimes and job overflow reject before spawning', async t => {
  const f = await fixture(t, { maxJobs: 1 }), held = f.work('claude-code', 'setTimeout(()=>{},2000)')
  assert.equal(f.background.enqueue({ ...held, registration: { ...held.registration, handler: { ...held.registration.handler, command: 'changed' } } }).status, 'unsupported')
  assert.equal(f.background.enqueue({ ...held, sessionSignal: new AbortController().signal }).status, 'unsupported')
  assert.equal(f.background.enqueue(held).status, 'accepted'); assert.equal(f.background.enqueue(held).code, 'HOST_BACKGROUND_LIMIT')
  f.sessions.close('session'); await f.background.removeSession('session'); assert.equal(f.background.inspect().jobs, 0)
  assert.equal(f.background.enqueue(held).status, 'unsupported')
})

test('turn cancellation does not discard completed ordinary session work, while deletion fences late completions', async t => {
  const f = await fixture(t), work = f.work('claude-code', `setTimeout(()=>{${context}},30)`)
  f.background.enqueue(work); f.sessions.prompt('session', 'next'); await f.background.settled('session')
  assert.equal(f.records.read(f.owner()).length, 1)
  const next = { ...anchor, turnID: 'next', messageID: 'next' }; await f.background.prepare(f.owner(), next, f.owner().turnSignal)
  await f.background.removeSession('session'); assert.equal(f.records.inspect().records, 0)
  assert.throws(() => f.records.read(f.owner()), { code: 'BACKGROUND_SESSION_CLOSED' })
})

test('failed persistence leaves the manager delivery retryable and never commits a model anchor', async t => {
  let fail = true
  const f = await fixture(t, { checkpoint: async () => { if (fail) throw new Error('Checkpoint failed') } })
  f.background.enqueue(f.work('claude-code', context)); await f.background.settled('session')
  assert.equal(f.records.read(f.owner())[0]!.anchor, undefined)
  await assert.rejects(f.background.prepare(f.owner(), anchor, f.owner().turnSignal))
  assert.equal(f.records.read(f.owner())[0]!.anchor, undefined)
  fail = false; await f.background.prepare(f.owner(), anchor, f.owner().turnSignal)
  assert.equal(f.records.read(f.owner()).length, 1); assert.equal(f.records.read(f.owner())[0]!.anchor!.messageID, 'turn')
})

test('a completed job awaiting failed durable retention still occupies the global admission budget', async t => {
  const f = await fixture(t, { maxJobs: 1, checkpoint: async () => { throw new Error('Checkpoint failed') } })
  f.background.enqueue(f.work('claude-code', context)); await f.background.completed('session')
  assert.equal(f.background.enqueue(f.work('claude-code', context)).code, 'HOST_BACKGROUND_LIMIT')
  assert.equal(f.background.inspect().jobs, 1)
})

test('session removal cancels a held UI operation and drains every owned task', { timeout: 2000 }, async t => {
  let started!: () => void; const readiness = new Promise<void>(resolve => { started = resolve })
  const f = await fixture(t, { toast: async () => { started(); await new Promise(() => {}) } })
  f.background.enqueue(f.work('codex', warning)); await f.background.completed('session'); await readiness
  await f.background.removeSession('session'); assert.equal(f.background.inspect().pending, 0); assert.equal(f.background.inspect().ui, 0)
})

test('UI completions arriving during a held earlier warning deliver after it without needing another model turn', async t => {
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve }), seen: string[] = []
  const f = await fixture(t, { toast: async text => { seen.push(text); if (seen.length === 1) await held } })
  f.background.enqueue(f.work('codex', warning)); await f.background.completed('session')
  f.background.enqueue(f.work('codex', warning)); await f.background.completed('session')
  release(); await f.background.settled('session')
  assert.deepEqual(seen, ['UI_ONLY', 'UI_ONLY']); assert.deepEqual(f.records.warnings(f.owner()), [])
})

test('a caller cannot bind completed output using a substituted current-turn lifetime', async t => {
  const f = await fixture(t); f.background.enqueue(f.work('claude-code', context)); await f.background.completed('session')
  await assert.rejects(f.background.prepare({ ...f.owner(), turnSignal: new AbortController().signal }, anchor, f.owner().turnSignal), { code: 'HOST_BACKGROUND_OWNER_MISMATCH' })
  assert.equal(f.records.read(f.owner())[0]!.anchor, undefined)
})
