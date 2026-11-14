import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { V1AgentModels, AGENT_VERDICT_TOOL } from '../src/hosts/agent-v1.js'
import type { V1ModelClient } from '../src/hosts/model-v1.js'
import { boundedModelResponse } from '../src/hosts/model-response.js'
import { Sessions } from '../src/sessions.js'

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'v1-agent-model-'))), sessions = new Sessions()
  sessions.prompt('parent', 'turn', 'parent-model')
  let models!: V1AgentModels, sequence = 0, invalid = false, foreign = false, limit = false, failedDelete = false, restricted = false, missingPolicy = false, incomplete = false, apiError = false
  let hold: (() => Promise<void>) | undefined, omitFence = false, wrongError = false, wrongErrorText = false, wrongMessage = false, fencedAssistant = false, copied: (() => void) | undefined
  const calls: { phase: string; sessionID?: string; tool?: string; value?: unknown }[] = [], children = new Set<string>(), diagnostics: unknown[] = []
  const client: V1ModelClient = { app: { agents: async () => ({ data: [{ name: 'build', permission: [{ permission: '*', pattern: '*', action: 'allow' }, ...(restricted ? [{ permission: 'bash', pattern: '*', action: 'deny' }] : [])] }] }) }, session: {
    get: async () => ({ data: { id: 'parent', directory, agent: 'build' } }),
    create: async request => { calls.push({ phase: 'create', value: request.body }); const info = { ...(missingPolicy ? {} : { permission: request.body.permission }), id: 'child-' + ++sequence, parentID: request.body.parentID, title: request.body.title, directory }; children.add(info.id); models.event('session.created', { info }); return { data: info } },
    prompt: async request => {
      calls.push({ phase: 'prompt', value: request.body })
      const sessionID = request.path.id, model = request.body.model, message = { id: request.body.messageID, agent: request.body.agent }, resolved = { providerID: model.providerID, id: model.modelID }
      models.message({ sessionID, model }, { message, parts: request.body.parts })
      const system = { system: ['PRIVATE_PROJECT_INSTRUCTIONS'] }; models.system({ sessionID, model: resolved }, system); assert.ok(!JSON.stringify(system).includes('PRIVATE_PROJECT_INSTRUCTIONS'))
      const params = { sessionID, agent: message.agent, message, model: resolved }
      if (hold) await hold()
      if (limit) for (let n = 0; n < 51; n++) models.headers(params)
      models.headers(params)
      models.event('message.updated', { info: { id: 'answer', sessionID, parentID: message.id, role: 'assistant' } })
      if (incomplete) return { data: { info: { id: 'answer', sessionID, parentID: message.id, role: 'assistant', modelID: model.modelID, providerID: model.providerID }, parts: [{ type: 'text', text: 'No verdict' }] } }
      if (apiError) { const headers: Record<string, string> = {}; models.requestHeaders(params, headers); await models.fetch(model.providerID, async () => { calls.push({ phase: 'provider' }); return new Response(JSON.stringify({ error: { message: 'PRIVATE_API_ERROR' } }), { status: 400 }) }, 'https://fixture.invalid/chat/completions', { method: 'POST', headers, body: '{}' }) }
      const call = { sessionID, callID: 'read-call', tool: 'read' }
      await models.beforeTool(call, { args: { filePath: join(directory, 'owned.txt') } })
      await models.afterTool({ ...call, args: { filePath: join(directory, 'owned.txt') } }, { title: 'Read', output: 'OWNED_RESULT', metadata: {} })
      models.headers(params)
      const verdictCall = { sessionID, callID: 'verdict-call', tool: AGENT_VERDICT_TOOL }
      const args = invalid ? { ok: 'wrong', reason: 'PRIVATE_BAD_VERDICT' } : { ok: false, reason: 'Owned rejection' }
      await models.beforeTool(verdictCall, { args })
      await models.verdictTool.execute(args, { sessionID: foreign ? 'foreign' : sessionID, messageID: 'answer', callID: verdictCall.callID, agent: message.agent, abort: request.signal })
      await models.afterTool({ ...verdictCall, args }, { title: 'Verdict', output: 'Captured', metadata: {} })
      if (copied) copied()
      if (!omitFence) assert.throws(() => models.headers(params), { code: 'HOST_AGENT_VERDICT_CAPTURED' })
      if (fencedAssistant) models.event('message.updated', { info: { id: 'fenced-answer', sessionID, parentID: message.id, role: 'assistant' } })
      return { data: { info: { id: fencedAssistant ? 'fenced-answer' : wrongMessage ? 'foreign-answer' : 'answer', sessionID, parentID: message.id, role: 'assistant', modelID: model.modelID, providerID: model.providerID, error: { name: wrongError ? 'APIError' : 'UnknownError', data: { message: wrongErrorText ? 'UNRELATED_SDK_ERROR' : 'HOST_AGENT_VERDICT_CAPTURED' } } }, parts: [] } }
    },
    abort: async () => ({ data: true }),
    delete: async request => { if (failedDelete) return { data: false }; children.delete(request.path.id); return { data: true } },
    children: async () => ({ data: [] }),
  } }
  models = await V1AgentModels.create({ directory, client, diagnostic: value => { diagnostics.push(value) }, nested: {
    before: async (execution, input) => { calls.push({ phase: 'before', sessionID: input.sessionID, tool: input.tool, value: execution }) },
    after: async (_execution, input) => { calls.push({ phase: 'after', sessionID: input.sessionID, tool: input.tool }) },
  } })
  models.attach(sessions, { agentModel: 'fixture/cheap', modelAliases: { native: 'mapped/native' } })
  const config: { model?: string; permission?: Record<string, unknown>; agent?: Record<string, unknown> } = { model: 'fixture/default', permission: { bash: { '*': 'ask', 'rm *': 'deny' }, read: 'allow' } }
  models.configure(config); models.observe('parent', 'turn', { providerID: 'fixture', modelID: 'parent-model' })
  const context = { host: 'v1' as const, dialect: 'claude-code' as const, event: 'UserPromptSubmit', sourceID: 'source', registrationID: 'registration', nativeInput: { session_id: 'native-parent', permission_mode: 'bypassPermissions' } }
  const request = (signal = sessions.get('parent').turnSignal, model?: string) => ({ prompt: 'OWNED_RULE', sessionID: 'parent', cwd: directory, maxTurns: 50, context, signal, ...(model ? { model } : {}) })
  t.after(async () => { failedDelete = false; await models.dispose(); sessions.dispose(); await rm(directory, { recursive: true, force: true }) })
  return { incomplete: () => { incomplete = true }, apiError: () => { apiError = true }, restrict: () => { restricted = true }, omitPolicy: () => { missingPolicy = true }, models, calls, children, diagnostics, config, request, invalid: () => { invalid = true }, foreign: () => { foreign = true }, limit: () => { limit = true }, failDelete: (value: boolean) => { failedDelete = value }, hold: (fn: () => Promise<void>) => { hold = fn }, omitFence: () => { omitFence = true }, wrongError: () => { wrongError = true }, wrongErrorText: () => { wrongErrorText = true }, wrongMessage: () => { wrongMessage = true }, fencedAssistant: () => { fencedAssistant = true }, copied: (fn: () => void) => { copied = fn } }
}

test('agent evaluator permits owned multi-turn tools and captures a validated call-bound verdict', async t => {
  const f = await fixture(t)
  assert.deepEqual({ ...await f.models.evaluate(f.request()) }, { ok: false, reason: 'Owned rejection' })
  assert.deepEqual(f.calls.filter(row => row.phase === 'before').map(row => row.tool), ['read', AGENT_VERDICT_TOOL])
  const execution = f.calls.find(row => row.phase === 'before')!.value as { parentID: string; context: { nativeInput: { session_id: string } } }
  assert.equal(execution.parentID, 'parent'); assert.equal(execution.context.nativeInput.session_id, 'native-parent')
  const body = f.calls.find(row => row.phase === 'prompt')!.value as Record<string, unknown>
  assert.equal(body.format, undefined); assert.equal(body.tools, undefined)
  assert.deepEqual(body.model, { providerID: 'fixture', modelID: 'cheap' })
  assert.equal(f.children.size, 0)
})

test('agent verdict callback rejects invalid cooked arguments even when the host ignores schema validation', async t => {
  const f = await fixture(t); f.invalid()
  await assert.rejects(f.models.evaluate(f.request()), { code: 'MODEL_OUTPUT_INVALID' })
  assert.ok(!JSON.stringify(f.diagnostics).includes('PRIVATE_BAD_VERDICT')); assert.equal(f.children.size, 0)
})

test('foreign agent verdict callbacks have no approval authority', async t => {
  const f = await fixture(t); f.foreign()
  await assert.rejects(f.models.evaluate(f.request()), { code: 'HOST_MODEL_SESSION_CLOSED' }); assert.equal(f.children.size, 0)
  await assert.rejects(f.models.verdictTool.execute({ ok: true }, { sessionID: 'ordinary', callID: 'forged', messageID: 'forged', agent: 'build', abort: new AbortController().signal }))
})

test('agent inference delegation ends at the native turn limit', async t => {
  const f = await fixture(t); f.limit()
  await assert.rejects(f.models.evaluate(f.request()), { code: 'AGENT_TURN_LIMIT' }); assert.equal(f.children.size, 0)
})

test('agent source model aliases take precedence over the configured cheap model', async t => {
  const f = await fixture(t); await f.models.evaluate(f.request(undefined, 'native'))
  assert.deepEqual((f.calls.find(row => row.phase === 'prompt')!.value as { model: unknown }).model, { providerID: 'mapped', modelID: 'native' })
})

test('cancelled agent work cannot publish a late verdict', async t => {
  const f = await fixture(t), controller = new AbortController()
  let entered!: () => void, finish!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  f.hold(async () => { entered(); await new Promise<void>(resolve => { finish = resolve }) })
  const pending = f.models.evaluate(f.request(controller.signal)); await started; controller.abort()
  await assert.rejects(pending, { code: 'EXECUTION_CANCELLED' }); finish(); assert.equal(f.children.size, 0)
})

test('negative agent cleanup receipts remain inspectable and are retried on disposal', async t => {
  const f = await fixture(t); f.failDelete(true)
  await f.models.evaluate(f.request()); assert.equal(f.models.inspect().cleanupFailed, 1)
  f.failDelete(false); await f.models.dispose(); assert.equal(f.children.size, 0)
})

test('agent provider responses preserve tool bytes while enforcing bounded streaming and cancellation', async () => {
  const signal = new AbortController()
  assert.equal(await boundedModelResponse(new Response('owned-tool-bytes'), signal.signal).text(), 'owned-tool-bytes')
  await assert.rejects(boundedModelResponse(new Response('x'.repeat(9)), signal.signal, 8).text(), { code: 'EXECUTION_OUTPUT_LIMIT' })
  let cancelled = false
  const raw = new Response(new ReadableStream({ pull() {}, cancel() { cancelled = true } }))
  const pending = boundedModelResponse(raw, signal.signal).text(); signal.abort()
  await assert.rejects(pending, { code: 'EXECUTION_CANCELLED' }); assert.equal(cancelled, true)
})

test('a captured verdict cannot authorize an arbitrary SDK error without the deliberate owned fence', async t => {
  const f = await fixture(t); f.omitFence()
  await assert.rejects(f.models.evaluate(f.request()), { code: 'AGENT_VERDICT_UNAVAILABLE' })
})

test('an unrelated SDK error and a different assistant cannot carry a captured agent verdict', async t => {
  const f = await fixture(t); f.wrongError()
  await assert.rejects(f.models.evaluate(f.request()), { code: 'AGENT_VERDICT_UNAVAILABLE' })
  const g = await fixture(t); g.wrongMessage()
  await assert.rejects(g.models.evaluate(g.request()), { code: 'AGENT_VERDICT_UNAVAILABLE' })
})

test('nested source provenance is a private copy and model-session config retains host denies', async t => {
  const f = await fixture(t), request = f.request()
  f.copied(() => { request.context.nativeInput.session_id = 'changed-after-submit' })
  await f.models.evaluate(request)
  const recorded = f.calls.find(row => row.phase === 'before')!.value as { context: { nativeInput: { session_id: string } } }
  assert.equal(recorded.context.nativeInput.session_id, 'native-parent')
  const agent = (f.calls.find(row => row.phase === 'prompt')!.value as { agent: string }).agent
  const config = f.config.agent![agent] as { permission: Record<string, unknown> }
  assert.deepEqual(config.permission.bash, { '*': 'ask', 'rm *': 'deny' })
})

test('an owned UnknownError with unrelated content cannot masquerade as the verdict fence', async t => {
  const f = await fixture(t); f.wrongErrorText()
  await assert.rejects(f.models.evaluate(f.request()), { code: 'AGENT_VERDICT_UNAVAILABLE' })
})

test('removing a parent fences an in-flight agent even when the caller signal remains live', async t => {
  const f = await fixture(t), controller = new AbortController()
  let entered!: () => void, finish!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  f.hold(async () => { entered(); await new Promise<void>(resolve => { finish = resolve }) })
  const pending = f.models.evaluate(f.request(controller.signal)); await started
  await f.models.removeSession('parent'); finish()
  await assert.rejects(pending, { code: 'EXECUTION_CANCELLED' })
})

test('the stock host completion fence may return a separately observed owned assistant message', async t => {
  const f = await fixture(t); f.fencedAssistant()
  assert.deepEqual({ ...await f.models.evaluate(f.request()) }, { ok: false, reason: 'Owned rejection' })
})

test('agent turn exhaustion allows the host completion message without permitting another inference', async t => {
  const f = await fixture(t)
  f.hold(async () => {
    const sessionID = 'child-1', message = { id: (f.calls.find(row => row.phase === 'prompt')!.value as { messageID: string }).messageID }
    const params = { sessionID, agent: 'opencode-harness-hooks-agent', message, model: { providerID: 'fixture', id: 'cheap' } }
    for (let index = 0; index < 50; index++) {
      f.models.event('message.updated', { info: { id: 'reply-' + index, sessionID, parentID: message.id, role: 'assistant' } })
      f.models.headers(params)
    }
    f.models.event('message.updated', { info: { id: 'terminal-reply', sessionID, parentID: message.id, role: 'assistant' } })
    f.models.headers(params)
  })
  await assert.rejects(f.models.evaluate(f.request()), { code: 'AGENT_TURN_LIMIT' })
})

test('reconfiguring an owned evaluator preserves a newly tightened host permission rule', async t => {
  const f = await fixture(t)
  f.config.permission!.read = 'deny'; f.models.configure(f.config)
  await f.models.evaluate(f.request())
  const name = (f.calls.find(row => row.phase === 'prompt')!.value as { agent: string }).agent
  assert.equal((f.config.agent![name] as { permission: Record<string, unknown> }).permission.read, 'deny')
})

test('a host-wide deny cannot be widened by agent default read permissions', async t => {
  const f = await fixture(t)
  f.config.permission = { '*': 'deny' }; f.models.configure(f.config)
  await f.models.evaluate(f.request())
  const name = (f.calls.find(row => row.phase === 'prompt')!.value as { agent: string }).agent
  const rules = Object.entries((f.config.agent![name] as { permission: Record<string, unknown> }).permission)
  const readDecision = rules.filter(([permission]) => permission === '*' || permission === 'read').at(-1)?.[1]
  assert.equal(readDecision, 'deny')
})

test('external deletion of an evaluator invalidates a still-live parent evaluation', async t => {
  const f = await fixture(t)
  f.hold(async () => { f.children.delete('child-1'); f.models.event('session.deleted', { info: { id: 'child-1' } }) })
  await assert.rejects(f.models.evaluate(f.request()), { code: 'EXECUTION_CANCELLED' })
})


test('the owned child inherits resolved caller-agent restrictions before receiving a prompt', async t => {
  const f = await fixture(t); f.restrict()
  await f.models.evaluate(f.request())
  const body = f.calls.find(row => row.phase === 'create')!.value as { permission?: { permission: string; action: string }[] }
  assert.ok(body.permission?.some(rule => rule.permission === 'bash' && rule.action === 'deny'))
})

test('a missing per-child permission receipt prevents all model delegation', async t => {
  const f = await fixture(t); f.omitPolicy()
  await assert.rejects(f.models.evaluate(f.request()), { code: 'HOST_AGENT_PERMISSION_POLICY_MISMATCH' })
  assert.equal(f.calls.some(row => row.phase === 'prompt'), false); assert.equal(f.children.size, 0)
})

test('an unverified host policy is diagnosed as unsupported rather than a native hook failure', async t => {
  const f = await fixture(t); f.omitPolicy()
  const { executeRegistration } = await import('../src/handlers.js')
  const result = await executeRegistration({ id: 'agent:fixture', sourceID: 'native', dialect: 'claude-code', event: 'UserPromptSubmit', groupIndex: 0, handlerIndex: 0, handler: { type: 'agent', prompt: 'OWNED_RULE' } }, { host: 'v1', event: 'UserPromptSubmit', sessionID: 'parent', cwd: f.request().cwd, data: { prompt: 'Original', transcript_path: '/owned/reserved.jsonl', permission_mode: 'default' } }, { environment: {}, projectRoot: f.request().cwd, runAgent: request => f.models.evaluate(request) })
  assert.equal(result.status, 'unsupported'); assert.equal(result.code, 'HOST_AGENT_PERMISSION_POLICY_MISMATCH')
})


test('malformed verdicts never reach nested tool policies', async t => {
  const f = await fixture(t); f.invalid()
  await assert.rejects(f.models.evaluate(f.request()), { code: 'MODEL_OUTPUT_INVALID' })
  assert.equal(f.calls.some(row => row.phase === 'before' && row.tool === AGENT_VERDICT_TOOL), false)
})

test('a clean completion without a verdict gets one owned continuation before a classified incomplete outcome', async t => {
  const f = await fixture(t); f.incomplete()
  await assert.rejects(f.models.evaluate(f.request()), { code: 'AGENT_INCOMPLETE' })
  assert.equal(f.calls.filter(row => row.phase === 'prompt').length, 2)
  assert.equal(f.children.size, 0)
})

test('agent HTTP 400 failures retry within the owned signal before classified failure and cleanup', async t => {
  const f = await fixture(t); f.apiError()
  await assert.rejects(f.models.evaluate(f.request()), { code: 'MODEL_REQUEST_FAILED' })
  assert.equal(f.calls.filter(row => row.phase === 'provider').length, 4)
  assert.equal(f.children.size, 0)
  assert.ok(!JSON.stringify(f.diagnostics).includes('PRIVATE_API_ERROR'))
})


test('the exhausted final inference cannot delegate another tool or nested policy', async t => {
  const f = await fixture(t)
  await assert.rejects(f.models.evaluate({ ...f.request(), maxTurns: 1 }), { code: 'AGENT_TURN_LIMIT' })
  assert.equal(f.calls.some(row => row.phase === 'before'), false)
})
