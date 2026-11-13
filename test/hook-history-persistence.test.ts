import assert from 'node:assert/strict'
import { test } from 'node:test'
import { StartupRecords } from '../src/startup-records.js'
import { PromptAttachments } from '../src/prompt-attachments.js'
import { Sessions } from '../src/sessions.js'
import type { DispatchResult } from '../src/engine.js'
import type { SessionStartDelivery } from '../src/session-start.js'
import type { HookEffect } from '../src/effect-types.js'

const COMPLETED = Date.parse('2026-01-01T12:00:00Z')
function dispatch(event: string): DispatchResult {
  const entry = { sourceID: 'source', sourceDigest: 'a'.repeat(64), registrationID: 'registration', dialect: 'claude-code' as const, configuredOrder: 0, completionOrder: 0, result: { status: 'success' as const, code: 'OK', actions: [{ kind: 'context' as const, placement: 'model' as const, channel: 'stdout' as const, text: 'CONTEXT' }], commandArtifact: { status: 'exited' as const, exitCode: 0, signal: null, stdout: 'CONTEXT\n', stderr: '', command: 'fixture', durationMs: 1, completedAt: COMPLETED, timeoutMs: 5000 }, diagnostic: { sourceID: 'source', registrationID: 'registration', dialect: 'claude-code' as const, event, code: 'OK', outcome: 'success' as const, durationMs: 1 } } }
  return { entries: [entry], actions: [], cancelled: false, diagnostic: { dispatchID: 'dispatch', sessionID: 'session', event, durationMs: 1, cancelled: false, failed: 0, unsupported: 0, skipped: 0, background: 0, handlers: [] } }
}
function startup(records: StartupRecords, sessions: Sessions) {
  const session = sessions.get('session')
  const input: SessionStartDelivery = { event: { host: 'v1', event: 'SessionStart', sessionID: 'session', activationID: 'activation', cwd: '/project', data: { source: 'startup' } }, session, signal: session.signal, dispatch: dispatch('SessionStart') }
  return records.admit(input)
}

function admit(records: StartupRecords | PromptAttachments, sessions: Sessions, result: DispatchResult, activationID = 'activation', source = 'startup') {
  if (records instanceof StartupRecords) return records.admit({ event: { host: 'v1', event: 'SessionStart', sessionID: 'session', activationID, cwd: '/project', data: { source } }, session: sessions.get('session'), signal: sessions.get('session').signal, dispatch: result })
  sessions.prompt('session', 'first', 'fixture')
  const session = sessions.get('session')
  records.admit({ host: 'v1', event: 'UserPromptSubmit', sessionID: 'session', messageID: 'first', prompt: 'Original', signal: session.turnSignal }, session, result)
}

for (const event of ['SessionStart', 'UserPromptSubmit'] as const) for (const variant of ['error', 'timeout', 'additional', 'empty', ...(event === 'UserPromptSubmit' ? ['warning'] as const : [])] as const) test(`${event} ${variant} artifacts survive restoration without regenerated IDs or timestamps`, () => {
  const result = dispatch(event), base = result.entries[0]!.result as HookEffect
  const effect: HookEffect = variant === 'error' ? { ...base, status: 'failed', code: 'COMMAND_FAILED', actions: [], commandArtifact: { ...base.commandArtifact!, exitCode: 3, stderr: 'Private failure' } }
    : variant === 'timeout' ? { ...base, status: 'failed', code: 'EXECUTION_TIMEOUT', actions: [], commandArtifact: { ...base.commandArtifact!, status: 'timeout', exitCode: null } }
      : variant === 'additional' ? { ...base, actions: [{ kind: 'context', placement: 'model', channel: 'additionalContext', text: 'EXTRA' }] }
        : variant === 'warning' ? { ...base, actions: [{ kind: 'warning', text: 'Private warning' }] }
        : { ...base, actions: [], commandArtifact: { ...base.commandArtifact!, stdout: '' } }
  const input: DispatchResult = { ...result, entries: [{ ...result.entries[0]!, result: effect }] }
  const sessions = new Sessions(), source = event === 'SessionStart' ? new StartupRecords() : new PromptAttachments()
  admit(source, sessions, input)
  const snapshot = source.snapshot('session'), restored = event === 'SessionStart' ? new StartupRecords() : new PromptAttachments(), next = new Sessions()
  source.dispose(); sessions.dispose()
  restored.restore(next.get('session'), snapshot)
  assert.deepEqual(restored.snapshot('session'), snapshot)
  restored.dispose(); next.dispose()
})

test('restored startup failures retain resume suppression and Codex context without reexecuting historical hooks', () => {
  const result = dispatch('SessionStart'), base = result.entries[0]!
  const skipped = { ...base, result: { ...base.result, status: 'skipped', actions: [], nativeFailureArtifact: { type: 'hook_non_blocking_error', stdout: '', stderr: 'Private startup rejection', exitCode: 1, completedAt: COMPLETED } } as unknown as typeof base.result }
  const effect = base.result as HookEffect
  const codex = { ...base, registrationID: 'codex', dialect: 'codex' as const, completionOrder: 1, result: { ...effect, diagnostic: { ...effect.diagnostic, registrationID: 'codex', dialect: 'codex' as const } } }
  const sessions = new Sessions(), records = new StartupRecords(), restored = new StartupRecords(), next = new Sessions()
  admit(records, sessions, { ...result, entries: [skipped, codex] })
  const snapshot = records.snapshot('session')
  records.dispose(); sessions.dispose()
  restored.restore(next.get('session'), snapshot)
  assert.deepEqual(restored.snapshot('session'), snapshot)
  const resumed = admit(restored, next, { ...result, entries: [skipped] }, 'resume-activation', 'resume')!
  assert.deepEqual(resumed.records, [])
  assert.deepEqual(restored.read('session')[0]!.model.codex, ['CONTEXT'])
  restored.dispose(); next.dispose()
})

test('prompt restoration distinguishes unobserved history from an initialized empty history', () => {
  for (const initialized of [false, true]) {
    const sessions = new Sessions(), source = new PromptAttachments()
    if (initialized) source.begin(sessions.get('session'))
    const restored = new PromptAttachments(), next = new Sessions()
    restored.restore(next.get('session'), source.snapshot('session'))
    if (initialized) assert.throws(() => restored.read('session', 'unknown', 'Original'), { code: 'TRANSCRIPT_PROMPT_HISTORY_UNAVAILABLE' })
    else assert.deepEqual(restored.read('session', 'unknown', 'Original'), [])
    source.dispose(); sessions.dispose(); restored.dispose(); next.dispose()
  }
})

test('startup snapshots retain native records, model context and the original prompt binding across lifetimes', () => {
  const old = new Sessions(), source = new StartupRecords()
  const batch = startup(source, old)
  old.prompt('session', 'first', 'fixture'); source.bind(old.get('session'), 'activation', 'first')
  const snapshot = source.snapshot('session')
  source.dispose(); old.dispose()
  const sessions = new Sessions(), restored = new StartupRecords()
  restored.restore(sessions.get('session'), snapshot)
  assert.deepEqual(restored.read('session'), [batch])
  assert.deepEqual(restored.beforePrompt('session', 'first'), batch.records)
  assert.deepEqual(restored.unbound('session'), [])
  sessions.close('session')
  assert.deepEqual(restored.read('session'), [])
  restored.dispose(); sessions.dispose()
})

test('unbound startup context survives restoration without an invented user record', () => {
  const old = new Sessions(), source = new StartupRecords(), batch = startup(source, old)
  const snapshot = source.snapshot('session')
  source.dispose(); old.dispose()
  const sessions = new Sessions(), restored = new StartupRecords()
  restored.restore(sessions.get('session'), snapshot)
  assert.deepEqual(restored.unbound('session'), batch.records)
  assert.deepEqual(restored.pending('session'), [batch])
  sessions.prompt('session', 'accepted', 'fixture')
  restored.bind(sessions.get('session'), 'activation', 'accepted')
  assert.deepEqual(restored.pending('session'), [])
  restored.dispose(); sessions.dispose()
})

test('prompt snapshots retain exact native attachments and reject changed original prompt text', () => {
  const old = new Sessions(), source = new PromptAttachments()
  old.prompt('session', 'first', 'fixture')
  const session = old.get('session'), event = { host: 'v1' as const, event: 'UserPromptSubmit' as const, sessionID: 'session', messageID: 'first', prompt: 'Original', signal: session.turnSignal }
  source.admit(event, session, dispatch(event.event))
  const before = source.read('session', 'first', 'Original'), snapshot = source.snapshot('session')
  source.dispose(); old.dispose()
  const sessions = new Sessions(), restored = new PromptAttachments()
  restored.restore(sessions.get('session'), snapshot)
  assert.deepEqual(restored.read('session', 'first', 'Original'), before)
  assert.throws(() => restored.read('session', 'first', 'Changed'), { code: 'TRANSCRIPT_PROMPT_HISTORY_UNAVAILABLE' })
  sessions.close('session'); assert.equal(restored.inspect().promptBytes, 0)
  restored.dispose(); sessions.dispose()
})

for (const kind of ['startup', 'prompt'] as const) test(`${kind} malformed, foreign or modified native records cannot partially restore`, () => {
  const sessions = new Sessions(), source = kind === 'startup' ? new StartupRecords() : new PromptAttachments()
  if (source instanceof StartupRecords) startup(source, sessions)
  else {
    sessions.prompt('session', 'first', 'fixture')
    source.admit({ host: 'v1', event: 'UserPromptSubmit', sessionID: 'session', messageID: 'first', prompt: 'Original', signal: sessions.get('session').turnSignal }, sessions.get('session'), dispatch('UserPromptSubmit'))
  }
  const snapshot = source.snapshot('session')
  for (const mutate of [
    (value: any) => { value.sessionID = 'foreign' },
    (value: any) => { const records = kind === 'startup' ? value.batches[0].batch.records : value.turns[0].attachments; records[0].body.rendered[0].content = 'UNOWNED' },
    (value: any) => { const records = kind === 'startup' ? value.batches[0].batch.records : value.turns[0].attachments; records.push(structuredClone(records[0])) },
  ]) {
    const restored = kind === 'startup' ? new StartupRecords() : new PromptAttachments(), other = new Sessions(), value = structuredClone(snapshot)
    mutate(value)
    assert.throws(() => restored.restore(other.get('session'), value))
    if (restored instanceof StartupRecords) assert.deepEqual(restored.read('session'), [])
    else assert.equal(restored.inspect().promptAttachments, 0)
    restored.dispose(); other.dispose()
  }
  source.dispose(); sessions.dispose()
})
