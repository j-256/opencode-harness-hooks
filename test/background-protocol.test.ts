import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import type { Dialect } from '../src/contracts.js'
import type { ExecutionResult } from '../src/runner.js'
import type { NativeEvent, Registration } from '../src/types.js'

function hook(dialect: Dialect, event = 'PreToolUse'): Registration {
  return { id: 'background:fixture', sourceID: 'source', dialect, event, groupIndex: 0, handlerIndex: 0, handler: { type: 'command', command: 'unused', async: true, onFailure: 'block' } }
}
function event(name = 'PreToolUse'): NativeEvent { return { event: name, sessionID: 'session', cwd: '/project', tool: 'bash' } }
function execution(stdout: string, exitCode = 0, stderr = ''): ExecutionResult { return { status: 'exited', stdout, stderr, exitCode, signal: null, durationMs: 1 } }

test('Claude background parsing matches native capture including logs, dropped fields, foreign tags and nonzero exits', async () => {
  const { interpretOutput } = await import('../src/protocol.js')
  const oracle = JSON.parse(readFileSync(new URL('./fixtures/claude-background-oracle.json', import.meta.url), 'utf8'))
  assert.equal(oracle.version, '2.1.318')
  assert.equal(oracle.activeTurnDelivery, true)
  for (const observed of oracle.cases) {
    const result = interpretOutput(hook('claude-code', 'UserPromptSubmit'), event('UserPromptSubmit'), execution(observed.stdout, observed.exitCode, observed.stderr), { mode: 'background' })
    assert.deepEqual(result.actions, observed.expected.map((value: { text: string; channel: string }) => ({ kind: 'context', text: value.text, placement: 'model', channel: value.channel })), observed.name)
  }
})

test('background output cannot block or rewrite the operation and invalid field diagnostics omit values', async () => {
  const { interpretOutput } = await import('../src/protocol.js')
  const body = { continue: false, decision: 'block', reason: 'PRIVATE_CONTROL', systemMessage: 7, hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', additionalContext: 'Keep context' } }
  const result = interpretOutput(hook('claude-code'), event(), execution(JSON.stringify(body)), { mode: 'background' })
  assert.deepEqual(result.actions, [{ kind: 'context', text: 'Keep context', placement: 'model', channel: 'additionalContext' }])
  assert.ok(result.diagnostic.invalidFields?.includes('systemMessage'))
  assert.equal(JSON.stringify(result.diagnostic).includes('PRIVATE_CONTROL'), false)
  const cancelled = interpretOutput(hook('claude-code'), event(), { ...execution(JSON.stringify(body)), status: 'cancelled' }, { mode: 'background' })
  assert.deepEqual(cancelled.actions, [])
})

test('Codex background retains informational output without applying semantic control rejection', async () => {
  const { interpretOutput } = await import('../src/protocol.js')
  for (const fields of [
    { permissionDecision: 'ask' }, { permissionDecision: 'allow' }, { permissionDecision: 'allow', updatedInput: false },
    { permissionDecision: 'deny', permissionDecisionReason: '' },
  ]) {
    const body = { continue: false, suppressOutput: true, systemMessage: 'Warning', hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: 'Context', ...fields } }
    const result = interpretOutput(hook('codex'), event(), execution(JSON.stringify(body)), { mode: 'background' })
    assert.equal(result.status, 'success')
    assert.deepEqual(result.actions, [{ kind: 'warning', text: 'Warning' }, { kind: 'context', text: 'Context', placement: 'model' }])
  }
  const stop = interpretOutput(hook('codex', 'Stop'), event('Stop'), execution('plain text'), { mode: 'background' })
  assert.equal(stop.status, 'success')
  assert.deepEqual(stop.actions, [])
})

test('Codex still rejects malformed wire data in background and exit two cannot continue a turn', async () => {
  const { interpretOutput } = await import('../src/protocol.js')
  for (const stdout of ['{', '{"unknown":true}', '{"systemMessage":7}', '{"hookSpecificOutput":{"hookEventName":"Unknown","additionalContext":"discard"}}']) {
    const result = interpretOutput(hook('codex'), event(), execution(stdout), { mode: 'background' })
    assert.equal(result.status, 'failed', stdout)
    assert.deepEqual(result.actions, [])
  }
  const stopped = interpretOutput(hook('codex', 'Stop'), event('Stop'), execution('', 2, 'Do more work'), { mode: 'background' })
  assert.deepEqual(stopped.actions, [])
})

test('Claude asyncRewake uses its own native exit contract and takes precedence over async', async () => {
  const { interpretOutput } = await import('../src/protocol.js')
  const oracle = JSON.parse(readFileSync(new URL('./fixtures/claude-rewake-oracle.json', import.meta.url), 'utf8'))
  for (const observed of oracle.cases) {
    const registration = { ...hook('claude-code'), handler: { type: 'command', command: 'unused', async: observed.async, asyncRewake: true } } as const
    const result = interpretOutput(registration, event(), execution(observed.stdout, observed.exitCode, observed.stderr), { mode: 'background' })
    assert.deepEqual(result.actions, observed.automatic ? [{ kind: 'native-extension', name: 'asyncRewake', value: observed.stderr || observed.stdout }] : [], observed.name)
  }
})
