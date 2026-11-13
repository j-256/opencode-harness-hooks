import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AttributedAction, DispatchResult } from '../src/engine.js'
import type { HookAction } from '../src/effect-types.js'
import { createV1Hooks } from '../src/hosts/v1.js'

function result(actions: readonly HookAction[], dialect: 'claude-code' | 'codex' = 'claude-code'): DispatchResult {
  const attributed: AttributedAction[] = actions.map(action => ({ action, sourceID: 'fixture', sourceDigest: 'revision', registrationID: 'hook', dialect, configuredOrder: 0, completionOrder: 0 }))
  const permission = attributed.flatMap(row => row.action.kind === 'permission' ? [{ ...row, action: row.action }] : [])[0]
  return { entries: [], actions: attributed, ...(permission ? { permission } : {}), cancelled: false, diagnostic: { dispatchID: 'dispatch', sessionID: 'session', event: 'PreToolUse', durationMs: 0, cancelled: false, failed: 0, unsupported: 0, skipped: 0, background: 0, handlers: [] } }
}
const call = { tool: 'write', sessionID: 'session', callID: 'call' }
const output = () => ({ title: 'Written', metadata: { preserved: true }, output: 'ORIGINAL_TOOL_RESULT' })
const context = (text: string): HookAction => ({ kind: 'context', placement: 'model', text, channel: 'additionalContext' })

test('default V1 delivers an owned Codex post-tool string replacement and retained context once', async t => {
  const hooks = createV1Hooks({ dispatch: async event => result(event.event === 'PreToolUse' ? [context('PRE_CONTEXT')] : [{ kind: 'replace-result', output: 'REPLACED_RESULT', rejectNested: true }, context('POST_CONTEXT')], 'codex') })
  t.after(() => hooks.dispose())
  await hooks['tool.execute.before'](call, { args: {} })
  const value = output()
  await hooks['tool.execute.after']({ ...call, args: {} }, value)
  assert.ok(value.output.startsWith('REPLACED_RESULT'))
  assert.equal(value.output.includes('ORIGINAL_TOOL_RESULT'), false)
  for (const marker of ['PRE_CONTEXT', 'POST_CONTEXT']) assert.equal(value.output.split(marker).length - 1, 1)
  assert.equal(value.title, 'Written'); assert.deepEqual(value.metadata, { preserved: true })
  const delivered = value.output
  await hooks['tool.execute.after']({ ...call, args: {} }, value)
  assert.equal(value.output, delivered)
  assert.deepEqual(hooks.inspect().diagnostics, [])
})

test('default V1 replaces with an empty string and isolates replacements between calls and sessions', async t => {
  const hooks = createV1Hooks({ dispatch: async event => result(event.event === 'PostToolUse' ? [{ kind: 'replace-result', output: event.sessionID === 'empty' ? '' : event.sessionID + ':' + event.callID, rejectNested: true }] : [], 'codex') })
  t.after(() => hooks.dispose())
  const calls = [{ ...call, sessionID: 'empty' }, call, { ...call, sessionID: 'other' }, { ...call, callID: 'parallel' }]
  for (const input of calls) await hooks['tool.execute.before'](input, { args: {} })
  for (const input of calls.toReversed()) {
    const value = output()
    await hooks['tool.execute.after']({ ...input, args: {} }, value)
    assert.equal(value.output, input.sessionID === 'empty' ? '' : input.sessionID + ':' + input.callID)
  }
  assert.deepEqual(hooks.inspect().diagnostics, [])
})

test('default V1 bounds replacement and context together without partially rendering oversized output', async t => {
  const hooks = createV1Hooks({ dispatch: async event => result(event.event === 'PreToolUse' ? [context('x'.repeat(64 * 1024))] : [{ kind: 'replace-result', output: '\u00e9'.repeat(32 * 1024 + 1), rejectNested: true }, context('UNDLVD_POST')], 'codex') })
  t.after(() => hooks.dispose())
  await hooks['tool.execute.before'](call, { args: {} })
  const value = output()
  await hooks['tool.execute.after']({ ...call, args: {} }, value)
  assert.ok(value.output.startsWith('ORIGINAL_TOOL_RESULT'))
  assert.equal(value.output.includes('\u00e9'), false); assert.equal(value.output.includes('UNDLVD_POST'), false)
  assert.deepEqual(hooks.inspect().diagnostics.map(row => row.code), ['HOST_TOOL_REPLACEMENT_LIMIT'])
})

test('default V1 retains replacement boundaries for unknown shapes, conflicts and immutable results', async t => {
  for (const mode of ['structured', 'conflict', 'immutable', 'extension']) {
    const actions: HookAction[] = [{ kind: 'replace-result', output: mode === 'structured' ? { content: 'REPLACED' } : 'REPLACED', rejectNested: true }]
    if (mode === 'conflict') actions.push({ kind: 'replace-result', output: 'COMPETING', rejectNested: true })
    if (mode === 'extension') actions.push({ kind: 'native-extension', name: 'unsupported', value: true })
    const hooks = createV1Hooks({ dispatch: async event => result(event.event === 'PostToolUse' ? actions : [], 'codex') })
    t.after(() => hooks.dispose())
    await hooks['tool.execute.before'](call, { args: {} })
    const value = mode === 'immutable' ? Object.freeze(output()) : output()
    await hooks['tool.execute.after']({ ...call, args: {} }, value)
    assert.equal(value.output, 'ORIGINAL_TOOL_RESULT')
    assert.deepEqual(hooks.inspect().diagnostics.map(row => row.code), [mode === 'conflict' ? 'RESULT_CONFLICT_UNVERIFIED' : mode === 'immutable' ? 'HOST_TOOL_RESULT_IMMUTABLE' : 'HOST_EFFECT_UNAVAILABLE'])
  }
})

test('default V1 discards a late replacement when the call is disposed', async () => {
  let entered!: () => void, finish!: (value: DispatchResult) => void
  const ready = new Promise<void>(resolve => { entered = resolve })
  const hooks = createV1Hooks({ dispatch: async event => {
    if (event.event === 'PreToolUse') return result([], 'codex')
    entered(); return new Promise(resolve => { finish = resolve })
  } })
  await hooks['tool.execute.before'](call, { args: {} })
  const value = output(), pending = hooks['tool.execute.after']({ ...call, args: {} }, value)
  await ready; await hooks.dispose()
  finish(result([{ kind: 'replace-result', output: 'LATE_RESULT', rejectNested: true }], 'codex'))
  await pending
  assert.equal(value.output, 'ORIGINAL_TOOL_RESULT')
})

test('default V1 does not apply result replacements before execution or through the failure event', async t => {
  const actions: HookAction[] = [{ kind: 'replace-result', output: 'UNEXPECTED_REPLACEMENT', rejectNested: true }]
  const before = createV1Hooks({ dispatch: async () => result(actions, 'codex') })
  t.after(() => before.dispose())
  await assert.rejects(before['tool.execute.before'](call, { args: {} }), { code: 'HOST_EFFECT_UNAVAILABLE' })
  const failed = createV1Hooks({ dispatch: async event => result(event.event === 'PreToolUse' ? [] : actions, 'codex') })
  t.after(() => failed.dispose())
  const bash = { ...call, tool: 'bash' }
  await failed['tool.execute.before'](bash, { args: { command: 'failure' } })
  const value = { title: 'Failed', metadata: { exit: 1 }, output: 'ORIGINAL_FAILURE' }
  await failed['tool.execute.after']({ ...bash, args: { command: 'failure' } }, value)
  assert.equal(value.output, 'ORIGINAL_FAILURE')
  assert.deepEqual(failed.inspect().diagnostics.map(row => row.code), ['HOST_EFFECT_UNAVAILABLE'])
})

test('default V1 retains pre-tool context while applying the effective input replacement', async t => {
  const hooks = createV1Hooks({ dispatch: async event => result(event.event === 'PreToolUse' ? [context('PRE_CONTEXT'), { kind: 'replace-input', input: { file_path: 'file.txt', content: 'rewritten' } }] : []) })
  t.after(() => hooks.dispose())
  const args = { filePath: 'file.txt', content: 'original' }
  await hooks['tool.execute.before'](call, { args })
  assert.deepEqual(args, { filePath: 'file.txt', content: 'rewritten' })
  const value = output()
  await hooks['tool.execute.after']({ ...call, args }, value)
  assert.ok(value.output.startsWith('ORIGINAL_TOOL_RESULT'))
  assert.equal(value.output.split('PRE_CONTEXT').length - 1, 1)
  assert.equal(value.title, 'Written')
  assert.deepEqual(value.metadata, { preserved: true })
  const delivered = value.output
  await hooks['tool.execute.after']({ ...call, args }, value)
  assert.equal(value.output, delivered)
  assert.deepEqual(hooks.inspect().diagnostics, [])
})

test('default V1 delivers post-tool feedback and model context in the tool result', async t => {
  const hooks = createV1Hooks({ dispatch: async event => result(event.event === 'PostToolUse' ? [{ kind: 'feedback', text: 'FIX_THE_FILE' }, context('POST_CONTEXT')] : []) })
  t.after(() => hooks.dispose())
  await hooks['tool.execute.before'](call, { args: {} })
  const value = output()
  await hooks['tool.execute.after']({ ...call, args: {} }, value)
  assert.ok(value.output.startsWith('ORIGINAL_TOOL_RESULT'))
  assert.ok(value.output.includes('FIX_THE_FILE'))
  assert.ok(value.output.includes('POST_CONTEXT'))
  assert.deepEqual(hooks.inspect().diagnostics, [])
})

test('default V1 isolates interleaved calls and sessions with repeated call IDs', async t => {
  const hooks = createV1Hooks({ dispatch: async event => result(event.event === 'PreToolUse' ? [context(event.sessionID + ':' + event.callID)] : []) })
  t.after(() => hooks.dispose())
  const calls = [call, { ...call, sessionID: 'other' }, { ...call, callID: 'parallel' }]
  for (const input of calls) await hooks['tool.execute.before'](input, { args: {} })
  for (const input of calls.toReversed()) {
    const value = output()
    await hooks['tool.execute.after']({ ...input, args: {} }, value)
    assert.ok(value.output.includes(input.sessionID + ':' + input.callID))
    for (const other of calls.filter(other => other !== input)) assert.equal(value.output.includes(other.sessionID + ':' + other.callID), false)
  }
})

test('default V1 preserves the denial reason and its context without retaining the rejected call', async t => {
  let deny = true
  const hooks = createV1Hooks({ dispatch: async () => result(deny ? [context('DENIAL_CONTEXT'), { kind: 'permission', decision: 'deny', reason: 'POLICY_DENIAL' }] : []) })
  t.after(() => hooks.dispose())
  await assert.rejects(hooks['tool.execute.before'](call, { args: {} }), error => {
    assert.equal((error as { code: string }).code, 'HOOK_TOOL_DENIED')
    assert.match(String(error), /POLICY_DENIAL/)
    assert.match(String(error), /DENIAL_CONTEXT/)
    return true
  })
  deny = false
  await hooks['tool.execute.before'](call, { args: {} })
  const value = output()
  await hooks['tool.execute.after']({ ...call, args: {} }, value)
  assert.equal(value.output, 'ORIGINAL_TOOL_RESULT')
})

test('default V1 drops context after an immutable input prevents the rewrite', async t => {
  let rewrite = true
  const hooks = createV1Hooks({ dispatch: async event => result(rewrite && event.event === 'PreToolUse' ? [context('STALE_CONTEXT'), { kind: 'replace-input', input: { content: 'changed' } }] : []) })
  t.after(() => hooks.dispose())
  await assert.rejects(hooks['tool.execute.before'](call, { args: Object.freeze({ content: 'original' }) }), { code: 'HOST_TOOL_INPUT_IMMUTABLE' })
  rewrite = false
  await hooks['tool.execute.before'](call, { args: {} })
  const value = output()
  await hooks['tool.execute.after']({ ...call, args: {} }, value)
  assert.equal(value.output, 'ORIGINAL_TOOL_RESULT')
})

test('an explicit V1 effect service retains control instead of also rendering the default context', async t => {
  const hooks = createV1Hooks({ dispatch: async event => result(event.event === 'PostToolUse' ? [context('CUSTOM_CONTEXT'), { kind: 'native-extension', name: 'custom', value: true }] : []), applyEffects: async event => { (event.result as { output: string }).output = 'CUSTOM_SERVICE_RESULT' } })
  t.after(() => hooks.dispose())
  await hooks['tool.execute.before'](call, { args: {} })
  const value = output()
  await hooks['tool.execute.after']({ ...call, args: {} }, value)
  assert.equal(value.output, 'CUSTOM_SERVICE_RESULT')
  assert.deepEqual(hooks.inspect().diagnostics, [])
})

test('default V1 does not render a partial post-tool batch containing an unsupported result replacement', async t => {
  const hooks = createV1Hooks({ dispatch: async event => result(event.event === 'PostToolUse' ? [{ kind: 'feedback', text: 'PARTIAL_FEEDBACK' }, { kind: 'replace-result', output: 'REPLACED', rejectNested: true }] : []) })
  t.after(() => hooks.dispose())
  await hooks['tool.execute.before'](call, { args: {} })
  const value = output()
  await hooks['tool.execute.after']({ ...call, args: {} }, value)
  assert.equal(value.output, 'ORIGINAL_TOOL_RESULT')
  assert.deepEqual(hooks.inspect().diagnostics.map(row => row.code), ['HOST_EFFECT_UNAVAILABLE'])
})

test('default V1 reports immutable results and clears their undelivered context', async t => {
  let emit = true
  const hooks = createV1Hooks({ dispatch: async event => result(emit && event.event === 'PostToolUse' ? [context('UNDLVD_CONTEXT')] : []) })
  t.after(() => hooks.dispose())
  await hooks['tool.execute.before'](call, { args: {} })
  const value = Object.freeze(output())
  await hooks['tool.execute.after']({ ...call, args: {} }, value)
  assert.equal(value.output, 'ORIGINAL_TOOL_RESULT')
  assert.deepEqual(hooks.inspect().diagnostics.map(row => row.code), ['HOST_TOOL_RESULT_IMMUTABLE'])
  emit = false
  await hooks['tool.execute.before'](call, { args: {} })
  const next = output()
  await hooks['tool.execute.after']({ ...call, args: {} }, next)
  assert.equal(next.output, 'ORIGINAL_TOOL_RESULT')
})

test('default V1 clears retained context for unknown results and closed sessions', async t => {
  let emit = true
  const hooks = createV1Hooks({ dispatch: async event => result(emit && event.event === 'PreToolUse' ? [context('UNDELIVERED')] : []) })
  t.after(() => hooks.dispose())
  await hooks['tool.execute.before'](call, { args: {} })
  const unknown = { output: 'UNCLASSIFIED' }
  await hooks['tool.execute.after']({ ...call, args: {} }, unknown)
  assert.equal(unknown.output, 'UNCLASSIFIED')
  await hooks['tool.execute.before'](call, { args: {} })
  hooks.disposeSession(call.sessionID)
  const closed = output()
  await hooks['tool.execute.after']({ ...call, args: {} }, closed)
  assert.equal(closed.output, 'ORIGINAL_TOOL_RESULT')
  emit = false
  await hooks['tool.execute.before'](call, { args: {} })
  const next = output()
  await hooks['tool.execute.after']({ ...call, args: {} }, next)
  assert.equal(next.output, 'ORIGINAL_TOOL_RESULT')
})

test('default V1 does not deliver late post-tool context after disposal', async () => {
  let entered!: () => void
  const ready = new Promise<void>(resolve => { entered = resolve })
  let finish!: (value: DispatchResult) => void
  const hooks = createV1Hooks({ dispatch: async event => {
    if (event.event === 'PreToolUse') return result([context('PRE_DISPOSED')])
    entered()
    return new Promise(resolve => { finish = resolve })
  } })
  await hooks['tool.execute.before'](call, { args: {} })
  const value = output()
  const pending = hooks['tool.execute.after']({ ...call, args: {} }, value)
  await ready
  await hooks.dispose()
  finish(result([context('POST_DISPOSED')]))
  await pending
  assert.equal(value.output, 'ORIGINAL_TOOL_RESULT')
})

test('default V1 rejects oversized pre-tool context without truncating or changing input', async t => {
  const hooks = createV1Hooks({ dispatch: async () => result([context('x'.repeat(128 * 1024 + 1))]) })
  t.after(() => hooks.dispose())
  const args = { content: 'original' }
  await assert.rejects(hooks['tool.execute.before'](call, { args }), { code: 'HOST_TOOL_CONTEXT_LIMIT' })
  assert.deepEqual(args, { content: 'original' })
  assert.equal(hooks.inspect().calls, 0)
})

test('default V1 does not create empty tool context when a hook returns an empty string', async t => {
  const hooks = createV1Hooks({ dispatch: async () => result([context('')]) })
  t.after(() => hooks.dispose())
  await hooks['tool.execute.before'](call, { args: {} })
  const value = output()
  await hooks['tool.execute.after']({ ...call, args: {} }, value)
  assert.equal(value.output, 'ORIGINAL_TOOL_RESULT')
})

test('a duplicate V1 call cannot erase the active call context', async t => {
  const hooks = createV1Hooks({ dispatch: async event => result(event.event === 'PreToolUse' ? [context('ACTIVE_CONTEXT')] : []) })
  t.after(() => hooks.dispose())
  await hooks['tool.execute.before'](call, { args: {} })
  await assert.rejects(hooks['tool.execute.before'](call, { args: {} }), { code: 'HOST_TOOL_CALL_BUSY' })
  const value = output()
  await hooks['tool.execute.after']({ ...call, args: {} }, value)
  assert.equal(value.output.split('ACTIVE_CONTEXT').length - 1, 1)
})

test('V1 bounds combined pre and post context by UTF-8 bytes without partially delivering the post batch', async t => {
  const hooks = createV1Hooks({ dispatch: async event => result([context(event.event === 'PreToolUse' ? 'x'.repeat(64 * 1024) : '\u00e9'.repeat(32 * 1024 + 1))]) })
  t.after(() => hooks.dispose())
  await hooks['tool.execute.before'](call, { args: {} })
  const value = output()
  await hooks['tool.execute.after']({ ...call, args: {} }, value)
  assert.ok(value.output.includes('x'.repeat(64 * 1024)))
  assert.equal(value.output.includes('\u00e9'), false)
  assert.deepEqual(hooks.inspect().diagnostics.map(row => row.code), ['HOST_TOOL_CONTEXT_LIMIT'])
})

for (const mode of ['result', 'error']) test(`default V1 drops pre-tool context when post-tool dispatch is cancelled by ${mode}`, async t => {
  const { HostHookError } = await import('../src/host-errors.js')
  const hooks = createV1Hooks({ dispatch: async event => {
    if (event.event === 'PreToolUse') return result([context('CANCELLED_CONTEXT')])
    if (mode === 'error') throw new HostHookError('HOST_TOOL_CANCELLED', 'cancelled')
    return { ...result([]), cancelled: true }
  } })
  t.after(() => hooks.dispose())
  await hooks['tool.execute.before'](call, { args: {} })
  const value = output()
  await hooks['tool.execute.after']({ ...call, args: {} }, value)
  assert.equal(value.output, 'ORIGINAL_TOOL_RESULT')
})

test('concurrent duplicate V1 completion cannot consume the active completion context', async t => {
  let entered!: () => void
  const ready = new Promise<void>(resolve => { entered = resolve })
  let finish!: (value: DispatchResult) => void
  const hooks = createV1Hooks({ dispatch: async event => {
    if (event.event === 'PreToolUse') return result([context('OWNED_PRE_CONTEXT')])
    entered()
    return new Promise(resolve => { finish = resolve })
  } })
  t.after(() => hooks.dispose())
  await hooks['tool.execute.before'](call, { args: {} })
  const first = output()
  const pending = hooks['tool.execute.after']({ ...call, args: {} }, first)
  await ready
  const duplicate = output()
  await hooks['tool.execute.after']({ ...call, args: {} }, duplicate)
  finish(result([{ kind: 'feedback', text: 'OWNED_POST_FEEDBACK' }]))
  await pending
  assert.equal(duplicate.output, 'ORIGINAL_TOOL_RESULT')
  assert.equal(first.output.split('OWNED_PRE_CONTEXT').length - 1, 1)
  assert.equal(first.output.split('OWNED_POST_FEEDBACK').length - 1, 1)
  assert.deepEqual(hooks.inspect().diagnostics, [])
})

test('an unreadable V1 result is diagnosed and releases its call context', async t => {
  let emit = true
  const hooks = createV1Hooks({ dispatch: async event => result(emit && event.event === 'PreToolUse' ? [context('UNREADABLE_CONTEXT')] : []) })
  t.after(() => hooks.dispose())
  await hooks['tool.execute.before'](call, { args: {} })
  const value = { title: 'Unreadable', metadata: {}, get output(): string { throw new Error('PRIVATE_RESULT_ERROR') } }
  await hooks['tool.execute.after']({ ...call, args: {} }, value)
  assert.equal(hooks.inspect().calls, 0)
  assert.deepEqual(hooks.inspect().diagnostics.map(row => row.code), ['HOST_TOOL_RESULT_UNKNOWN'])
  assert.equal(JSON.stringify(hooks.inspect()).includes('PRIVATE_RESULT_ERROR'), false)
  emit = false
  await hooks['tool.execute.before'](call, { args: {} })
  const next = output()
  await hooks['tool.execute.after']({ ...call, args: {} }, next)
  assert.equal(next.output, 'ORIGINAL_TOOL_RESULT')
})
