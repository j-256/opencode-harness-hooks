import assert from 'node:assert/strict'
import { test } from 'node:test'
import fc from 'fast-check'
import type { Dialect } from '../src/contracts.js'
import type { NativeEvent, Registration } from '../src/types.js'

function registration(dialect: Dialect, event = 'PreToolUse'): Registration {
  return { id: 'fixture', sourceID: 'source', dialect, event, groupIndex: 0, handlerIndex: 0, handler: { type: 'command', command: 'unused' } }
}

const event: NativeEvent = {
  event: 'PreToolUse', sessionID: 'session', cwd: '/project', tool: 'functions.edit',
  toolInput: { filePath: 'a.ts', oldString: 'old', newString: 'new', replaceAll: true },
  data: { tool_use_id: 'call', permission_mode: 'default', turn_id: 'turn', model: 'fixture-model', prompt_id: 'prompt', transcript_path: '/incompatible/shared', SECRET_SENTINEL: 'must not escape' },
  dialectData: { 'claude-code': { transcript_path: '/artifacts/claude.jsonl' }, codex: { transcript_path: '/artifacts/codex.jsonl' } },
}

test('V2 built-in paths and shell flags use explicit native fields while custom tools retain their keys', async () => {
  const { buildPayload } = await import('../src/payload.js')
  const hook = registration('claude-code')
  assert.deepEqual(buildPayload(hook, { ...event, host: 'v2', tool: 'edit', toolInput: { path: 'file', oldString: 'before', newString: 'after' } }).tool_input, { file_path: 'file', old_string: 'before', new_string: 'after' })
  assert.deepEqual(buildPayload(hook, { ...event, host: 'v2', tool: 'shell', toolInput: { command: 'true', background: true } }).tool_input, { command: 'true', run_in_background: true })
  const input = JSON.parse('{"path":"custom","constructor":"literal","__proto__":{"value":true}}')
  assert.deepEqual(buildPayload(hook, { ...event, host: 'v2', tool: 'vendor.edit', toolInput: input }).tool_input, input)
  assert.deepEqual(buildPayload(hook, { ...event, tool: 'constructor', toolInput: input }).tool_input, input)
})

test('builds dialect-specific payloads with separate transcript artifacts and reserved identity', async () => {
  const { buildPayload } = await import('../src/payload.js')
  const claude = buildPayload(registration('claude-code'), event)
  assert.deepEqual(claude, {
    session_id: 'session', cwd: '/project', hook_event_name: 'PreToolUse', transcript_path: '/artifacts/claude.jsonl',
    prompt_id: 'prompt', permission_mode: 'default', tool_use_id: 'call', tool_name: 'Edit',
    tool_input: { file_path: 'a.ts', old_string: 'old', new_string: 'new', replace_all: true },
  })
  const codex = buildPayload(registration('codex'), event)
  assert.deepEqual(codex, {
    session_id: 'session', cwd: '/project', hook_event_name: 'PreToolUse', transcript_path: '/artifacts/codex.jsonl',
    permission_mode: 'default', turn_id: 'turn', model: 'fixture-model', tool_use_id: 'call', tool_name: 'Edit',
    tool_input: { file_path: 'a.ts', old_string: 'old', new_string: 'new', replace_all: true },
  })
  assert.equal(JSON.stringify([claude, codex]).includes('SECRET_SENTINEL'), false)
  assert.equal(event.toolInput?.filePath, 'a.ts')
})

test('arbitrary tool argument keys are preserved and never globally renamed', async () => {
  const { buildPayload } = await import('../src/payload.js')
  fc.assert(fc.property(fc.json(), value => {
    const input = { filePath: 'native-camel-key', nested: JSON.parse(value) }
    for (const dialect of ['claude-code', 'codex'] as const) {
      const payload = buildPayload(registration(dialect), { ...event, tool: 'mcp__custom__edit', toolInput: input })
      assert.deepEqual(payload.tool_input, input)
      assert.equal(payload.tool_name, 'mcp__custom__edit')
    }
  }))
})

test('rejects invalid native metadata types before a hook can observe malformed input', async () => {
  const { buildPayload } = await import('../src/payload.js')
  assert.throws(() => buildPayload(registration('claude-code'), { ...event, data: {} }), /PAYLOAD_MISSING:permission_mode/)
  for (const metadata of [{ permission_mode: 7 }, { turn_id: false }, { model: {} }, { transcript_path: 7 }]) {
    assert.throws(() => buildPayload(registration('codex'), { ...event, data: { ...event.data, ...metadata }, dialectData: {} }), /PAYLOAD_INVALID/)
  }
  assert.throws(() => buildPayload(registration('codex', 'Stop'), { ...event, event: 'Stop', data: { ...event.data, stop_hook_active: 'false', last_assistant_message: null } }), /PAYLOAD_INVALID:stop_hook_active/)
})

test('maps patch input without inferring a tool from an arbitrary basename', async () => {
  const { buildPayload } = await import('../src/payload.js')
  assert.deepEqual(buildPayload(registration('codex'), { ...event, tool: 'apply_patch', toolInput: { patchText: 'patch' } }).tool_input, { command: 'patch' })
  assert.deepEqual(buildPayload(registration('claude-code'), { ...event, tool: 'vendor.edit' }).tool_input, event.toolInput)
})

test('absent native metadata is reported instead of fabricating artifacts, turns, or permission modes', async () => {
  const { buildPayload } = await import('../src/payload.js')
  assert.throws(() => buildPayload(registration('claude-code'), { ...event, data: {}, dialectData: {} }), /PAYLOAD_MISSING:transcript_path/)
  assert.throws(() => buildPayload(registration('codex'), { ...event, data: { model: 'model' } }), /PAYLOAD_MISSING:turn_id/)
  assert.throws(() => buildPayload(registration('codex'), { ...event, data: { model: 'model', turn_id: 'turn' } }), /PAYLOAD_MISSING:permission_mode/)
  const codex = buildPayload(registration('codex', 'SessionEnd'), { ...event, event: 'SessionEnd', data: { reason: 'other' }, dialectData: {} })
  assert.equal(codex.transcript_path, null)
  assert.equal(Object.hasOwn(codex, 'model'), false)
  assert.equal(Object.hasOwn(codex, 'permission_mode'), false)
  assert.throws(() => buildPayload(registration('claude-code', 'Stop'), event), /PAYLOAD_EVENT_MISMATCH/)
})

test('copies the documented Codex event fields and excludes fields from other events', async () => {
  const { buildPayload } = await import('../src/payload.js')
  const metadata = {
    model: 'model', turn_id: 'turn', permission_mode: 'default', tool_use_id: 'call', tool_response: { result: 'ok' },
    source: 'resume', reason: 'other', trigger: 'manual', prompt: 'hello', agent_id: 'agent', agent_type: 'reviewer',
    stop_hook_active: true, last_assistant_message: null, agent_transcript_path: '/artifacts/agent.jsonl',
    status: 'completed', error: null, token_usage: null,
  }
  const cases: Record<string, readonly string[]> = {
    SessionStart: ['model', 'permission_mode', 'source'],
    SessionEnd: ['reason'],
    SubagentStart: ['model', 'turn_id', 'permission_mode', 'agent_id', 'agent_type'],
    PreToolUse: ['model', 'turn_id', 'permission_mode', 'agent_id', 'agent_type', 'tool_use_id', 'tool_name', 'tool_input'],
    PermissionRequest: ['model', 'turn_id', 'permission_mode', 'agent_id', 'agent_type', 'tool_name', 'tool_input'],
    PostToolUse: ['model', 'turn_id', 'permission_mode', 'agent_id', 'agent_type', 'tool_use_id', 'tool_name', 'tool_input', 'tool_response'],
    PreCompact: ['model', 'turn_id', 'agent_id', 'agent_type', 'trigger'],
    PostCompact: ['model', 'turn_id', 'agent_id', 'agent_type', 'trigger'],
    UserPromptSubmit: ['model', 'turn_id', 'permission_mode', 'agent_id', 'agent_type', 'prompt'],
    SubagentStop: ['model', 'turn_id', 'permission_mode', 'agent_id', 'agent_type', 'agent_transcript_path', 'stop_hook_active', 'last_assistant_message'],
    Stop: ['model', 'turn_id', 'permission_mode', 'stop_hook_active', 'last_assistant_message'],
    Interrupt: ['model', 'turn_id', 'permission_mode'],
    PreModelRequest: ['model', 'turn_id', 'agent_id', 'agent_type'],
    PostModelRequest: ['model', 'turn_id', 'agent_id', 'agent_type', 'status', 'error', 'token_usage'],
  }
  for (const [name, fields] of Object.entries(cases)) {
    const payload = buildPayload(registration('codex', name), { ...event, event: name, data: metadata })
    assert.deepEqual(Object.keys(payload).sort(), ['session_id', 'cwd', 'hook_event_name', 'transcript_path', ...fields].sort(), name)
    assert.equal(payload.hook_event_name, name)
  }
})

test('metadata cannot override identity or native tool normalization and returned objects are independent', async () => {
  const { buildPayload } = await import('../src/payload.js')
  const payload = buildPayload(registration('claude-code'), { ...event, data: { ...event.data, session_id: 'wrong', cwd: 'wrong', hook_event_name: 'Stop', tool_name: 'wrong', tool_input: { command: 'wrong' } } })
  assert.equal(payload.session_id, 'session')
  assert.equal(payload.cwd, '/project')
  assert.equal(payload.hook_event_name, 'PreToolUse')
  assert.equal(payload.tool_name, 'Edit')
  ;(payload.tool_input as Record<string, unknown>).file_path = 'changed'
  assert.equal(event.toolInput?.filePath, 'a.ts')
})
