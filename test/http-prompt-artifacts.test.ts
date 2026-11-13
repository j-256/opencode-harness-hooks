import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { executeRegistration } from '../src/handlers.js'
import { PromptAttachments } from '../src/prompt-attachments.js'
import { Sessions } from '../src/sessions.js'
import type { DispatchResult } from '../src/engine.js'
import type { HookEffect } from '../src/effect-types.js'
import type { HostPromptEvent } from '../src/prompt-types.js'

async function fixture(t: { after: (callback: () => Promise<void>) => void }) {
  const service = createServer((_request, response) => response.end(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'HTTP_CONTEXT' } })))
  service.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => service.once('listening', resolve))
  const address = service.address()
  assert.ok(address && typeof address === 'object')
  const sessions = new Sessions()
  sessions.prompt('session', 'turn', 'fixture')
  t.after(async () => { sessions.dispose(); service.closeAllConnections(); await new Promise<void>(resolve => service.close(() => resolve())) })
  const session = sessions.get('session')
  const event: HostPromptEvent = { host: 'v1', event: 'UserPromptSubmit', sessionID: 'session', messageID: 'turn', prompt: 'User prompt', signal: session.turnSignal }
  const result = await executeRegistration({ id: 'http', sourceID: 'source', dialect: 'claude-code', event: 'UserPromptSubmit', groupIndex: 0, handlerIndex: 0, handler: { type: 'http', url: `http://127.0.0.1:${address.port}/hook` } }, { host: 'v1', event: 'UserPromptSubmit', sessionID: 'session', cwd: '/project', data: { prompt: event.prompt, transcript_path: '/provided/transcript.jsonl', permission_mode: 'default' } }, { environment: {}, projectRoot: '/project', captureHttpArtifacts: true }) as HookEffect
  const dispatch = (value = result): DispatchResult => {
    const origin = { sourceID: 'source', sourceDigest: 'digest', registrationID: 'http', dialect: 'claude-code' as const, configuredOrder: 0, completionOrder: 0 }
    return { entries: [{ ...origin, result: value }], actions: value.actions.map(action => ({ ...origin, action })), cancelled: false, diagnostic: { dispatchID: 'dispatch', sessionID: 'session', event: 'UserPromptSubmit', durationMs: 1, cancelled: false, failed: 0, unsupported: 0, skipped: 0, background: 0, handlers: [] } }
  }
  return { session, event, result, dispatch }
}

test('HTTP prompt context admits the independently observed native attachment without inventing command execution', async t => {
  const f = await fixture(t)
  assert.equal(f.result.status, 'success')
  assert.equal(f.result.httpArtifact?.kind, 'http')
  assert.equal(f.result.commandArtifact, undefined)
  const attachments = new PromptAttachments()
  attachments.admit(f.event, f.session, f.dispatch())
  const rows = attachments.read('session', 'turn', 'User prompt')
  assert.equal(rows.length, 1)
  const body = rows[0]!.body as any
  assert.equal(body.attachment.type, 'hook_additional_context')
  assert.deepEqual(body.attachment.content, ['HTTP_CONTEXT'])
  assert.equal(body.attachment.hookName, 'UserPromptSubmit')
  assert.match(body.attachment.toolUseID, /^hook-/)
  assert.deepEqual(body.rendered, [{ content: '<system-reminder>\nUserPromptSubmit hook additional context: HTTP_CONTEXT\n</system-reminder>' }])
  assert.equal(body.renderedRole, 'system')
  assert.equal(body.attachment.command, undefined)
  assert.equal(body.attachment.stdout, undefined)
  const restored = new PromptAttachments(), next = new Sessions()
  restored.restore(next.get('session'), attachments.snapshot('session'))
  assert.deepEqual(restored.read('session', 'turn', 'User prompt'), rows)
  restored.dispose(); next.dispose()
  attachments.dispose()
})

test('HTTP admission does not accept missing or malformed execution ownership or invent stdout artifacts', async t => {
  const f = await fixture(t)
  for (const httpArtifact of [undefined, { kind: 'other', completedAt: Date.now(), durationMs: 1 }, { kind: 'http', completedAt: NaN, durationMs: 1 }, { kind: 'http', completedAt: Date.now(), durationMs: -1 }]) {
    const attachments = new PromptAttachments()
    assert.throws(() => attachments.admit(f.event, f.session, f.dispatch({ ...f.result, httpArtifact } as HookEffect)), { code: 'TRANSCRIPT_HOOK_EXECUTION_UNAVAILABLE' })
    assert.equal(attachments.inspect().promptTurns, 0)
    attachments.dispose()
  }
  const attachments = new PromptAttachments()
  assert.throws(() => attachments.admit(f.event, f.session, f.dispatch({ ...f.result, actions: [{ kind: 'context', placement: 'model', channel: 'stdout', text: 'FAKE_STDOUT' }] })), { code: 'TRANSCRIPT_HOOK_EFFECT_UNSUPPORTED' })
  assert.equal(attachments.inspect().promptTurns, 0)
  attachments.dispose()
})

test('HTTP no-op receipts admit no artifacts and ambiguous or failed receipts cannot partially admit', async t => {
  const f = await fixture(t)
  const attachments = new PromptAttachments()
  attachments.admit(f.event, f.session, f.dispatch({ ...f.result, actions: [] }))
  assert.deepEqual(attachments.read('session', 'turn', 'User prompt'), [])
  attachments.dispose()
  for (const result of [
    { ...f.result, commandArtifact: { status: 'exited', exitCode: 0, signal: null, stdout: '', stderr: '', durationMs: 1, command: 'fixture', completedAt: Date.now(), timeoutMs: null } },
    { ...f.result, status: 'failed', code: 'HTTP_STATUS' },
  ]) {
    const rejected = new PromptAttachments()
    assert.throws(() => rejected.admit(f.event, f.session, f.dispatch(result as HookEffect)), { code: 'TRANSCRIPT_HOOK_EXECUTION_UNAVAILABLE' })
    assert.equal(rejected.inspect().promptTurns, 0)
    rejected.dispose()
  }
})
