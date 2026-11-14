import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { V1Wake } from '../src/hosts/wake-v1.js'
import { WakeRecords } from '../src/wake-records.js'
import { Sessions } from '../src/sessions.js'
import { executeRegistration } from '../src/handlers.js'
import type { Registration } from '../src/types.js'
import type { BackgroundDelivery } from '../src/background-types.js'
import type { HostNotificationEvent } from '../src/notification.js'
import type { DispatchResult } from '../src/engine.js'

const source: Registration = { id: 'wake', sourceID: 'source', sourceDigest: 'a'.repeat(64), dialect: 'claude-code', event: 'UserPromptSubmit', groupIndex: 0, handlerIndex: 0, handler: { type: 'command', command: 'owned', asyncRewake: true } }
const delivery: BackgroundDelivery = { id: 'job', sourceID: 'source', sourceDigest: source.sourceDigest!, registrationID: 'wake', dialect: 'claude-code', event: 'UserPromptSubmit', mode: 'wake', actions: [{ kind: 'native-extension', name: 'asyncRewake', value: 'WAKE' }], completion: { completedAt: 1700000000000, execution: { status: 'exited', exitCode: 2, signal: null, stdout: '', stderr: 'WAKE', durationMs: 1, processID: 123 } } }
async function dispatch(event: HostNotificationEvent, output: object): Promise<DispatchResult> {
  const callback = { ...source, id: 'callback', handler: { type: 'command' as const, command: "printf '%s' '" + JSON.stringify(output) + "'" } }
  const result = await executeRegistration(callback, { host: 'v1', event: 'UserPromptSubmit', sessionID: 'session', cwd: process.cwd(), data: { prompt: event.prompt, transcript_path: '/tmp/notification', permission_mode: 'default' } }, { projectRoot: process.cwd(), environment: {}, captureCommandArtifacts: true })
  const origin = { sourceID: source.sourceID, sourceDigest: source.sourceDigest!, registrationID: callback.id, dialect: source.dialect, configuredOrder: 0, completionOrder: 0 }
  return { entries: [{ ...origin, result }], actions: result.actions.map(action => ({ ...origin, action })), cancelled: false, diagnostic: { dispatchID: 'dispatch', sessionID: 'session', event: 'UserPromptSubmit', durationMs: 0, cancelled: false, failed: 0, unsupported: 0, skipped: 0, background: 0, handlers: [] } }
}
function fixture(t: { after(callback: () => unknown): void }, output: object = {}, toast?: (text: string, session: import('../src/sessions.js').SessionSnapshot, signal: AbortSignal) => Promise<void>) {
  const sessions = new Sessions(), records = new WakeRecords({ registrations: [source] }), writes: unknown[] = [], events: HostNotificationEvent[] = [], diagnostics: unknown[] = []
  sessions.prompt('session', 'turn', 'model')
  const session = sessions.get('session'), anchor = { kind: 'tool' as const, sessionID: 'session', turnID: 'turn', messageID: 'answer', callID: 'call', signature: createHash('sha256').update('ORIGINAL').digest('hex') }
  let checkpoint: () => Promise<void> = async () => { writes.push(records.snapshotV1('session')) }
  const wake = new V1Wake({ records, state: { ensure: async () => {}, checkpoint: async () => checkpoint() }, diagnostic: value => diagnostics.push(value), ...(toast ? { toast } : {}) })
  wake.attach(sessions, { notification: async event => { events.push(event); const result = await dispatch(event, output); await wake.capture(event, sessions.get('session'), result, session.signal); return result } })
  t.after(async () => { await wake.dispose(); records.dispose(); sessions.dispose() })
  return { sessions, records, writes, events, diagnostics, session, anchor, wake, checkpoint: (value: () => Promise<void>) => { checkpoint = value } }
}

test('a received wake persists before acknowledgement and active admission binds one source callback to the original turn', async t => {
  const f = fixture(t, { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'CALLBACK' } })
  await f.wake.receive({ sessionID: 'session', delivery, signal: f.session.signal })
  assert.equal(f.writes.length, 1); assert.equal(f.events.length, 0)
  await f.wake.prepare(f.session, f.anchor, f.session.turnSignal)
  assert.equal(f.events.length, 1); assert.equal(f.events[0]!.messageID, 'turn'); assert.equal(f.events[0]!.anchor, f.anchor)
  assert.equal(f.records.read(f.session)[0]!.binding!.placement.kind, 'queued')
  assert.ok(f.records.read(f.session)[0]!.binding!.model.join().includes('CALLBACK'))
  assert.equal(f.sessions.get('session').turnID, 'turn'); assert.equal(f.session.turnSignal.aborted, false)
  await f.wake.prepare(f.session, f.anchor, f.session.turnSignal); await f.wake.receive({ sessionID: 'session', delivery, signal: f.session.signal })
  assert.equal(f.events.length, 1)
})

for (const output of [{ decision: 'block', reason: 'DENIED' }, { continue: false, stopReason: 'STOPPED' }]) test(`active ${JSON.stringify(output)} consumes only the notification and leaves the genuine turn running`, async t => {
  const f = fixture(t, output); await f.wake.receive({ sessionID: 'session', delivery, signal: f.session.signal }); await f.wake.prepare(f.session, f.anchor, f.session.turnSignal)
  assert.equal(f.records.read(f.session)[0]!.binding, undefined)
  assert.equal(f.records.read(f.session)[0]!.attempts[0]!.result!.outcome, 'decision' in output ? 'block' : 'stop')
  assert.equal(f.session.turnSignal.aborted, false); assert.equal(f.sessions.get('session').turnID, 'turn')
  await f.wake.prepare(f.session, f.anchor, f.session.turnSignal); assert.equal(f.events.length, 1)
})

test('a failed capture write retains the callback receipt and refuses to execute it again', async t => {
  const f = fixture(t); await f.wake.receive({ sessionID: 'session', delivery, signal: f.session.signal })
  let writes = 0; f.checkpoint(async () => { if (++writes === 2) throw new Error('Capture write failed') })
  await assert.rejects(f.wake.prepare(f.session, f.anchor, f.session.turnSignal), /Capture write failed/)
  assert.equal(f.events.length, 1); assert.ok(f.records.read(f.session)[0]!.attempts[0]!.result)
  await f.wake.prepare(f.session, f.anchor, f.session.turnSignal)
  assert.equal(f.events.length, 1); assert.ok(f.records.read(f.session)[0]!.binding)
})

test('a cancelled binding drains its owned write before compensating and cannot publish a future artifact', async t => {
  const f = fixture(t); await f.wake.receive({ sessionID: 'session', delivery, signal: f.session.signal })
  let writes = 0, release!: () => void, entered!: () => void
  const held = new Promise<void>(resolve => { release = resolve }), started = new Promise<void>(resolve => { entered = resolve })
  f.checkpoint(async () => { if (++writes === 3) { entered(); await held } })
  const preparation = f.wake.prepare(f.session, f.anchor, f.session.turnSignal); await started
  f.sessions.prompt('session', 'new-turn', 'model')
  let settled = false; void preparation.catch(() => { settled = true })
  await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false)
  release(); await assert.rejects(preparation, { code: 'HOST_WAKE_CANCELLED' })
  assert.equal(f.records.read(f.sessions.get('session'))[0]!.binding, undefined); assert.equal(writes, 4)
})

test('an unresolved persisted source attempt reports ambiguity without executing the source again', async t => {
  const f = fixture(t); await f.wake.receive({ sessionID: 'session', delivery, signal: f.session.signal })
  f.records.begin(f.session, 'job', f.anchor)
  await assert.rejects(f.wake.prepare(f.session, f.anchor, f.session.turnSignal), { code: 'HOST_WAKE_ATTEMPT_UNRESOLVED' })
  assert.equal(f.events.length, 0)
})

test('held UI stays separate from model admission and is acknowledged only after delivery', { timeout: 2000 }, async t => {
  let release!: () => void, entered!: () => void; const held = new Promise<void>(resolve => { release = resolve }), ready = new Promise<void>(resolve => { entered = resolve }), seen: string[] = []
  const f = fixture(t, { systemMessage: 'UI_ONLY' }, async text => { seen.push(text); entered(); await held })
  t.after(() => release())
  await f.wake.receive({ sessionID: 'session', delivery, signal: f.session.signal }); await f.wake.prepare(f.session, f.anchor, f.session.turnSignal); await ready
  assert.equal(f.records.read(f.session)[0]!.binding!.model.some(text => text.includes('UI_ONLY')), false)
  assert.equal(f.records.warnings(f.session).length, 1)
  release(); await f.wake.settled('session'); assert.deepEqual(seen, ['UI_ONLY']); assert.deepEqual(f.records.warnings(f.session), [])
  await f.wake.resume(f.session); await f.wake.settled('session'); assert.deepEqual(seen, ['UI_ONLY']); assert.equal(f.events.length, 1)
})

test('a rejected notification UI channel retries from retained output without source execution', { timeout: 2000 }, async t => {
  let refuse = true; const seen: string[] = [], f = fixture(t, { systemMessage: 'RETAINED_UI' }, async text => { if (refuse) throw new Error('Unavailable'); seen.push(text) })
  await f.wake.receive({ sessionID: 'session', delivery, signal: f.session.signal }); await f.wake.prepare(f.session, f.anchor, f.session.turnSignal); await f.wake.settled('session')
  assert.equal(f.records.warnings(f.session).length, 1); assert.ok(JSON.stringify(f.diagnostics).includes('HOST_WAKE_UI_FAILED'))
  refuse = false; await f.wake.resume(f.session); await f.wake.settled('session')
  assert.deepEqual(seen, ['RETAINED_UI']); assert.equal(f.events.length, 1); assert.equal(f.records.warnings(f.session).length, 0)
})

test('session removal cancels a held UI operation and drains its work without acknowledgement', { timeout: 2000 }, async t => {
  let entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve })
  const f = fixture(t, { systemMessage: 'UI_ONLY' }, async () => { entered(); await new Promise(() => {}) })
  await f.wake.receive({ sessionID: 'session', delivery, signal: f.session.signal }); await f.wake.prepare(f.session, f.anchor, f.session.turnSignal); await ready
  await f.wake.removeSession('session'); assert.equal(f.wake.inspect().ui, 0); assert.equal(f.records.warnings(f.session).length, 1)
  assert.ok(JSON.stringify(f.diagnostics).includes('HOST_WAKE_CANCELLED'))
})
