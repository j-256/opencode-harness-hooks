import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AttributedAction, DispatchResult } from '../src/engine.js'
import type { HookAction } from '../src/effect-types.js'

function result(actions: readonly HookAction[]): DispatchResult {
  const attributed: AttributedAction[] = actions.map(action => ({ action, sourceID: 'source', sourceDigest: 'revision', registrationID: 'hook', dialect: 'claude-code', configuredOrder: 0, completionOrder: 0 }))
  const permission = attributed.flatMap(row => row.action.kind === 'permission' ? [{ ...row, action: row.action }] : [])[0]
  return { entries: [], actions: attributed, ...(permission ? { permission } : {}), cancelled: false, diagnostic: { dispatchID: 'dispatch', sessionID: 'session', event: 'PreToolUse', durationMs: 0, cancelled: false, failed: 0, unsupported: 0, skipped: 0, background: 0, handlers: [] } }
}

test('V1 rewrites the retained argument object completely and passes original input to post-tool dispatch', async () => {
  const { createV1Hooks } = await import('../src/hosts/v1.js')
  const observed: unknown[] = []
  const hooks = createV1Hooks({ dispatch: async event => {
    observed.push(event)
    return event.event === 'PreToolUse' ? result([{ kind: 'replace-input', input: { file_path: 'changed.txt' } }]) : result([])
  } })
  const args = { filePath: 'original.txt', optional: 'removed' }
  const input = { tool: 'read', sessionID: 'session', callID: 'call' }
  await hooks['tool.execute.before'](input, { args })
  assert.deepEqual(args, { filePath: 'changed.txt' })
  await hooks['tool.execute.after']({ ...input, args }, { title: 'Read', output: 'Content', metadata: {} })
  const post = observed[1] as { toolInput: unknown; effectiveInput: unknown; event: string }
  assert.equal(post.event, 'PostToolUse')
  assert.deepEqual(post.toolInput, { filePath: 'original.txt', optional: 'removed' })
  assert.deepEqual(post.effectiveInput, { filePath: 'changed.txt' })
  await hooks.dispose()
})

test('V1 rejects a denial before execution and retains custom tool identity', async () => {
  const { createV1Hooks } = await import('../src/hosts/v1.js')
  let tool = ''
  const hooks = createV1Hooks({ dispatch: async event => { tool = event.tool; return result([{ kind: 'permission', decision: 'deny', reason: 'Fixture denial' }]) } })
  await assert.rejects(hooks['tool.execute.before']({ tool: 'vendor.read', sessionID: 'session', callID: 'call' }, { args: { file_path: 'custom' } }), error => {
    assert.equal((error as { code?: string }).code, 'HOOK_TOOL_DENIED')
    assert.match(String(error), /Fixture denial/)
    return true
  })
  assert.equal(tool, 'vendor.read')
  assert.equal(hooks.inspect().calls, 0)
})

test('V2 registers its own hook shape, replaces input and preserves explicit failed outcomes', async () => {
  const { registerV2Hooks } = await import('../src/hosts/v2.js')
  const callbacks = new Map<string, (event: any) => Promise<void>>()
  const observed: any[] = []
  const backend = await registerV2Hooks({ tool: { hook: async (name, callback) => { callbacks.set(name, callback); return { dispose: () => { callbacks.delete(name) } } } } }, { dispatch: async event => {
    observed.push(event)
    return event.event === 'PreToolUse' ? result([{ kind: 'replace-input', input: { command: 'replacement' } }]) : result([])
  } })
  const before = { tool: 'shell', sessionID: 'session', id: 'call', messageID: 'message', agent: 'build', input: { command: 'original', description: 'removed' } }
  await callbacks.get('execute.before')!(before)
  assert.deepEqual(before.input, { command: 'replacement' })
  await callbacks.get('execute.after')!({ ...before, status: 'error', error: { message: 'Failure' } })
  assert.equal(observed[1].event, 'PostToolUseFailure')
  assert.deepEqual(observed[1].toolInput, { command: 'original', description: 'removed' })
  assert.equal(observed[1].messageID, 'message')
  assert.equal(observed[1].agent, 'build')
  assert.equal(observed[1].host, 'v2')
  await backend.dispose()
  assert.equal(callbacks.size, 0)
})

test('V2 setup failure disposes earlier registrations and repeated disposal is safe', async () => {
  const { registerV2Hooks } = await import('../src/hosts/v2.js')
  let disposed = 0
  await assert.rejects(registerV2Hooks({ tool: { hook: async name => {
    if (name === 'execute.after') throw new Error('Fixture setup failure')
    return { dispose: () => { disposed++ } }
  } } }, { dispatch: async () => result([]) }))
  assert.equal(disposed, 1)
  disposed = 0
  const backend = await registerV2Hooks({ tool: { hook: async () => ({ dispose: () => { disposed++ } }) } }, { dispatch: async () => result([]) })
  await Promise.all([backend.dispose(), backend.dispose()])
  assert.equal(disposed, 2)
})

test('V2 input replacement uses V2 path fields and leaves custom tool fields intact', async () => {
  const { hostInput } = await import('../src/hosts/tools.js')
  assert.deepEqual(hostInput('read', { file_path: 'file' }, 'v2'), { path: 'file' })
  assert.deepEqual(hostInput('shell', { command: 'true', run_in_background: true }, 'v2'), { command: 'true', background: true })
  assert.deepEqual(hostInput('vendor.read', { file_path: 'file' }, 'v2'), { file_path: 'file' })
  assert.throws(() => hostInput('read', { file_path: 'first', path: 'second' }, 'v2'), error => (error as { code?: string }).code === 'HOST_TOOL_INPUT_AMBIGUOUS')
})

test('unsupported ask/defer/stop and other effects are explicit instead of becoming approval or denial decisions', async () => {
  const { createV1Hooks } = await import('../src/hosts/v1.js')
  for (const [action, code] of [
    [{ kind: 'permission', decision: 'ask', reason: 'Review' }, 'HOST_TOOL_APPROVAL_UNAVAILABLE'],
    [{ kind: 'permission', decision: 'defer', reason: 'Later' }, 'HOST_TOOL_DEFER_UNAVAILABLE'],
    [{ kind: 'stop-session', reason: 'Stop' }, 'HOST_TURN_STOP_UNAVAILABLE'],
    [{ kind: 'native-extension', name: 'updatedPermissions', value: [] }, 'HOST_EFFECT_UNAVAILABLE'],
  ] as const) {
    const hooks = createV1Hooks({ dispatch: async () => result([action]) })
    await assert.rejects(hooks['tool.execute.before']({ tool: 'bash', sessionID: 'session', callID: 'call' }, { args: { command: 'never' } }), error => {
      assert.equal((error as { code?: string }).code, code)
      assert.equal((error as { outcome?: string }).outcome, 'unsupported')
      return true
    })
  }
})

test('unclassified V1 outputs do not masquerade as successful native tool results', async () => {
  const { createV1Hooks } = await import('../src/hosts/v1.js')
  const events: string[] = []
  const codes: string[] = []
  const hooks = createV1Hooks({ dispatch: async event => { events.push(event.event); return result([]) }, diagnostic: value => { codes.push(value.code) } })
  const input = { tool: 'bash', sessionID: 'session', callID: 'call' }
  await hooks['tool.execute.before'](input, { args: { command: 'original' } })
  await hooks['tool.execute.after']({ ...input, args: {} }, { output: 'No status available' })
  assert.deepEqual(events, ['PreToolUse'])
  assert.deepEqual(codes, ['HOST_TOOL_RESULT_UNKNOWN'])
  assert.equal(hooks.inspect().calls, 0)
})

test('disposal aborts in-flight dispatch and prevents late input mutation', async () => {
  const { createV1Hooks } = await import('../src/hosts/v1.js')
  let entered!: () => void
  const ready = new Promise<void>(resolve => { entered = resolve })
  let finish!: (result: DispatchResult) => void
  let signal: AbortSignal | undefined
  const hooks = createV1Hooks({ dispatch: async event => { signal = event.signal; entered(); return new Promise(resolve => { finish = resolve }) } })
  const args = { command: 'original' }
  const pending = hooks['tool.execute.before']({ tool: 'bash', sessionID: 'session', callID: 'call' }, { args })
  await ready
  await hooks.dispose()
  finish(result([{ kind: 'replace-input', input: { command: 'late' } }]))
  await assert.rejects(pending, error => (error as { code?: string }).code === 'HOST_TOOL_CANCELLED')
  assert.equal(signal?.aborted, true)
  assert.deepEqual(args, { command: 'original' })
  assert.equal(hooks.inspect().calls, 0)
})

test('approval reviews rewritten host arguments before committing any input mutation', async () => {
  const { createV1Hooks } = await import('../src/hosts/v1.js')
  let reviewed: unknown
  const hooks = createV1Hooks({ dispatch: async () => result([{ kind: 'permission', decision: 'ask', reason: 'Review' }, { kind: 'replace-input', input: { file_path: 'changed.txt' } }]), requestApproval: async event => { reviewed = event.effectiveInput; return false } })
  const args = { filePath: 'original.txt' }
  await assert.rejects(hooks['tool.execute.before']({ tool: 'read', sessionID: 'session', callID: 'call' }, { args }), error => (error as { code?: string }).code === 'HOOK_TOOL_DENIED')
  assert.deepEqual(reviewed, { filePath: 'changed.txt' })
  assert.deepEqual(args, { filePath: 'original.txt' })
})

test('disposal also cancels post-tool dispatch after its original-input claim has been removed', async () => {
  const { createV1Hooks } = await import('../src/hosts/v1.js')
  let entered!: () => void
  const ready = new Promise<void>(resolve => { entered = resolve })
  let finish!: (value: DispatchResult) => void
  let applied = false
  let signal: AbortSignal | undefined
  const hooks = createV1Hooks({ dispatch: async event => {
    if (event.event === 'PreToolUse') return result([])
    signal = event.signal
    entered()
    return new Promise(resolve => { finish = resolve })
  }, applyEffects: async () => { applied = true } })
  const input = { tool: 'custom', sessionID: 'session', callID: 'call' }
  await hooks['tool.execute.before'](input, { args: { value: 'original' } })
  const pending = hooks['tool.execute.after']({ ...input, args: { value: 'original' } }, { title: 'Custom', output: 'Done', metadata: {} })
  await ready
  await hooks.dispose()
  finish(result([{ kind: 'context', text: 'Late', placement: 'model' }]))
  await pending
  assert.equal(signal?.aborted, true)
  assert.equal(applied, false)
})

test('non-JSON input is rejected without changing numeric values and special keys cannot change prototypes', async () => {
  const { createV1Hooks } = await import('../src/hosts/v1.js')
  const hooks = createV1Hooks({ dispatch: async () => result([{ kind: 'replace-input', input: JSON.parse('{"__proto__":{"polluted":true},"value":"safe"}') }]) })
  const input = { tool: 'custom', sessionID: 'session', callID: 'call' }
  await assert.rejects(hooks['tool.execute.before'](input, { args: { value: NaN } }), error => (error as { code?: string }).code === 'HOST_TOOL_INPUT_INVALID')
  const args = { value: 'original' }
  await hooks['tool.execute.before']({ ...input, callID: 'other' }, { args })
  assert.equal(Object.getPrototypeOf(args), Object.prototype)
  assert.equal(Object.hasOwn(args, '__proto__'), true)
  assert.equal(({} as { polluted?: boolean }).polluted, undefined)
  await hooks.dispose()
})

test('dispatch exceptions remain failures and rejected telemetry never exposes exception text', async () => {
  const { createV1Hooks } = await import('../src/hosts/v1.js')
  const hooks = createV1Hooks({ dispatch: async () => { throw new Error('PRIVATE_DISPATCH_EXCEPTION') }, diagnostic: async () => { throw new Error('PRIVATE_OBSERVER_EXCEPTION') } })
  await assert.rejects(hooks['tool.execute.before']({ tool: 'custom', sessionID: 'session', callID: 'call' }, { args: {} }), error => {
    assert.equal((error as { code?: string }).code, 'HOST_TOOL_DISPATCH_FAILED')
    assert.equal((error as { outcome?: string }).outcome, 'failed')
    return true
  })
  await Promise.resolve()
  assert.equal(hooks.inspect().observerFailures, 1)
  assert.equal(JSON.stringify(hooks.inspect()).includes('PRIVATE_'), false)
})

test('informational effects are applied even when the tool is denied', async () => {
  const { createV1Hooks } = await import('../src/hosts/v1.js')
  let context = ''
  const hooks = createV1Hooks({ dispatch: async () => result([{ kind: 'permission', decision: 'deny', reason: 'Denied' }, { kind: 'context', text: 'Explain denial', placement: 'model' }]), applyEffects: async (_event, effects) => { context = effects.context[0]?.action.text ?? '' } })
  await assert.rejects(hooks['tool.execute.before']({ tool: 'custom', sessionID: 'session', callID: 'call' }, { args: {} }))
  assert.equal(context, 'Explain denial')
})
