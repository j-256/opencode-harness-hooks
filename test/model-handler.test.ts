import assert from 'node:assert/strict'
import { test } from 'node:test'
import { getEventListeners } from 'node:events'
import type { HostServices, ModelHookRequest } from '../src/host-services.js'
import type { Handler, NativeEvent, Registration } from '../src/types.js'

function hook(handler: Handler, name = 'PreToolUse'): Registration {
  return { id: 'model:fixture', sourceID: 'model', dialect: 'claude-code', event: name, groupIndex: 0, handlerIndex: 0, handler }
}
function event(name = 'PreToolUse'): NativeEvent {
  return { event: name, sessionID: 'session', cwd: '/project', tool: 'bash', toolInput: { command: 'original' }, data: { transcript_path: '/artifacts/claude.jsonl', permission_mode: 'default', tool_use_id: 'call', prompt: 'user input' } }
}
const host = { environment: {}, projectRoot: '/project' }

test('prompt hooks pass the native payload, requested model and cancellable scope to an explicit service', async () => {
  const { executeRegistration } = await import('../src/handlers.js')
  let captured: ModelHookRequest | undefined
  const result = await executeRegistration(hook({ type: 'prompt', prompt: 'Check $ARGUMENTS for \\$1.00', model: 'fixture-model' }), event(), {
    ...host, evaluatePrompt: async request => { captured = request; return { ok: true } },
  })
  assert.equal(result.status, 'success')
  assert.deepEqual(result.actions, [])
  assert.equal(captured?.model, 'fixture-model')
  assert.equal(captured?.sessionID, 'session')
  assert.ok(captured?.signal instanceof AbortSignal)
  assert.equal(captured?.prompt.endsWith(' for $1.00'), true)
  const json = captured!.prompt.slice('Check '.length, -' for $1.00'.length)
  assert.equal(JSON.parse(json).tool_name, 'Bash')
  assert.deepEqual(JSON.parse(json).tool_input, { command: 'original' })
  await executeRegistration(hook({ type: 'prompt', prompt: 'Check completion' }, 'Stop'), event('Stop'), {
    ...host, evaluatePrompt: async request => { assert.ok(request.prompt.startsWith('Check completion')); assert.ok(request.prompt.includes('"hook_event_name":"Stop"')); return { ok: true } },
  })
})

test('model denials preserve distinct tool, turn-ending, continuation and observational effects', async () => {
  const { executeRegistration } = await import('../src/handlers.js')
  const services: HostServices = { ...host, evaluatePrompt: async () => ({ ok: false, reason: 'Incomplete' }) }
  const prompt = { type: 'prompt', prompt: 'Check $ARGUMENTS' } as const
  const pre = await executeRegistration(hook(prompt), event(), services)
  assert.deepEqual(pre.actions, [
    { kind: 'permission', decision: 'deny', reason: 'Incomplete' }, { kind: 'stop-session', reason: 'Incomplete' }, { kind: 'warning', text: 'Incomplete' },
  ])
  const retry = await executeRegistration(hook({ ...prompt, continueOnBlock: true }), event(), services)
  assert.deepEqual(retry.actions, [{ kind: 'permission', decision: 'deny', reason: 'Incomplete' }])
  for (const name of ['Stop', 'SubagentStop']) {
    const result = await executeRegistration(hook(prompt, name), event(name), services)
    assert.deepEqual(result.actions, [{ kind: 'continue-turn', text: 'Incomplete', mode: 'feedback' }])
  }
  for (const name of ['PermissionRequest', 'PermissionDenied']) {
    const result = await executeRegistration(hook(prompt, name), event(name), services)
    assert.deepEqual(result.actions, [])
  }
  const post = await executeRegistration(hook(prompt, 'PostToolUse'), event('PostToolUse'), services)
  assert.deepEqual(post.actions, [{ kind: 'stop-session', reason: 'Incomplete' }, { kind: 'warning', text: 'Incomplete' }])
  for (const name of ['PostToolUseFailure', 'TaskCreated']) {
    const result = await executeRegistration(hook(prompt, name), event(name), services)
    assert.deepEqual(result.actions, [{ kind: 'feedback', text: 'Incomplete' }])
  }
  const completed = await executeRegistration(hook(prompt, 'TaskCompleted'), event('TaskCompleted'), services)
  assert.deepEqual(completed.actions, [{ kind: 'native-extension', name: 'taskCompletionModelBlock', value: { reason: 'Incomplete', continueOnBlock: false } }])
})

test('prompt impossible permits Stop while agent verification keeps its own supported response semantics', async () => {
  const { executeRegistration } = await import('../src/handlers.js')
  const prompt = await executeRegistration(hook({ type: 'prompt', prompt: 'Check' }, 'Stop'), event('Stop'), { ...host, evaluatePrompt: async () => ({ ok: false, reason: 'Impossible', impossible: true }) })
  assert.deepEqual(prompt.actions, [])
  let agentCalled = false
  const agent = await executeRegistration(hook({ type: 'agent', prompt: 'Inspect $ARGUMENTS', continueOnBlock: false }, 'Stop'), event('Stop'), {
    ...host, runAgent: async request => { agentCalled = true; assert.equal(request.maxTurns, 50); return { ok: false, reason: 'Incomplete', impossible: true } },
  })
  assert.equal(agentCalled, true)
  assert.deepEqual(agent.actions, [{ kind: 'continue-turn', text: 'Incomplete', mode: 'feedback' }])
  const pre = await executeRegistration(hook({ type: 'agent', prompt: 'Inspect' }), event(), { ...host, runAgent: async () => ({ ok: false, reason: 'Incomplete' }) })
  assert.deepEqual(pre.actions, [{ kind: 'permission', decision: 'deny', reason: 'Incomplete' }])
})

test('model failures and malformed results cannot become approvals or disclose service errors', async () => {
  const { executeRegistration } = await import('../src/handlers.js')
  for (const output of [undefined, null, {}, { ok: 'true' }, { ok: false }, { ok: false, reason: 7 }, { ok: true, impossible: 'wrong' }]) {
    const result = await executeRegistration(hook({ type: 'prompt', prompt: 'PRIVATE_PROMPT' }), event(), { ...host, evaluatePrompt: async () => output })
    assert.equal(result.status, 'failed')
    assert.deepEqual(result.actions, [])
    assert.equal(JSON.stringify(result).includes('PRIVATE_PROMPT'), false)
  }
  const error = await executeRegistration(hook({ type: 'prompt', prompt: 'PRIVATE_PROMPT' }), event(), { ...host, evaluatePrompt: async () => { throw new Error('PRIVATE_PROVIDER_ERROR') } })
  assert.equal(error.status, 'failed')
  assert.equal(JSON.stringify(error).includes('PRIVATE_PROVIDER_ERROR'), false)
  const absent = await executeRegistration(hook({ type: 'prompt', prompt: 'Check' }), event(), host)
  assert.equal(absent.status, 'unsupported')
})

test('model timeout and cancellation abort pending services, discard late results and release listeners', async () => {
  const { executeRegistration } = await import('../src/handlers.js')
  let observed: AbortSignal | undefined
  let finish!: (value: unknown) => void
  const result = await executeRegistration(hook({ type: 'prompt', prompt: 'Check', timeout: 0.02 }), event(), {
    ...host, evaluatePrompt: request => { observed = request.signal; return new Promise(resolve => { finish = resolve }) },
  })
  assert.equal(result.code, 'EXECUTION_TIMEOUT')
  assert.equal(observed?.aborted, true)
  finish({ ok: false, reason: 'Stale decision' })
  assert.deepEqual(result.actions, [])
  const controller = new AbortController()
  let started!: () => void
  const active = new Promise<void>(resolve => { started = resolve })
  const running = executeRegistration(hook({ type: 'prompt', prompt: 'Check' }), event(), {
    ...host, signal: controller.signal, evaluatePrompt: async request => { observed = request.signal; started(); return new Promise(() => {}) },
  })
  await active
  controller.abort()
  assert.equal((await running).code, 'EXECUTION_CANCELLED')
  assert.equal(observed?.aborted, true)
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
})

test('model events preserve continuation defaults, end-turn warnings and teammate feedback', async () => {
  const { executeRegistration } = await import('../src/handlers.js')
  const services = { ...host, evaluatePrompt: async () => ({ ok: false, reason: 'Incomplete' }) }
  const prompt = { type: 'prompt', prompt: 'Check', continueOnBlock: true } as const
  for (const name of ['PostToolBatch', 'UserPromptSubmit', 'UserPromptExpansion']) {
    const result = await executeRegistration(hook(prompt, name), event(name), services)
    assert.deepEqual(result.actions, [{ kind: 'block-event', reason: 'Incomplete' }, { kind: 'warning', text: 'Incomplete' }])
  }
  const post = await executeRegistration(hook(prompt, 'PostToolUse'), event('PostToolUse'), services)
  assert.deepEqual(post.actions, [{ kind: 'feedback', text: 'Incomplete' }])
  const idle = await executeRegistration(hook(prompt, 'TeammateIdle'), event('TeammateIdle'), services)
  assert.deepEqual(idle.actions, [{ kind: 'continue-turn', text: 'Incomplete', mode: 'feedback' }])
})

test('model input and structured output have explicit resource budgets', async () => {
  const { executeRegistration } = await import('../src/handlers.js')
  let calls = 0
  const services = { ...host, evaluatePrompt: async () => { calls++; return { ok: false, reason: 'x'.repeat(100) } } }
  const definition = hook({ type: 'prompt', prompt: 'Check' })
  assert.equal((await executeRegistration(definition, event(), { ...services, maxInputBytes: 1 })).code, 'EXECUTION_INPUT_LIMIT')
  assert.equal(calls, 0)
  assert.equal((await executeRegistration(definition, event(), { ...services, maxOutputBytes: 1 })).code, 'EXECUTION_OUTPUT_LIMIT')
  assert.equal(calls, 1)
})
