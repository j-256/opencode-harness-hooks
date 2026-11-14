import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { V1WakeIdle } from '../src/hosts/wake-idle-v1.js'
import { V1WakeInputs } from '../src/hosts/wake-inputs-v1.js'
import { V1Wake } from '../src/hosts/wake-v1.js'
import { WakeRecords } from '../src/wake-records.js'
import { Sessions } from '../src/sessions.js'
import type { BackgroundDelivery } from '../src/background-types.js'
import type { Registration } from '../src/types.js'
import type { DispatchResult } from '../src/engine.js'
import { executeRegistration } from '../src/handlers.js'

const model = { providerID: 'fixture', modelID: 'model', variant: 'low' }, original = { info: { id: 'turn', sessionID: 'session', role: 'user', agent: 'build', model, time: { created: 1700000000000 } }, parts: [{ id: 'original', type: 'text', text: 'GENUINE' }] }
const source: Registration = { id: 'wake', sourceID: 'source', sourceDigest: 'a'.repeat(64), dialect: 'claude-code', event: 'UserPromptSubmit', groupIndex: 0, handlerIndex: 0, handler: { type: 'command', command: 'owned', asyncRewake: true } }
const delivery: BackgroundDelivery = { id: 'job', sourceID: 'source', sourceDigest: source.sourceDigest!, registrationID: 'wake', dialect: 'claude-code', event: 'UserPromptSubmit', mode: 'wake', actions: [{ kind: 'native-extension', name: 'asyncRewake', value: 'WAKE' }], completion: { completedAt: 1700000000001, execution: { status: 'exited', exitCode: 2, signal: null, stdout: '', stderr: 'WAKE', durationMs: 1, processID: 123 } } }
async function fixture(t: { after(callback: () => unknown): void }, output: object = {}) {
  const sessions = new Sessions(), records = new WakeRecords({ registrations: [source] }), inputs = new V1WakeInputs(), requests: unknown[] = [], history: unknown[] = [structuredClone(original)], events: string[] = [], writes: unknown[] = [], diagnostics: unknown[] = []
  sessions.prompt('session', 'turn', 'model')
  let beforeIssue: (() => Promise<void> | void) | undefined, beforeResuming: (() => Promise<void> | void) | undefined
  const state = { ensure: async () => {}, checkpoint: async () => {
    writes.push({ wakes: records.snapshotV1('session'), inputs: inputs.snapshotV1('session') })
    const rows = inputs.read(sessions.get('session'))
    if (beforeIssue && rows.some(row => row.phase === 'issued')) { const run = beforeIssue; beforeIssue = undefined; await run() }
    if (beforeResuming && rows.some(row => row.phase === 'resuming')) { const run = beforeResuming; beforeResuming = undefined; await run() }
  } }
  const wake = new V1Wake({ records, state, diagnostic: value => diagnostics.push(value) })
  wake.attach(sessions, { notification: async event => {
    events.push(event.messageID)
    const callback = { ...source, id: 'callback', handler: { type: 'command' as const, command: "printf '%s' '" + JSON.stringify(output) + "'" } }
    const result = await executeRegistration(callback, { host: 'v1', event: 'UserPromptSubmit', sessionID: 'session', cwd: process.cwd(), data: { prompt: event.prompt, transcript_path: 'notification.jsonl', permission_mode: 'default' } }, { projectRoot: process.cwd(), environment: {}, captureCommandArtifacts: true })
    const origin = { sourceID: source.sourceID, sourceDigest: source.sourceDigest!, registrationID: callback.id, dialect: source.dialect, configuredOrder: 0, completionOrder: 0 }
    const dispatched: DispatchResult = { entries: [{ ...origin, result }], actions: result.actions.map(action => ({ ...origin, action })), cancelled: false, diagnostic: { dispatchID: 'dispatch', sessionID: 'session', event: 'UserPromptSubmit', durationMs: 0, cancelled: false, failed: 0, unsupported: 0, skipped: 0, background: 0, handlers: [] } }
    await wake.capture(event, sessions.get('session'), dispatched, sessions.get('session').signal); return dispatched
  } })
  let beforeResume: (() => void) | undefined, beforeRequest: (() => Promise<void>) | undefined
  const idle = new V1WakeIdle({ records, inputs, sessions, wake, state, diagnostic: value => diagnostics.push(value), history: async () => history, prompt: async (_session, body) => {
    requests.push(body)
    if (beforeRequest) { const run = beforeRequest; beforeRequest = undefined; await run() }
    const info = { ...structuredClone(original.info), id: 'system', time: { created: 1700000000002 } }, parts = body.parts.map(part => ({ ...part, id: 'notification' }))
    try { await idle.message('session', info, parts) } catch (error) { return { error } }
    const raw = { info, parts }, index = history.findIndex(value => (value as typeof raw).info.id === info.id)
    if (index < 0) history.push(raw); else history[index] = raw
    if (body.noReply) beforeResume?.()
    return { data: body.noReply ? raw : { info: { role: 'assistant' }, parts: [{ type: 'text', text: 'DONE' }] } }
  } })
  t.after(async () => { await idle.dispose(); await wake.dispose(); records.dispose(); inputs.dispose(); sessions.dispose() })
  await wake.receive({ sessionID: 'session', delivery, signal: sessions.get('session').signal })
  return { sessions, records, inputs, idle, wake, requests, events, history, writes, diagnostics, beforeResume: (run: () => void) => { beforeResume = run }, beforeIssue: (run: () => Promise<void> | void) => { beforeIssue = run }, beforeResuming: (run: () => Promise<void> | void) => { beforeResuming = run }, beforeRequest: (run: () => Promise<void>) => { beforeRequest = run } }
}

test('idle delivery saves actual SDK identities before resuming one non-human model turn with the same part and variant', async t => {
  const f = await fixture(t); f.idle.event('session.idle', { sessionID: 'session' }); await f.idle.settled('session')
  assert.equal(f.requests.length, 2); assert.deepEqual(f.events, ['system']); assert.equal(f.history.length, 2)
  const [save, resume] = f.requests as { noReply?: boolean; messageID?: string; variant?: string; parts: { id?: string; text: string; synthetic: boolean }[] }[]
  assert.equal(save!.noReply, true); assert.equal(save!.messageID, undefined); assert.equal(resume!.messageID, 'system'); assert.equal(resume!.parts[0]!.id, 'notification'); assert.equal(resume!.variant, 'low')
  assert.equal(save!.parts[0]!.synthetic, true); assert.equal(resume!.parts[0]!.text, save!.parts[0]!.text)
  const session = f.sessions.get('session'), input = f.inputs.read(session)[0]!
  assert.equal(input.phase, 'finished'); assert.equal(input.promptIndex, 0); assert.equal(input.turnIndex, 2)
  assert.equal(f.records.read(session)[0]!.binding!.placement.kind, 'system')
  assert.equal((f.history[1] as typeof original).parts[0]!.text, save!.parts[0]!.text)
})

for (const output of [{ continue: false, stopReason: 'STOPPED' }, { continue: false }]) test(`idle terminal notification saves history and starts no model request: ${JSON.stringify(output)}`, async t => {
  const f = await fixture(t, output); f.idle.event('session.idle', { sessionID: 'session' }); await f.idle.settled('session')
  assert.equal(f.requests.length, 1); assert.equal(f.history.length, 2); assert.equal(f.inputs.read(f.sessions.get('session'))[0]!.phase, 'finished')
  assert.deepEqual(JSON.parse(JSON.stringify(f.records.read(f.sessions.get('session'))[0]!.binding!.feedback!.body.message)), { role: 'user', content: 'Operation stopped by hook' + ('stopReason' in output ? ': STOPPED' : '') })
})

test('an idle callback block consumes its receipt before persistence and does not save a rejected notification', async t => {
  const f = await fixture(t, { decision: 'block', reason: 'DENIED' }); f.idle.event('session.idle', { sessionID: 'session' }); await f.idle.settled('session')
  assert.equal(f.requests.length, 1); assert.equal(f.history.length, 1); assert.equal(f.records.read(f.sessions.get('session'))[0]!.attempts[0]!.result!.outcome, 'block')
  assert.equal(f.inputs.read(f.sessions.get('session'))[0]!.phase, 'failed')
  f.idle.event('session.idle', { sessionID: 'session' }); await f.idle.settled('session'); assert.equal(f.requests.length, 1)
})

test('a genuine input after the SDK save prevents wake model resumption while preserving the saved non-human context', async t => {
  const f = await fixture(t); f.beforeResume(() => { f.sessions.prompt('session', 'new-turn', 'model'); f.idle.busy('session') })
  f.idle.event('session.idle', { sessionID: 'session' }); await f.idle.settled('session')
  assert.equal(f.requests.length, 1); assert.equal(f.events.length, 1); assert.equal(f.sessions.get('session').turnID, 'new-turn')
  assert.equal(f.history.length, 2); assert.ok(f.records.read(f.sessions.get('session'))[0]!.binding)
  assert.equal(f.inputs.read(f.sessions.get('session'))[0]!.phase, 'saved')
})

for (const newerPrompt of [false, true]) test(`a cancelled unsent wake ticket is durably released before retry, newer prompt ${newerPrompt}`, async t => {
  const f = await fixture(t)
  let entered!: () => void, release!: () => void
  const waiting = new Promise<void>(resolve => { entered = resolve }), hold = new Promise<void>(resolve => { release = resolve })
  f.beforeIssue(async () => { entered(); await hold })
  f.idle.event('session.idle', { sessionID: 'session' }); await waiting
  f.idle.busy('session')
  if (newerPrompt) { f.sessions.prompt('session', 'new-turn', 'model'); f.history.push({ ...structuredClone(original), info: { ...structuredClone(original.info), id: 'new-turn' } }) }
  assert.equal(f.requests.length, 0); assert.equal(f.inputs.read(f.sessions.get('session')).length, 1)
  release(); await f.idle.settled('session')
  assert.equal(f.requests.length, 0); assert.equal(f.inputs.read(f.sessions.get('session')).length, 0)
  assert.equal((f.writes.at(-1) as any).inputs.rows.length, 0); assert.equal(f.records.read(f.sessions.get('session'))[0]!.attempts.length, 0)
  f.idle.event('session.idle', { sessionID: 'session' }); await f.idle.settled('session')
  assert.equal(f.requests.length, 2); assert.equal(f.events.length, 1); assert.equal(f.inputs.read(f.sessions.get('session'))[0]!.phase, 'finished')
})

test('an idle event for a newer genuine input is not lost behind the previous unsent ticket checkpoint', async t => {
  const f = await fixture(t)
  let entered!: () => void, release!: () => void
  const waiting = new Promise<void>(resolve => { entered = resolve }), hold = new Promise<void>(resolve => { release = resolve })
  f.beforeIssue(async () => { entered(); await hold })
  f.idle.event('session.idle', { sessionID: 'session' }); await waiting
  f.idle.busy('session'); f.sessions.prompt('session', 'new-turn', 'model'); f.history.push({ ...structuredClone(original), info: { ...structuredClone(original.info), id: 'new-turn' } })
  f.idle.event('session.idle', { sessionID: 'session' }); release(); await f.idle.settled('session')
  assert.equal(f.requests.length, 2); assert.equal(f.events.length, 1); assert.equal(f.inputs.read(f.sessions.get('session'))[0]!.phase, 'finished')
})

test('a submitted request with an unresolved SDK claim retains its ticket and never blindly retries', async t => {
  const f = await fixture(t)
  let entered!: () => void, release!: () => void
  const waiting = new Promise<void>(resolve => { entered = resolve }), hold = new Promise<void>(resolve => { release = resolve })
  f.beforeRequest(async () => { entered(); await hold })
  f.idle.event('session.idle', { sessionID: 'session' }); await waiting
  f.idle.busy('session'); f.sessions.prompt('session', 'new-turn', 'model'); release(); await f.idle.settled('session')
  assert.equal(f.requests.length, 1); assert.equal(f.events.length, 0); assert.equal(f.inputs.read(f.sessions.get('session'))[0]!.phase, 'issued')
  f.idle.event('session.idle', { sessionID: 'session' }); await f.idle.settled('session')
  assert.equal(f.requests.length, 1); assert.ok((f.diagnostics as { code: string }[]).some(row => row.code === 'HOST_WAKE_IDLE_UNRESOLVED'))
})

test('a newer genuine input during the resume checkpoint leaves saved context without an unsent resume claim', async t => {
  const f = await fixture(t)
  let entered!: () => void, release!: () => void
  const waiting = new Promise<void>(resolve => { entered = resolve }), hold = new Promise<void>(resolve => { release = resolve })
  f.beforeResuming(async () => { entered(); await hold })
  f.idle.event('session.idle', { sessionID: 'session' }); await waiting
  f.idle.busy('session'); f.sessions.prompt('session', 'new-turn', 'model'); release(); await f.idle.settled('session')
  assert.equal(f.requests.length, 1); assert.equal(f.events.length, 1); assert.equal(f.history.length, 2)
  assert.equal(f.inputs.read(f.sessions.get('session'))[0]!.phase, 'saved')
  assert.equal((f.writes.at(-1) as any).inputs.rows[0].phase, 'saved'); assert.ok(f.records.read(f.sessions.get('session'))[0]!.binding)
})

test('an already submitted resume with no SDK acknowledgement stays unresolved and reports its retained ownership', async t => {
  const f = await fixture(t)
  let entered!: () => void, release!: () => void
  const waiting = new Promise<void>(resolve => { entered = resolve }), hold = new Promise<void>(resolve => { release = resolve })
  f.beforeResume(() => f.beforeRequest(async () => { entered(); await hold }))
  f.idle.event('session.idle', { sessionID: 'session' }); await waiting
  f.idle.busy('session'); f.sessions.prompt('session', 'new-turn', 'model'); release(); await f.idle.settled('session')
  assert.equal(f.requests.length, 2); assert.equal(f.events.length, 1); assert.equal(f.inputs.read(f.sessions.get('session'))[0]!.phase, 'resuming')
  f.idle.event('session.idle', { sessionID: 'session' }); await f.idle.settled('session')
  assert.equal(f.requests.length, 2); assert.ok((f.diagnostics as { code: string }[]).some(row => row.code === 'HOST_WAKE_IDLE_UNRESOLVED'))
})

test('a source stopped at an active tool is reevaluated once at idle with a fresh host prompt identity', async t => {
  const f = await fixture(t, { continue: false, stopReason: 'STOPPED' }), owner = f.sessions.get('session')
  await f.wake.prepare(owner, { kind: 'tool', sessionID: 'session', turnID: 'turn', messageID: 'answer', callID: 'call', signature: createHash('sha256').update('RESULT').digest('hex') }, owner.turnSignal)
  f.idle.event('session.idle', { sessionID: 'session' }); await f.idle.settled('session')
  assert.deepEqual(f.events, ['turn', 'system']); assert.equal(f.requests.length, 1); assert.equal(f.records.read(f.sessions.get('session'))[0]!.attempts.length, 2)
})
