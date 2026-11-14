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
import { V1SessionState } from '../src/hosts/session-state-v1.js'
import { SessionStore } from '../src/session-store.js'

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

test('cancelled model admission fences an in-flight real checkpoint and durably releases its anchor before retry', async t => {
  for (const cancellation of ['request', 'turn']) {
    const root = await mkdtemp(join(tmpdir(), 'background-binding-cancel-')), sessions = new Sessions(), records = new BackgroundRecords()
    sessions.prompt('session', 'turn')
    const store = new SessionStore({ directory: join(root, 'state'), project: root, host: 'v1', diagnostic: () => {} })
    const state = new V1SessionState(store, { background: records }), background = new V1Background({ records, state, diagnostic: () => {} })
    background.attach(sessions, [registration('claude-code')])
    let release!: () => void, entered!: () => void, finished!: () => void
    const held = new Promise<void>(resolve => { release = resolve }), ready = new Promise<void>(resolve => { entered = resolve }), written = new Promise<void>(resolve => { finished = resolve })
    t.after(async () => { release(); await background.dispose(); await state.dispose(); records.dispose(); sessions.dispose(); await rm(root, { recursive: true, force: true }) })
    const session = sessions.get('session'); await state.ensure(session)
    records.admit(session, { id: 'completed', sourceID: 'claude-code', sourceDigest: digest, registrationID: 'claude-code', dialect: 'claude-code', event: 'UserPromptSubmit', mode: 'safe-point', actions: [], completion: { completedAt: 1, execution: { status: 'exited', exitCode: 0, signal: null, stdout: '{"systemMessage":"RETAINED"}', stderr: '', durationMs: 1, processID: 123 } } })
    await state.checkpoint(session)
    const save = store.save.bind(store)
    let blocked = false
    store.save = async (receipt, payload, signal) => {
      const hold = !blocked && JSON.stringify(payload).includes('"messageID":"turn"')
      if (hold) { blocked = true; entered(); await held }
      try { return await save(receipt, payload, signal) } finally { if (hold) finished() }
    }
    const request = new AbortController(); let settled = false
    const admission = background.prepare(session, anchor, request.signal).then(() => { settled = true; return 'accepted' }, error => { settled = true; return error.code })
    await ready
    if (cancellation === 'turn') sessions.prompt('session', 'next'); else request.abort()
    await new Promise(resolve => setImmediate(resolve))
    const releasedBeforeWriteFinished = settled
    release(); assert.match(await admission, /^(?:HOST_BACKGROUND_CANCELLED|EXECUTION_CANCELLED)$/); await written
    const cold = new BackgroundRecords(), readback = await store.load('session')
    cold.restoreV1(sessions.get('session'), readback.payload!.background)
    const coldAnchor = cold.read(sessions.get('session'))[0]!.anchor; cold.dispose()
    assert.equal(records.read(sessions.get('session'))[0]!.anchor, undefined); assert.equal(coldAnchor, undefined)
    assert.equal(releasedBeforeWriteFinished, false)
    const next = sessions.get('session'), nextAnchor = { ...anchor, turnID: next.turnID!, messageID: next.turnID! }
    await background.prepare(next, nextAnchor, next.turnSignal)
    assert.equal(records.read(next)[0]!.anchor!.messageID, next.turnID)
  }
})

test('failed durable cancellation rollback rejects model admission with an actionable diagnostic and retains pending context', async t => {
  let entered!: () => void, release!: () => void, refuseRollback = false
  const ready = new Promise<void>(resolve => { entered = resolve }), held = new Promise<void>(resolve => { release = resolve })
  const f = await fixture(t, { checkpoint: async () => {
    if (refuseRollback) throw new Error('Store unavailable')
    if (f.records.inspect().pendingBindings) { entered(); await held; refuseRollback = true }
  } })
  f.background.enqueue(f.work('claude-code', context)); await f.background.settled('session')
  const request = new AbortController(), admission = f.background.prepare(f.owner(), anchor, request.signal)
  await ready; request.abort(); release()
  await assert.rejects(admission, { code: 'HOST_BACKGROUND_BINDING_ROLLBACK_FAILED' })
  assert.equal(f.records.read(f.owner())[0]!.anchor, undefined)
  assert.deepEqual(f.records.read(f.owner())[0]!.model, ['<system-reminder>\nMODEL_ONLY\n</system-reminder>'])
  assert.ok(JSON.stringify(f.diagnostics).includes('HOST_BACKGROUND_BINDING_ROLLBACK_FAILED'))
  await assert.rejects(f.background.prepare(f.owner(), anchor, f.owner().turnSignal))
})

test('an owned wake receiver acknowledges durable completion without waiting for a model and shares registration bounds', async t => {
  const sessions = new Sessions(), records = new BackgroundRecords(), wakes = new (await import('../src/wake-records.js')).WakeRecords(), received: unknown[] = []
  sessions.prompt('session', 'turn')
  const source = { ...registration('claude-code'), handler: { type: 'command' as const, command: 'wake', asyncRewake: true } }
  const background = new V1Background({ records, state: { ensure: async () => {}, checkpoint: async () => {} }, diagnostic: () => {}, wakes: { records: wakes, receive: async notice => { wakes.admit(sessions.get(notice.sessionID), notice.delivery); received.push(notice.delivery) } } })
  background.attach(sessions, [source]); t.after(async () => { await background.dispose(); records.dispose(); wakes.dispose(); sessions.dispose() })
  assert.equal(background.supportsRewake, true)
  const work: BackgroundWork = { registration: source, event: { host: 'v1', event: 'UserPromptSubmit', sessionID: 'session', cwd: process.cwd() }, sessionSignal: sessions.get('session').signal, invocation: { command: process.execPath, args: ['-e', "process.stderr.write('WAKE');process.exitCode=2"], cwd: process.cwd(), env: {}, stdin: '{}', timeoutMs: 5000 } }
  assert.equal(background.enqueue({ ...work, registration: { ...source, handler: { ...source.handler, command: 'changed' } } }).status, 'unsupported')
  assert.equal(background.enqueue(work).status, 'accepted'); await background.completed('session')
  assert.equal(received.length, 1); assert.equal(wakes.read(sessions.get('session')).length, 1); assert.equal(records.read(sessions.get('session')).length, 0)
  assert.equal(background.inspect().jobs, 0)
})
