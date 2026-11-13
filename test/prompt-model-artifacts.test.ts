import assert from 'node:assert/strict'
import { test } from 'node:test'
import { executeRegistration } from '../src/handlers.js'
import { PromptAttachments } from '../src/prompt-attachments.js'
import { Sessions } from '../src/sessions.js'
import { ModelApiError, ModelOutputError } from '../src/model-artifact.js'
import type { DispatchResult } from '../src/engine.js'
import type { Registration } from '../src/types.js'

const PROMPT = 'OWNED_MODEL_RULE $ARGUMENTS'
for (const mode of ['allow', 'invalid', 'timeout', 'api-error'] as const) test(`native prompt-model ${mode} evidence admits only its measured UserPromptSubmit artifacts`, async () => {
  const sessions = new Sessions(), records = new PromptAttachments(), restored = new PromptAttachments(), next = new Sessions()
  sessions.prompt('session', 'turn', 'fixture')
  const session = sessions.get('session')
  const registration: Registration = { id: 'registration', sourceID: 'source', dialect: 'claude-code', event: 'UserPromptSubmit', groupIndex: 0, handlerIndex: 0, handler: { type: 'prompt', prompt: PROMPT, timeout: mode === 'timeout' ? 0.01 : 1 } }
  const effect = await executeRegistration(registration, { host: 'v1', event: 'UserPromptSubmit', sessionID: 'session', cwd: '/project', data: { prompt: 'Original', transcript_path: '/artifacts/transcript.jsonl', permission_mode: 'default' } }, { projectRoot: '/project', environment: {}, captureModelArtifacts: true, evaluatePrompt: async request => { assert.ok(request.prompt.includes('"prompt":"Original"')); if (mode === 'api-error') throw new ModelApiError('Hook evaluator API error: API Error: 400 OWNED_PROVIDER_ERROR'); return mode === 'timeout' ? new Promise(() => {}) : mode === 'invalid' ? 'MALFORMED_DECISION' : { ok: true } } })
  assert.equal(effect.status, mode === 'allow' ? 'success' : 'failed')
  assert.ok('modelArtifact' in effect && effect.modelArtifact)
  assert.equal('commandArtifact' in effect, false)
  assert.ok(!JSON.stringify(effect.diagnostic).includes('MALFORMED_DECISION'))
  assert.ok(!JSON.stringify(effect.diagnostic).includes(PROMPT))
  const dispatch: DispatchResult = { entries: [{ sourceID: 'source', sourceDigest: 'a'.repeat(64), registrationID: 'registration', dialect: 'claude-code', configuredOrder: 0, completionOrder: 0, result: effect }], actions: [], cancelled: false, diagnostic: { dispatchID: 'dispatch', sessionID: 'session', event: 'UserPromptSubmit', durationMs: 1, cancelled: false, failed: mode === 'allow' ? 0 : 1, unsupported: 0, skipped: 0, background: 0, handlers: [] } }
  const event = { host: 'v1' as const, event: 'UserPromptSubmit' as const, sessionID: 'session', messageID: 'turn', prompt: 'Original', signal: session.turnSignal }
  records.admit(event, session, dispatch)
  const attachments = records.read('session', 'turn', 'Original')
  if (mode === 'invalid' || mode === 'api-error') {
    assert.equal(attachments.length, 1)
    const attachment = attachments[0]!.body.attachment
    assert.ok(attachment && typeof attachment === 'object' && 'toolUseID' in attachment && typeof attachment.toolUseID === 'string')
    assert.deepEqual(attachment, { type: 'hook_non_blocking_error', hookName: 'UserPromptSubmit', hookEvent: 'UserPromptSubmit', toolUseID: attachment.toolUseID, stderr: mode === 'api-error' ? 'Hook evaluator API error: API Error: 400 OWNED_PROVIDER_ERROR' : 'JSON validation failed', stdout: mode === 'api-error' ? '' : 'MALFORMED_DECISION', exitCode: 1, command: PROMPT, durationMs: effect.diagnostic.durationMs })
  } else assert.deepEqual(attachments, [])
  const snapshot = records.snapshot('session')
  records.dispose(); sessions.dispose()
  restored.restore(next.get('session'), snapshot)
  assert.deepEqual(restored.snapshot('session'), snapshot)
  restored.dispose(); next.dispose()
})

test('private prompt-model evidence is opt-in and cancellation cannot admit a late decision', { timeout: 5000 }, async () => {
  const registration: Registration = { id: 'registration', sourceID: 'source', dialect: 'claude-code', event: 'UserPromptSubmit', groupIndex: 0, handlerIndex: 0, handler: { type: 'prompt', prompt: PROMPT } }
  const event = { host: 'v1' as const, event: 'UserPromptSubmit', sessionID: 'session', cwd: '/project', data: { prompt: 'Original', transcript_path: '/artifacts/transcript.jsonl', permission_mode: 'default' } }
  const ordinary = await executeRegistration(registration, event, { projectRoot: '/project', environment: {}, evaluatePrompt: async () => 'MALFORMED_DECISION' })
  assert.equal('modelArtifact' in ordinary, false)
  assert.ok(!JSON.stringify(ordinary).includes('MALFORMED_DECISION'))
  const controller = new AbortController()
  let entered!: () => void, finish!: (value: unknown) => void
  const ready = new Promise<void>(resolve => { entered = resolve })
  const pending = executeRegistration(registration, event, { projectRoot: '/project', environment: {}, captureModelArtifacts: true, signal: controller.signal, evaluatePrompt: async () => { entered(); return new Promise(resolve => { finish = resolve }) } })
  await ready; controller.abort()
  const cancelled = await pending; finish({ ok: true })
  assert.equal(cancelled.code, 'EXECUTION_CANCELLED')
  assert.equal('modelArtifact' in cancelled, false)
})

test('an oversized raw model failure cannot bypass the configured output budget through private evidence', async () => {
  const registration: Registration = { id: 'registration', sourceID: 'source', dialect: 'claude-code', event: 'UserPromptSubmit', groupIndex: 0, handlerIndex: 0, handler: { type: 'prompt', prompt: PROMPT } }
  const effect = await executeRegistration(registration, { event: 'UserPromptSubmit', sessionID: 'session', cwd: '/project', data: { prompt: 'Original', transcript_path: '/artifacts/transcript.jsonl', permission_mode: 'default' } }, { projectRoot: '/project', environment: {}, captureModelArtifacts: true, maxOutputBytes: 4, evaluatePrompt: async () => { throw new ModelOutputError('MALFORMED_DECISION') } })
  assert.equal(effect.code, 'EXECUTION_OUTPUT_LIMIT')
  assert.equal('modelArtifact' in effect, false)
  assert.ok(!JSON.stringify(effect).includes('MALFORMED_DECISION'))
})
