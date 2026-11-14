import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../src/runtime.js'
import type { HostNotificationEvent, NotificationServices } from '../src/notification.js'

const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'"
async function fixture(t: { after(callback: () => unknown): void }, output = '') {
  const directory = await mkdtemp(join(tmpdir(), 'notification-runtime-')), recorder = join(directory, 'record.cjs'), path = join(directory, 'trace.jsonl'), journal = join(directory, 'journal.jsonl')
  t.after(() => rm(directory, { recursive: true, force: true }))
  await writeFile(recorder, `const fs=require('node:fs');const p=JSON.parse(fs.readFileSync(0,'utf8'));fs.appendFileSync(${JSON.stringify(path)},JSON.stringify(p)+String.fromCharCode(10));process.stdout.write(${JSON.stringify(output)})`)
  const command = [process.execPath, recorder].map(quote).join(' '), text = JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command }] }], PreToolUse: [{ hooks: [{ type: 'command', command }] }] } })
  await writeFile(join(directory, 'hooks.json'), text); await writeFile(journal, '')
  return { directory, path, journal, options: { sources: [{ id: 'native', dialect: 'claude-code', path: 'hooks.json' }], reviewedDigests: { native: createHash('sha256').update(text).digest('hex') }, permissionMode: 'default' } }
}
const event = (signal: AbortSignal): HostNotificationEvent => ({ host: 'v1', event: 'UserPromptSubmit', sessionID: 'session', messageID: 'turn', prompt: 'OWNED_SYSTEM_NOTIFICATION', signal, notificationID: 'delivery', anchor: { kind: 'tool', sessionID: 'session', turnID: 'turn', messageID: 'assistant', callID: 'call', signature: 'a'.repeat(64) } })

test('active notifications dispatch native prompt callbacks on the owned turn without invoking genuine admission or cancelling tools', async t => {
  const f = await fixture(t), calls: string[] = []
  const runtime = await createRuntime('v1', f.directory, f.options, { report: () => {}, dispatchDiagnostic: () => {}, transcripts: { observe: () => {}, prepare: async () => { calls.push('genuine'); return f.journal }, dispose: async () => {} }, notifications: {
    prepare: async (input, session) => { calls.push('prepare:' + input.notificationID); assert.equal(session.turnID, 'turn'); return { dialectData: { 'claude-code': { transcript_path: f.journal } } } },
    capture: async (input, session, dispatch, signal) => { calls.push('capture:' + input.notificationID); assert.equal(signal.aborted, false); assert.equal(session.turnID, 'turn'); assert.equal(dispatch.entries[0]!.result.status, 'success') },
  } })
  t.after(() => runtime.dispose()); runtime.sessions.prompt('session', 'turn', 'model')
  const owner = runtime.sessions.get('session'), result = await runtime.notification(event(owner.turnSignal))
  assert.equal(result.entries.length, 1); assert.deepEqual(calls, ['prepare:delivery', 'capture:delivery'])
  assert.equal(runtime.sessions.get('session').turnID, 'turn'); assert.equal(owner.turnSignal.aborted, false)
  const payload = JSON.parse((await readFile(f.path, 'utf8')).trim())
  assert.equal(payload.prompt, 'OWNED_SYSTEM_NOTIFICATION'); assert.equal(payload.prompt_id, 'turn'); assert.equal(payload.transcript_path, f.journal)
})

test('owned Claude prompt identifiers remain consistent across the genuine prompt and its tool callbacks', async t => {
  const f = await fixture(t), runtime = await createRuntime('v1', f.directory, f.options, { report: () => {}, dispatchDiagnostic: () => {}, transcripts: { observe: () => {}, prepare: async () => f.journal, dispose: async () => {} } })
  t.after(() => runtime.dispose()); runtime.sessions.prompt('session', 'turn', 'model')
  await runtime.prompt({ ...event(runtime.sessions.get('session').turnSignal), prompt: 'Genuine' })
  await runtime.tools.dispatch({ host: 'v1', event: 'PreToolUse', sessionID: 'session', callID: 'call', tool: 'bash', toolInput: { command: 'true' }, effectiveInput: { command: 'true' }, signal: runtime.sessions.get('session').turnSignal })
  const rows = (await readFile(f.path, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(rows.map(row => row.prompt_id), ['turn', 'turn'])
})

test('missing notification services, foreign anchors and missing prepared native metadata fail before hook execution', async t => {
  const f = await fixture(t), service: NotificationServices = { prepare: async () => ({ dialectData: {} }), capture: async () => {} }
  for (const kind of ['missing', 'anchor', 'metadata']) {
    const runtime = await createRuntime('v1', f.directory, f.options, { report: () => {}, dispatchDiagnostic: () => {}, ...(kind === 'missing' ? {} : { notifications: service }) })
    t.after(() => runtime.dispose()); runtime.sessions.prompt('session', 'turn', 'model')
    const input = event(runtime.sessions.get('session').turnSignal)
    await assert.rejects(runtime.notification(kind === 'anchor' ? { ...input, anchor: { ...input.anchor, sessionID: 'foreign' } } : input), { code: kind === 'missing' ? 'HOST_NOTIFICATION_UNAVAILABLE' : kind === 'anchor' ? 'HOST_NOTIFICATION_OWNER_MISMATCH' : 'HOST_NATIVE_METADATA_UNAVAILABLE' })
  }
  await assert.rejects(access(f.path))
})

test('a cancelled notification waiter drains its session-owned receipt before reporting cancellation', async t => {
  const f = await fixture(t), request = new AbortController()
  let entered!: () => void, finish!: () => void, saved = false, captureSignal: AbortSignal | undefined
  const ready = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { finish = resolve })
  t.after(() => finish())
  const runtime = await createRuntime('v1', f.directory, f.options, { report: () => {}, dispatchDiagnostic: () => {}, notifications: {
    prepare: async () => ({ dialectData: { 'claude-code': { transcript_path: f.journal } } }),
    capture: async (_input, _session, dispatch, signal) => { assert.equal(dispatch.entries[0]!.result.status, 'success'); captureSignal = signal; entered(); await gate; saved = true },
  } })
  t.after(() => runtime.dispose()); runtime.sessions.prompt('session', 'turn', 'model')
  let settled = false
  const pending = runtime.notification(event(request.signal)).finally(() => { settled = true })
  await ready; request.abort(); await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(captureSignal?.aborted, false); assert.equal(settled, false); assert.equal(saved, false)
  finish(); await assert.rejects(pending, { code: 'HOST_PROMPT_CANCELLED' }); assert.equal(saved, true)
  assert.equal(runtime.inspect().activeDispatches, 0)
})

test('notification preparation cancelled by a new turn cannot execute or capture a source callback', async t => {
  const f = await fixture(t)
  let entered!: () => void, captured = false
  const ready = new Promise<void>(resolve => { entered = resolve })
  const runtime = await createRuntime('v1', f.directory, f.options, { report: () => {}, dispatchDiagnostic: () => {}, notifications: {
    prepare: async (_input, _session, signal) => { entered(); await new Promise<void>(resolve => { signal.addEventListener('abort', () => resolve(), { once: true }) }); return { dialectData: { 'claude-code': { transcript_path: f.journal } } } },
    capture: async () => { captured = true },
  } })
  t.after(() => runtime.dispose()); runtime.sessions.prompt('session', 'turn', 'model')
  const pending = runtime.notification(event(runtime.sessions.get('session').turnSignal))
  await ready; runtime.sessions.prompt('session', 'next', 'model')
  await assert.rejects(pending, { code: 'HOST_PROMPT_CANCELLED' }); assert.equal(captured, false); await assert.rejects(access(f.path))
})

test('notification receipts include blocking callback outcomes and preserve raw command evidence', async t => {
  const output = JSON.stringify({ decision: 'block', reason: 'NOTIFICATION_BLOCKED' }), f = await fixture(t, output)
  let captures = 0
  const runtime = await createRuntime('v1', f.directory, f.options, { report: () => {}, dispatchDiagnostic: () => {}, notifications: {
    prepare: async () => ({ dialectData: { 'claude-code': { transcript_path: f.journal } } }),
    capture: async (_input, _session, dispatch) => { captures++; const result = dispatch.entries[0]!.result; assert.equal('commandArtifact' in result && result.commandArtifact?.stdout, output); assert.ok(dispatch.actions.some(row => row.action.kind === 'block-event')) },
  } })
  t.after(() => runtime.dispose()); runtime.sessions.prompt('session', 'turn', 'model')
  const dispatch = await runtime.notification(event(runtime.sessions.get('session').turnSignal))
  assert.equal(captures, 1); assert.equal(dispatch.cancelled, false); assert.equal(runtime.sessions.get('session').turnSignal.aborted, false)
})
