import assert from 'node:assert/strict'
import { test } from 'node:test'
import { getEventListeners } from 'node:events'
import { readFileSync } from 'node:fs'
import type { Dialect } from '../src/contracts.js'
import type { HostServices, McpHookRequest } from '../src/host-services.js'
import type { Handler, NativeEvent, Registration } from '../src/types.js'

function hook(dialect: Dialect, handler: Partial<Handler> = {}, name = 'PreToolUse'): Registration {
  return { id: 'mcp:fixture', sourceID: 'mcp', dialect, event: name, groupIndex: 0, handlerIndex: 0, handler: { type: 'mcp_tool', server: 'fixture', tool: 'check', ...handler } }
}
function event(name = 'PreToolUse'): NativeEvent {
  return { event: name, sessionID: 'session', cwd: '/project', tool: 'mcp__custom__tool', toolInput: { file: 'a.ts', count: 3, list: ['a', 7], nullable: null }, data: {
    transcript_path: '/artifacts/transcript.jsonl', permission_mode: 'default', tool_use_id: 'call', model: 'fixture-model', turn_id: 'turn', source: 'startup', stop_hook_active: false, last_assistant_message: 'Done',
  } }
}
const host = { environment: {}, projectRoot: '/project' }

test('Codex expands recursive MCP templates with native JSON types and explicit execution policies', async () => {
  const { executeRegistration } = await import('../src/handlers.js')
  let captured: McpHookRequest | undefined
  const result = await executeRegistration(hook('codex', { input: {
    file: '${tool_input.file}', count: '${tool_input.count}', embedded: 'n=${tool_input.count};x=${tool_input.list}',
    nested: { list: ['${tool_input.list}', '${tool_input.nullable}'] },
  } }), event(), { ...host, mcp: { timeoutAccounting: 'exclude-elicitation', execute: async request => {
    captured = request
    return { text: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'MCP decision' } }) }
  } } })
  assert.equal(result.status, 'success')
  assert.deepEqual(result.actions, [{ kind: 'permission', decision: 'deny', reason: 'MCP decision' }])
  assert.deepEqual(captured?.input, { file: 'a.ts', count: 3, embedded: 'n=3;x=["a",7]', nested: { list: [['a', 7], null] } })
  assert.equal(captured?.server, 'fixture')
  assert.equal(captured?.tool, 'check')
  assert.equal(captured?.connectionPolicy, 'connected-only')
  assert.equal(captured?.allowAuthentication, false)
  assert.equal(captured?.allowToolApproval, false)
  assert.equal(captured?.allowHookRecursion, false)
  assert.equal(captured?.timeoutMs, 600_000)
})

test('missing template paths and array string indices fail before calling MCP, including inherited keys', async () => {
  const { executeRegistration } = await import('../src/handlers.js')
  let calls = 0
  const services: HostServices = { ...host, mcp: { timeoutAccounting: 'exclude-elicitation', execute: async () => { calls++; return { text: '{}' } } } }
  for (const value of ['${missing}', '${tool_input.list.0}', '${tool_input.constructor}', '${tool_input.__proto__}']) {
    const result = await executeRegistration(hook('codex', { input: { value } }), event(), services)
    assert.equal(result.code, 'MCP_TEMPLATE_MISSING', value)
    assert.deepEqual(result.actions, [])
  }
  assert.equal(calls, 0)
})

test('MCP tool errors and absent servers follow native failure behavior without disclosing service errors', async () => {
  const { executeRegistration } = await import('../src/handlers.js')
  for (const dialect of ['claude-code', 'codex'] as const) {
    const failed = await executeRegistration(hook(dialect, { onFailure: 'block' }), event(), { ...host, mcp: { timeoutAccounting: 'exclude-elicitation', execute: async () => { throw new Error('PRIVATE_MCP_CONNECTION') } } })
    assert.equal(failed.status, 'failed')
    assert.deepEqual(failed.actions, [])
    assert.equal(JSON.stringify(failed).includes('PRIVATE_MCP_CONNECTION'), false)
    const toolError = await executeRegistration(hook(dialect), event(), { ...host, mcp: { timeoutAccounting: 'exclude-elicitation', execute: async () => ({ text: '{"continue":false}', isError: true }) } })
    assert.equal(toolError.status, 'failed')
    assert.deepEqual(toolError.actions, [])
  }
  assert.equal((await executeRegistration(hook('codex'), event(), host)).status, 'unsupported')
})

test('Claude MCP requests distinguish waiting and observational events and preserve confirmed string templates', async () => {
  const { executeRegistration } = await import('../src/handlers.js')
  const calls: McpHookRequest[] = []
  const services: HostServices = { ...host, mcp: { timeoutAccounting: 'wall', execute: async request => { calls.push(request); return { text: '{}' } } } }
  await executeRegistration(hook('claude-code', { input: { path: '${tool_input.file}' } }), event(), services)
  assert.deepEqual(calls[0]?.input, { path: 'a.ts' })
  assert.equal(calls[0]?.connectionPolicy, 'wait-or-connect-cached')
  await executeRegistration(hook('claude-code', {}, 'Notification'), event('Notification'), services)
  assert.equal(calls[1]?.connectionPolicy, 'connect-cached-without-waiting')
  const converted = await executeRegistration(hook('claude-code', { input: { count: '${tool_input.count}' } }), event(), services)
  assert.equal(converted.status, 'success')
  assert.deepEqual(calls[2]?.input, { count: '3' })
  assert.equal(calls.length, 3)
})

test('pinned Codex MCP calls carry the native thread identity and accept a wall-budgeted service', async () => {
  const { executeRegistration } = await import('../src/handlers.js')
  const calls: McpHookRequest[] = []
  const result = await executeRegistration(hook('codex', { async: true }), { ...event(), nativeSessionIDs: { codex: 'native-thread' } }, { ...host, mcp: { timeoutAccounting: 'wall', execute: async request => { calls.push(request); return { text: '{}' } } } })
  assert.equal(result.status, 'success')
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0]?.metadata, { threadId: 'native-thread' })
  assert.equal(Object.isFrozen(calls[0]?.metadata), true)
})

test('the pinned native outer wall deadline also bounds services that exclude elicitation internally', async () => {
  const { executeRegistration } = await import('../src/handlers.js')
  let observed: AbortSignal | undefined
  const result = await executeRegistration(hook('codex', { timeout: 0.02 }), event(), { ...host, mcp: { timeoutAccounting: 'exclude-elicitation', execute: async request => { observed = request.signal; return new Promise(() => {}) } } })
  assert.equal(result.code, 'EXECUTION_TIMEOUT')
  assert.equal(observed?.aborted, true)
})

test('MCP cancellation and Claude wall deadlines abort requests and discard late control effects', async () => {
  const { executeRegistration } = await import('../src/handlers.js')
  let observed: AbortSignal | undefined
  let finish!: (value: { text: string }) => void
  const timedOut = await executeRegistration(hook('claude-code', { timeout: 0.02 }), event(), { ...host, mcp: { timeoutAccounting: 'wall', execute: request => {
    observed = request.signal
    return new Promise(resolve => { finish = resolve })
  } } })
  assert.equal(timedOut.code, 'EXECUTION_TIMEOUT')
  assert.equal(observed?.aborted, true)
  finish({ text: '{"continue":false}' })
  assert.deepEqual(timedOut.actions, [])
  const controller = new AbortController()
  let started!: () => void
  const active = new Promise<void>(resolve => { started = resolve })
  const running = executeRegistration(hook('codex'), event(), { ...host, signal: controller.signal, mcp: { timeoutAccounting: 'exclude-elicitation', execute: async request => {
    observed = request.signal; started(); return new Promise(() => {})
  } } })
  await active
  controller.abort()
  assert.equal((await running).code, 'EXECUTION_CANCELLED')
  assert.equal(observed?.aborted, true)
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
})

test('Claude MCP templates match independently captured native string, null, array and prototype behavior', async () => {
  const { executeRegistration } = await import('../src/handlers.js')
  const oracle = JSON.parse(readFileSync(new URL('./fixtures/claude-mcp-oracle.json', import.meta.url), 'utf8'))
  assert.equal(oracle.version, '2.1.318')
  for (const observed of oracle.cases) {
    let captured: unknown
    const result = await executeRegistration(hook('claude-code', { input: observed.template }), { ...event(), toolInput: oracle.toolInput }, {
      ...host, mcp: { timeoutAccounting: 'wall', execute: async request => { captured = request.input; return { text: '{}' } } },
    })
    assert.equal(result.status, 'success', observed.template.variant)
    assert.deepEqual(captured, observed.expected, observed.template.variant)
  }
})

test('MCP input amplification and output limits fail before effects reach the host', async () => {
  const { executeRegistration } = await import('../src/handlers.js')
  for (const dialect of ['claude-code', 'codex'] as const) {
    let calls = 0
    const services: HostServices = { ...host, maxInputBytes: 2048, mcp: { timeoutAccounting: 'exclude-elicitation', execute: async () => { calls++; return { text: 'x'.repeat(100) } } } }
    const expanded = await executeRegistration(hook(dialect, { input: { value: '${tool_input.large}'.repeat(20) } }), { ...event(), toolInput: { large: 'x'.repeat(500) } }, services)
    assert.equal(expanded.code, 'EXECUTION_INPUT_LIMIT')
    assert.equal(calls, 0)
    const output = await executeRegistration(hook(dialect), event(), { ...services, maxOutputBytes: 10 })
    assert.equal(output.code, 'EXECUTION_OUTPUT_LIMIT')
    assert.deepEqual(output.actions, [])
    assert.equal(calls, 1)
  }
})

test('Claude native prototype lookup uses a pristine realm while namespace attribution stays explicit', async () => {
  const { executeRegistration } = await import('../src/handlers.js')
  let inherited = false
  const property = '__harness_mcp_fixture__'
  Object.defineProperty(Object.prototype, property, { configurable: true, get: () => { inherited = true; return 'PRIVATE_HOST_VALUE' } })
  try {
    let captured: unknown
    const result = await executeRegistration(hook('claude-code', { input: { value: `\${tool_input.${property}}` } }), event(), {
      ...host, mcp: { timeoutAccounting: 'wall', execute: async request => { captured = request.input; return { text: '{}', sourceToolNamespace: 'fixture-namespace' } } },
    })
    assert.equal(result.status, 'success')
    assert.deepEqual(captured, { value: '' })
    assert.equal(inherited, false)
    assert.deepEqual(result.actions, [{ kind: 'native-extension', name: 'mcpSourceNamespace', value: 'fixture-namespace' }])
  } finally { Reflect.deleteProperty(Object.prototype, property) }
})
