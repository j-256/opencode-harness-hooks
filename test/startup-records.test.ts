import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Sessions } from '../src/sessions.js'
import type { SessionStartDelivery } from '../src/session-start.js'
import type { DispatchEntry } from '../src/engine.js'
import type { HookEffect } from '../src/effect-types.js'
import { StartupRecords } from '../src/startup-records.js'

const COMPLETED = Date.parse('2026-01-01T12:00:00Z')
function success(id: string, configuredOrder: number, completionOrder: number): DispatchEntry & { result: HookEffect } {
  return { sourceID: 'source', sourceDigest: 'a'.repeat(64), registrationID: id, dialect: 'claude-code', configuredOrder, completionOrder, result: { status: 'success', code: 'OK', actions: [{ kind: 'context', placement: 'model', channel: 'stdout', text: id }], commandArtifact: { status: 'exited', exitCode: 0, signal: null, stdout: id + '\n', stderr: '', command: 'fixture ' + id, durationMs: 10, completedAt: COMPLETED, timeoutMs: 5000 }, diagnostic: { sourceID: 'source', registrationID: id, dialect: 'claude-code', event: 'SessionStart', code: 'OK', outcome: 'success', durationMs: 10 } } }
}
function delivery(entries: DispatchEntry[], activationID = 'activation', source = 'startup', sessions = new Sessions()): SessionStartDelivery {
  const session = sessions.get('session')
  return { event: { host: 'v1', event: 'SessionStart', sessionID: 'session', activationID, cwd: '/project', data: { source } }, session, signal: session.signal, dispatch: { entries, actions: entries.flatMap(entry => entry.result.actions.map(action => ({ ...entry, action }))), cancelled: false, diagnostic: { dispatchID: 'dispatch', sessionID: 'session', event: 'SessionStart', durationMs: 10, cancelled: false, failed: 0, unsupported: 0, skipped: 0, background: 0, handlers: [] } } }
}

test('startup stdout records preserve native execution fields, batch identity and completion-order model blocks', () => {
  const records = new StartupRecords()
  const input = delivery([success('SLOW', 0, 1), success('FAST', 1, 0)])
  const batch = records.admit(input)
  assert.deepEqual(batch.model.claude, ['FAST', 'SLOW'].map(text => `<system-reminder>\nSessionStart:startup hook success: ${text}\n</system-reminder>`))
  assert.deepEqual(batch.model.codex, [])
  assert.deepEqual(batch.records.map(row => row.body.attachment.content), ['FAST', 'SLOW'])
  const [first, second] = batch.records
  assert.equal(first!.body.attachment.hookName, 'SessionStart:startup')
  assert.equal(first!.body.attachment.hookEvent, 'SessionStart')
  assert.equal(first!.body.attachment.type, 'hook_success')
  assert.equal(first!.body.attachment.stdout, 'FAST\n')
  assert.equal(first!.body.attachment.stderr, '')
  assert.equal(first!.body.attachment.command, 'fixture FAST')
  assert.equal(first!.body.attachment.exitCode, 0)
  assert.equal(first!.body.attachment.durationMs, 10)
  assert.equal(first!.body.attachment.toolUseID, second!.body.attachment.toolUseID)
  assert.equal(first!.body.renderedRole, 'system')
  assert.deepEqual(first!.body.rendered, [{ content: batch.model.claude[0] }])
  assert.deepEqual(records.read('session'), [batch])
  assert.throws(() => records.admit(input), { code: 'STARTUP_ACTIVATION_REUSED' })
  records.dispose()
})

test('startup JSON additional context retains the empty command receipt and deferred native context attachment', () => {
  const additional = success('EXTRA', 0, 0)
  additional.result = { ...additional.result, actions: [{ kind: 'context', placement: 'model', channel: 'additionalContext', text: 'EXTRA' }], commandArtifact: { ...additional.result.commandArtifact!, stdout: '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"EXTRA"}}\n' } }
  const records = new StartupRecords()
  const batch = records.admit(delivery([additional, success('STDOUT', 1, 1)]))
  assert.deepEqual(batch.records.map(row => row.body.attachment.type), ['hook_success', 'hook_success', 'hook_additional_context'])
  assert.equal(batch.records[0]!.body.attachment.content, '')
  assert.equal(Object.hasOwn(batch.records[0]!.body, 'rendered'), false)
  assert.deepEqual(batch.records[2]!.body.attachment.content, ['EXTRA'])
  assert.equal(batch.records[2]!.body.attachment.hookName, 'SessionStart')
  assert.deepEqual(batch.model.claude, ['<system-reminder>\nSessionStart:startup hook success: STDOUT\n</system-reminder>', '<system-reminder>\nSessionStart hook additional context: EXTRA\n</system-reminder>'])
  records.dispose()
})

test('invalid, conflicting or cancelled startup evidence cannot publish partial batches', () => {
  const entry = success('BAD', 1, 1)
  for (const edit of [
    (input: SessionStartDelivery) => ({ ...input, dispatch: { ...input.dispatch, cancelled: true } }),
    (input: SessionStartDelivery) => ({ ...input, event: { ...input.event, sessionID: 'foreign' } }),
    (input: SessionStartDelivery) => ({ ...input, dispatch: { ...input.dispatch, diagnostic: { ...input.dispatch.diagnostic, event: 'PreToolUse' } } }),
  ]) {
    const records = new StartupRecords()
    assert.throws(() => records.admit(edit(delivery([success('GOOD', 0, 0), entry]))))
    assert.deepEqual(records.read('session'), [])
    records.dispose()
  }
  for (const commandArtifact of [undefined, { ...entry.result.commandArtifact, durationMs: -1 }, { ...entry.result.commandArtifact, completedAt: NaN }]) {
    const records = new StartupRecords()
    assert.throws(() => records.admit(delivery([success('GOOD', 0, 0), { ...entry, result: { ...entry.result, commandArtifact } } as DispatchEntry])), { code: 'STARTUP_EXECUTION_UNAVAILABLE' })
    assert.deepEqual(records.read('session'), [])
    records.dispose()
  }
})

test('source metadata, source ownership and closed sessions remain explicit admission boundaries', () => {
  const records = new StartupRecords()
  for (const source of ['', 'invalid']) assert.throws(() => records.admit(delivery([success('VALUE', 0, 0)], 'activation', source)), { code: 'STARTUP_SOURCE_UNAVAILABLE' })
  const input = delivery([success('VALUE', 0, 0)])
  const controller = new AbortController(); controller.abort()
  assert.throws(() => records.admit({ ...input, signal: controller.signal }), { code: 'STARTUP_CANCELLED' })
  assert.deepEqual(records.read('session'), [])
  records.dispose()
})

test('native nonexecuting startup failures remain private and are not attached again on session resume', () => {
  const sessions = new Sessions(), records = new StartupRecords()
  const base = success('REJECTED', 0, 0)
  const rejected: DispatchEntry = { ...base, result: { ...base.result, status: 'skipped', actions: [], nativeFailureArtifact: { type: 'hook_non_blocking_error', stdout: '', stderr: 'Native startup rejection', exitCode: 1, completedAt: COMPLETED, command: 'Native prompt', durationMs: 2 } } as unknown as DispatchEntry['result'] }
  const first = records.admit(delivery([rejected, success('START', 1, 1)], 'first', 'startup', sessions))
  assert.equal(first.records[0]!.body.attachment.type, 'hook_non_blocking_error')
  assert.equal(Object.hasOwn(first.records[0]!.body, 'rendered'), false)
  assert.equal(first.model.claude.length, 1)
  const resumed = records.admit(delivery([rejected, success('RESUME', 1, 1)], 'second', 'resume', sessions))
  assert.deepEqual(resumed.records.map(row => row.body.attachment.type), ['hook_success'])
  assert.equal(records.read('session')[0]!.records[0]!.id, first.records[0]!.id)
  sessions.close('session')
  assert.deepEqual(records.read('session'), [])
  records.dispose()
})

test('command errors and timeouts have native private records and cannot leak output as startup context', () => {
  const bad = success('PRIVATE_STDOUT', 0, 0), timeout = success('TIMEOUT_STDOUT', 1, 1)
  bad.result = { ...bad.result, status: 'failed', code: 'COMMAND_FAILED', actions: [], commandArtifact: { ...bad.result.commandArtifact!, exitCode: 3, stderr: 'Error detail\n' } }
  timeout.result = { ...timeout.result, status: 'failed', code: 'EXECUTION_TIMEOUT', actions: [], commandArtifact: { ...timeout.result.commandArtifact!, status: 'timeout', exitCode: null, durationMs: 5000 } }
  const records = new StartupRecords(), batch = records.admit(delivery([bad, timeout]))
  assert.deepEqual(batch.records.map(row => row.body.attachment.type), ['hook_non_blocking_error', 'hook_cancelled'])
  assert.equal(batch.records[0]!.body.attachment.stderr, 'Failed with non-blocking status code: Error detail')
  assert.equal(batch.records[1]!.body.attachment.timedOut, true)
  assert.equal(Object.hasOwn(batch.records[1]!.body.attachment, 'stdout'), false)
  assert.deepEqual(batch.model, { claude: [], codex: [] })
  records.dispose()
})

test('rollback removes only its unbound startup batch and enforces binding ownership', () => {
  const records = new StartupRecords(), sessions = new Sessions()
  const first = records.admit(delivery([success('FIRST', 0, 0)], 'first', 'startup', sessions))
  records.admit(delivery([success('SECOND', 0, 0)], 'second', 'resume', sessions))
  records.revoke(sessions.get('session'), 'second')
  assert.deepEqual(records.read('session'), [first])
  sessions.prompt('session', 'turn', 'fixture')
  records.bind(sessions.get('session'), 'first', 'turn')
  assert.throws(() => records.revoke(sessions.get('session'), 'first'), { code: 'STARTUP_BINDING_INVALID' })
  assert.throws(() => records.unbind(sessions.get('session'), 'first', 'foreign'), { code: 'STARTUP_BINDING_INVALID' })
  records.unbind(sessions.get('session'), 'first', 'turn')
  records.revoke(sessions.get('session'), 'first')
  assert.deepEqual(records.read('session'), [])
  sessions.dispose(); records.dispose()
})
