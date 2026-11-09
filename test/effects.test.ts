import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import type { Dialect } from '../src/contracts.js'
import type { AttributedAction, DispatchResult } from '../src/engine.js'
import type { HookAction } from '../src/effect-types.js'
import type { NativeEvent, Registration } from '../src/types.js'

function dispatch(actions: readonly AttributedAction[], permission?: DispatchResult['permission']): DispatchResult {
  return { actions, entries: [], ...(permission ? { permission } : {}), cancelled: false, diagnostic: { dispatchID: 'dispatch', sessionID: 'session', event: 'PreToolUse', durationMs: 0, cancelled: false, failed: 0, unsupported: 0, skipped: 0, background: 0, handlers: [] } }
}
function row<T extends HookAction>(action: T, configuredOrder = 0, completionOrder = configuredOrder, dialect: Dialect = 'claude-code'): AttributedAction<T> {
  return { action, sourceID: dialect, sourceDigest: 'revision', registrationID: `hook-${configuredOrder}`, dialect, configuredOrder, completionOrder }
}

test('input adjudication agrees with native Claude tool executions for competing whole replacements and denial', async () => {
  const { resolveEffects } = await import('../src/effects.js')
  const { interpretOutput } = await import('../src/protocol.js')
  const oracle = JSON.parse(readFileSync(new URL('./fixtures/claude-aggregation-oracle.json', import.meta.url), 'utf8'))
  assert.equal(oracle.version, '2.1.318')
  const event: NativeEvent = { event: 'PreToolUse', sessionID: 'session', cwd: '/fixture', tool: 'mcp__fixture__echo', toolInput: oracle.original }
  for (const scenario of oracle.cases) {
    const actions: AttributedAction[] = scenario.outputs.flatMap((output: unknown, index: number) => {
      const registration: Registration = { id: `hook-${index}`, sourceID: 'claude-code', dialect: 'claude-code', event: event.event, groupIndex: 0, handlerIndex: index, handler: { type: 'command', command: 'unused' } }
      const effect = interpretOutput(registration, event, { status: 'exited', exitCode: 0, signal: null, stdout: JSON.stringify(output), stderr: '', durationMs: 0 })
      assert.equal(effect.status, 'success', scenario.name)
      return effect.actions.map(action => row(action, index, scenario.completionOrder.indexOf(index)))
    })
    const permissions = actions.flatMap(value => value.action.kind === 'permission' ? [{ ...value, action: value.action }] : [])
    const permission = permissions.find(value => value.action.decision === 'deny') ?? permissions[0]
    const plan = resolveEffects(dispatch(actions, permission))
    assert.equal(plan.proceed, scenario.executedInput !== null, scenario.name)
    assert.deepEqual(plan.input?.action.input ?? null, scenario.executedInput, scenario.name)
    if (scenario.name === 'defer-before-allow') assert.equal(plan.control, 'defer')
  }
})

test('rewrites from both dialects compete by completion while reporting stays in configured order', async () => {
  const { resolveEffects } = await import('../src/effects.js')
  const actions = [row({ kind: 'replace-input', input: { command: 'last completed' } }, 0, 2, 'codex'), row({ kind: 'replace-input', input: { command: 'last configured' } }, 1, 0)]
  const plan = resolveEffects(dispatch(actions))
  assert.equal(plan.input?.action.input.command, 'last completed')
  assert.equal(plan.input?.dialect, 'codex')
  assert.deepEqual(actions.map(value => value.configuredOrder), [0, 1])
  assert.equal(plan.suppressed[0]?.code, 'REWRITE_SUPERSEDED')
  assert.equal(plan.suppressed[0]?.origin.registrationID, 'hook-1')
  assert.equal(JSON.stringify(plan.suppressed).includes('last configured'), false)
})

test('session stopping takes precedence over continuations and input changes without erasing permission requests', async () => {
  const { resolveEffects } = await import('../src/effects.js')
  const permission = row({ kind: 'permission', decision: 'ask', reason: 'Request approval' } as const)
  const actions: AttributedAction[] = [permission, row({ kind: 'continue-turn', text: 'Claude feedback', mode: 'feedback' }, 1), row({ kind: 'continue-turn', text: 'Codex prompt', mode: 'user' }, 2, 2, 'codex'), row({ kind: 'stop-session', reason: 'Stop requested' }, 3), row({ kind: 'replace-input', input: { command: 'unused' } }, 4)]
  const plan = resolveEffects(dispatch(actions, permission))
  assert.equal(plan.proceed, false)
  assert.equal(plan.stop?.action.reason, 'Stop requested')
  assert.deepEqual(plan.continuations, [])
  assert.equal(plan.input, undefined)
  assert.equal(plan.permission?.action.decision, 'ask')
  assert.deepEqual(plan.suppressed.map(value => value.code), ['CONTINUATION_STOPPED', 'CONTINUATION_STOPPED', 'REWRITE_BLOCKED'])
})

test('continuation prompt modes, context channels and unimplemented extensions remain distinct', async () => {
  const { resolveEffects } = await import('../src/effects.js')
  const actions: AttributedAction[] = [
    row({ kind: 'continue-turn', text: 'Claude feedback', mode: 'feedback' }), row({ kind: 'continue-turn', text: 'Codex prompt', mode: 'user' }, 1, 1, 'codex'),
    row({ kind: 'context', text: 'System context', placement: 'model', channel: 'systemMessage' }), row({ kind: 'context', text: 'Compaction context', placement: 'compaction' }),
    row({ kind: 'feedback', text: 'Feedback' }), row({ kind: 'warning', text: 'Warning' }), row({ kind: 'native-extension', name: 'updatedPermissions', value: [] }),
  ]
  const plan = resolveEffects(dispatch(actions))
  assert.deepEqual(plan.continuations.map(value => value.action.mode), ['feedback', 'user'])
  assert.deepEqual(plan.context.map(value => value.action.placement), ['model', 'compaction'])
  assert.equal(plan.context[0]?.action.channel, 'systemMessage')
  assert.equal(plan.extensions[0]?.action.name, 'updatedPermissions')
  assert.equal(plan.feedback[0]?.action.text, 'Feedback')
  assert.equal(plan.warnings[0]?.action.text, 'Warning')
})

test('asking for approval preserves rewritten arguments without authorizing direct execution', async () => {
  const { resolveEffects } = await import('../src/effects.js')
  const permission = row({ kind: 'permission', decision: 'ask', reason: 'Review changed input' } as const)
  const plan = resolveEffects(dispatch([permission, row({ kind: 'replace-input', input: { command: 'changed' } }, 1)], permission))
  assert.equal(plan.control, 'ask')
  assert.equal(plan.proceed, false)
  assert.equal(plan.input?.action.input.command, 'changed')
})

test('unverified result conflicts remain explicit and cancelled dispatches deliver no effects', async () => {
  const { resolveEffects } = await import('../src/effects.js')
  const actions: AttributedAction[] = [row({ kind: 'replace-result', output: 'first', rejectNested: false }), row({ kind: 'replace-result', output: 'second', rejectNested: false }, 1)]
  const plan = resolveEffects(dispatch(actions))
  assert.equal(plan.resultReplacements.length, 2)
  assert.equal(plan.unresolved[0]?.code, 'RESULT_CONFLICT_UNVERIFIED')
  assert.equal(plan.unresolved[0]?.origins.length, 2)
  const cancelled = resolveEffects({ ...dispatch(actions), cancelled: true })
  assert.equal(cancelled.proceed, false)
  assert.deepEqual(cancelled.resultReplacements, [])
  assert.deepEqual(cancelled.unresolved, [])
})
