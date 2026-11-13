import assert from 'node:assert/strict'
import { test } from 'node:test'
import { executeRegistration } from '../src/handlers.js'
import { ModelApiError } from '../src/model-artifact.js'
import { HookServiceError } from '../src/service-execution.js'
import { PromptAttachments } from '../src/prompt-attachments.js'
import { Sessions } from '../src/sessions.js'
import type { DispatchResult } from '../src/engine.js'
import type { AgentHookRequest } from '../src/host-services.js'
import type { Registration } from '../src/types.js'

const PROMPT = 'OWNED_AGENT_CONDITION $ARGUMENTS'
const codes = { allow: 'MODEL_EVALUATED', deny: 'MODEL_EVALUATED', timeout: 'EXECUTION_TIMEOUT', limit: 'AGENT_TURN_LIMIT', api: 'MODEL_REQUEST_FAILED' }
for (const mode of ['allow', 'deny', 'timeout', 'limit', 'api'] as const) test(`native agent ${mode} preserves measured prompt admission without invented attachments`, async () => {
  const sessions = new Sessions(), records = new PromptAttachments(), restored = new PromptAttachments(), next = new Sessions()
  sessions.prompt('host-parent', 'turn', 'fixture')
  const session = sessions.get('host-parent'), registration: Registration = { id: 'registration', sourceID: 'source', dialect: 'claude-code', event: 'UserPromptSubmit', groupIndex: 0, handlerIndex: 0, handler: { type: 'agent', prompt: PROMPT, timeout: mode === 'timeout' ? 0.01 : 1 } }
  const event = { host: 'v1' as const, event: 'UserPromptSubmit', sessionID: 'host-parent', cwd: '/project', nativeSessionIDs: { 'claude-code': 'native-parent' }, data: { prompt: 'Original', transcript_path: '/artifacts/reserved.jsonl', permission_mode: 'bypassPermissions' } }
  let request: AgentHookRequest | undefined
  const effect = await executeRegistration(registration, event, { projectRoot: '/project', environment: {}, captureModelArtifacts: true, runAgent: async input => {
    request = input
    if (mode === 'timeout') return new Promise(() => {})
    if (mode === 'limit') throw new HookServiceError('AGENT_TURN_LIMIT')
    if (mode === 'api') throw new ModelApiError('PRIVATE_PROVIDER_BODY')
    return mode === 'deny' ? { ok: false, reason: 'OWNED_AGENT_DENIAL' } : { ok: true }
  } })
  assert.equal(effect.code, codes[mode])
  assert.ok(request)
  assert.equal(request.maxTurns, 50)
  assert.equal(request.sessionID, 'host-parent')
  assert.deepEqual(request.context, { host: 'v1', dialect: 'claude-code', event: 'UserPromptSubmit', sourceID: 'source', registrationID: 'registration', nativeInput: { session_id: 'native-parent', transcript_path: '/artifacts/reserved.jsonl', cwd: '/project', permission_mode: 'bypassPermissions', hook_event_name: 'UserPromptSubmit', prompt: 'Original' } })
  assert.ok('modelArtifact' in effect && effect.modelArtifact && effect.modelArtifact.kind === 'agent-model')
  assert.ok(!JSON.stringify(effect.diagnostic).includes('PRIVATE_PROVIDER_BODY'))
  assert.ok(!JSON.stringify(effect.modelArtifact).includes(PROMPT))
  assert.equal('commandArtifact' in effect, false)
  const dispatch: DispatchResult = { entries: [{ sourceID: 'source', sourceDigest: 'a'.repeat(64), registrationID: 'registration', dialect: 'claude-code', configuredOrder: 0, completionOrder: 0, result: effect }], actions: effect.actions.map(action => ({ sourceID: 'source', sourceDigest: 'a'.repeat(64), registrationID: 'registration', dialect: 'claude-code' as const, configuredOrder: 0, completionOrder: 0, action })), cancelled: false, diagnostic: { dispatchID: 'dispatch', sessionID: 'host-parent', event: 'UserPromptSubmit', durationMs: 1, cancelled: false, failed: mode === 'allow' || mode === 'deny' ? 0 : 1, unsupported: 0, skipped: 0, background: 0, handlers: [] } }
  const prompt = { host: 'v1' as const, event: 'UserPromptSubmit' as const, sessionID: 'host-parent', messageID: 'turn', prompt: 'Original', signal: session.turnSignal }
  if (mode === 'deny') assert.throws(() => records.admit(prompt, session, dispatch), { code: 'TRANSCRIPT_PROMPT_NOT_ADMITTED' })
  else {
    records.admit(prompt, session, dispatch)
    assert.deepEqual(records.read('host-parent', 'turn', 'Original'), [])
    const snapshot = records.snapshot('host-parent')
    restored.restore(next.get('host-parent'), snapshot)
    assert.deepEqual(restored.snapshot('host-parent'), snapshot)
  }
  records.dispose(); restored.dispose(); sessions.dispose(); next.dispose()
})

test('agent provenance is deeply immutable and preserves host and native parent identities separately', async () => {
  const registration: Registration = { id: 'registration', sourceID: 'source', dialect: 'claude-code', event: 'PreToolUse', groupIndex: 0, handlerIndex: 0, handler: { type: 'agent', prompt: PROMPT, model: 'native-evaluator' } }
  const effect = await executeRegistration(registration, { host: 'v1', event: 'PreToolUse', sessionID: 'host-parent', cwd: '/project', tool: 'Bash', toolInput: { command: 'OWNED_COMMAND' }, nativeSessionIDs: { 'claude-code': 'native-parent' }, data: { tool_use_id: 'call', transcript_path: '/artifacts/reserved.jsonl', permission_mode: 'bypassPermissions' } }, { projectRoot: '/project', environment: {}, runAgent: async request => {
    assert.ok(Object.isFrozen(request.context))
    assert.ok(Object.isFrozen(request.context!.nativeInput))
    assert.ok(Object.isFrozen(request.context!.nativeInput.tool_input))
    assert.throws(() => { (request.context!.nativeInput.tool_input as Record<string, unknown>).command = 'FORGED' }, TypeError)
    assert.equal(request.sessionID, 'host-parent')
    assert.equal(request.context!.nativeInput.session_id, 'native-parent')
    assert.equal(request.model, 'native-evaluator')
    return { ok: true }
  } })
  assert.equal(effect.status, 'success')
})

test('agent evidence is opt-in and cancellation or output limits cannot retain a private success receipt', { timeout: 5000 }, async () => {
  const registration: Registration = { id: 'registration', sourceID: 'source', dialect: 'claude-code', event: 'UserPromptSubmit', groupIndex: 0, handlerIndex: 0, handler: { type: 'agent', prompt: PROMPT } }
  const event = { host: 'v1' as const, event: 'UserPromptSubmit', sessionID: 'parent', cwd: '/project', data: { prompt: 'Original', transcript_path: '/artifacts/reserved.jsonl', permission_mode: 'bypassPermissions' } }
  const ordinary = await executeRegistration(registration, event, { projectRoot: '/project', environment: {}, runAgent: async () => ({ ok: true }) })
  assert.equal('modelArtifact' in ordinary, false)
  const limited = await executeRegistration(registration, event, { projectRoot: '/project', environment: {}, captureModelArtifacts: true, maxOutputBytes: 4, runAgent: async () => { throw new ModelApiError('PRIVATE_LARGE_PROVIDER_BODY') } })
  assert.equal(limited.code, 'EXECUTION_OUTPUT_LIMIT')
  assert.equal('modelArtifact' in limited, false)
  assert.ok(!JSON.stringify(limited).includes('PRIVATE_LARGE_PROVIDER_BODY'))
  const controller = new AbortController()
  let entered!: () => void, finish!: (value: unknown) => void
  const ready = new Promise<void>(resolve => { entered = resolve })
  const pending = executeRegistration(registration, event, { projectRoot: '/project', environment: {}, captureModelArtifacts: true, signal: controller.signal, runAgent: async () => { entered(); return new Promise(resolve => { finish = resolve }) } })
  await ready; controller.abort()
  const cancelled = await pending; finish({ ok: true })
  assert.equal(cancelled.code, 'EXECUTION_CANCELLED')
  assert.equal('modelArtifact' in cancelled, false)
})
