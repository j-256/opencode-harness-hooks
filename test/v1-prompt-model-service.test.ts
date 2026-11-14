import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { V1PromptModels } from '../src/hosts/model-v1.js'
import type { V1ModelClient } from '../src/hosts/model-v1.js'
import { Sessions } from '../src/sessions.js'

async function fixture(t: { after: (callback: () => Promise<void>) => void }, options: { readonly promptModel?: string; readonly modelAliases?: Readonly<Record<string, string>> } = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'v1-prompt-model-'))), sessions = new Sessions()
  sessions.prompt('parent', 'turn', 'parent-model')
  let models!: V1PromptModels, sequence = 0, deferred = false, foreign = false, failed = false, malformed = false
  let failedDelete: boolean | 'false' = false
  let finish: (() => void) | undefined, entered: (() => void) | undefined
  let finishDelete: (() => void) | undefined, enteredDelete: (() => void) | undefined
  const children = new Map<string, Record<string, unknown>>(), calls: { phase: string; id?: string; value?: unknown; aborted?: boolean }[] = [], diagnostics: unknown[] = []
  const client: V1ModelClient = { session: {
    get: async () => ({ data: { id: 'parent', directory, title: 'Parent' } }),
    create: async request => {
      const info = { id: 'child-' + ++sequence, parentID: request.body.parentID, title: request.body.title, directory }
      calls.push({ phase: 'create', id: info.id }); children.set(info.id, info)
      assert.equal(models.event('session.created', { info }), true)
      assert.equal(models.owns(info.id), true)
      return { data: info }
    },
    prompt: async request => {
      assert.ok(request.body.messageID)
      const model = { ...request.body.model }, message = { id: request.body.messageID, agent: request.body.agent, model }
      calls.push({ phase: 'prompt', id: request.path.id, value: structuredClone(request.body) })
      assert.equal(models.event('message.updated', { info: { id: 'answer', sessionID: request.path.id, parentID: request.body.messageID, role: 'assistant' } }), true)
      models.message({ sessionID: request.path.id, model }, { message, parts: request.body.parts })
      const system = { system: ['UNRELATED_PROJECT_RULE', 'UNRELATED_AGENT_RULE'] }
      const resolved = { id: model.modelID, providerID: model.providerID }
      models.system({ sessionID: request.path.id, model: resolved }, system)
      assert.ok(!JSON.stringify(system).includes('UNRELATED_'))
      models.parameters({ sessionID: request.path.id, agent: message.agent, message, model: resolved })
      models.headers({ sessionID: request.path.id, agent: message.agent, message, model: resolved })
      if (malformed) {
        const headers: Record<string, string> = {}
        models.requestHeaders({ sessionID: request.path.id }, headers)
        const response = await models.fetch('fixture', async (_input, init) => {
          assert.equal(new Headers(init?.headers).get('x-opencode-harness-model-request'), null)
          return new Response('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: 'StructuredOutput', arguments: ' \\n {"ok":"wrong"} \\n' } }] } }] }) + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
        }, 'https://fixture.invalid/chat/completions', { headers })
        await response.text()
        return { data: { info: { id: 'answer', sessionID: request.path.id, parentID: message.id, role: 'assistant', modelID: model.modelID, providerID: model.providerID, structured: { ok: 'wrong' } }, parts: [] } }
      }
      if (deferred) { entered?.(); await new Promise<void>(resolve => { finish = resolve }) }
      if (failed) throw new Error('PRIVATE_PROVIDER_FAILURE')
      return { data: { info: { id: 'answer', sessionID: foreign ? 'foreign' : request.path.id, parentID: message.id, role: 'assistant', modelID: model.modelID, providerID: model.providerID, structured: { ok: false, reason: 'Owned rejection' } }, parts: [] } }
    },
    abort: async request => { calls.push({ phase: 'abort', id: request.path.id, aborted: request.signal.aborted }); return { data: true } },
    delete: async request => { calls.push({ phase: 'delete', id: request.path.id, aborted: request.signal.aborted }); if (enteredDelete) { enteredDelete(); await new Promise<void>(resolve => { finishDelete = resolve }) }; if (failedDelete === 'false') return { data: false }; if (failedDelete) return { error: { private: 'PRIVATE_DELETE_FAILURE' } }; children.delete(request.path.id); return { data: true } },
    children: async () => ({ data: [...children.values()] }),
  } }
  models = await V1PromptModels.create({ directory, client, diagnostic: value => { diagnostics.push(value) } })
  models.attach(sessions, options)
  const config: { model?: string; small_model?: string; agent?: Record<string, unknown> } = { model: 'fixture/default', small_model: 'fixture/small' }
  models.configure(config)
  models.observe('parent', 'turn', { providerID: 'fixture', modelID: 'parent-model' })
  const request = (signal = sessions.get('parent').turnSignal, model?: string) => ({ prompt: 'OWNED_RULE', sessionID: 'parent', cwd: directory, signal, ...(model ? { model } : {}) })
  t.after(async () => { finish?.(); finishDelete?.(); await models.dispose(); sessions.dispose(); await rm(directory, { recursive: true, force: true }) })
  return { models, sessions, directory, calls, diagnostics, config, children, request, defer: () => { deferred = true; return new Promise<void>(resolve => { entered = resolve }) }, finish: () => finish?.(), foreign: () => { foreign = true }, fail: () => { failed = true }, malformed: () => { malformed = true }, deleteFailure: (value: boolean | 'false') => { failedDelete = value }, holdDelete: () => new Promise<void>(resolve => { enteredDelete = resolve }), finishDelete: () => finishDelete?.() }
}

test('V1 evaluator claims creation before SDK return and admits only its owned structured verdict', async t => {
  const f = await fixture(t)
  assert.equal(f.models.event('session.created', { info: { id: 'ordinary', parentID: 'parent', title: 'Hook evaluation forged', directory: f.directory } }), false)
  assert.equal(f.models.owns('ordinary'), false)
  assert.deepEqual({ ...await f.models.evaluate(f.request()) }, { ok: false, reason: 'Owned rejection' })
  const prompt = f.calls.find(row => row.phase === 'prompt')!.value as { agent: string; tools: unknown; model: unknown }
  assert.deepEqual(prompt.tools, { '*': false, StructuredOutput: true })
  assert.deepEqual(prompt.model, { providerID: 'fixture', modelID: 'small' })
  assert.ok(f.config.agent?.[prompt.agent])
  assert.equal(f.children.size, 0)
  assert.equal(f.models.inspect().active, 0)
})

test('native explicit models and declared aliases take precedence over prompt/default model selection', async t => {
  const f = await fixture(t, { promptModel: 'override/prompt', modelAliases: { haiku: 'mapped/native' } })
  await f.models.evaluate(f.request(undefined, 'haiku'))
  await f.models.evaluate(f.request(undefined, 'other/exact'))
  assert.deepEqual(f.calls.filter(row => row.phase === 'prompt').map(row => (row.value as { model: unknown }).model), [{ providerID: 'mapped', modelID: 'native' }, { providerID: 'other', modelID: 'exact' }])
})

test('foreign model results cannot become approvals and still delete their owned child', async t => {
  const f = await fixture(t); f.foreign()
  await assert.rejects(f.models.evaluate(f.request()), { code: 'HOST_MODEL_RESULT_OWNER_MISMATCH' })
  assert.equal(f.children.size, 0)
})

test('model cancellation aborts actual child work, uses a fresh cleanup scope and discards late results', { timeout: 5000 }, async t => {
  const f = await fixture(t), controller = new AbortController(), entered = f.defer()
  const pending = f.models.evaluate(f.request(controller.signal))
  await entered; controller.abort()
  await assert.rejects(pending, { code: 'EXECUTION_CANCELLED' })
  assert.ok(f.calls.some(row => row.phase === 'abort' && row.aborted === false))
  assert.ok(f.calls.some(row => row.phase === 'delete' && row.aborted === false))
  assert.equal(f.children.size, 0)
  f.finish()
})

test('provider exceptions remain private and cannot leave a reusable evaluator session', async t => {
  const f = await fixture(t); f.fail()
  await assert.rejects(f.models.evaluate(f.request()))
  assert.ok(!JSON.stringify(f.diagnostics).includes('PRIVATE_PROVIDER_FAILURE'))
  assert.equal(f.children.size, 0)
})

test('malformed structured verdicts retain original provider arguments rather than cooked JSON', async t => {
  const f = await fixture(t); f.malformed()
  await assert.rejects(f.models.evaluate(f.request()), error => typeof error === 'object' && error !== null && 'stdout' in error && error.stdout === ' \\n {"ok":"wrong"} \\n')
  assert.equal(f.children.size, 0)
})

test('child deletion failures remain inspectable and disposal retries cleanup without leaking errors', async t => {
  const f = await fixture(t); f.deleteFailure(true)
  await f.models.evaluate(f.request())
  assert.equal(f.models.inspect().cleanupFailed, 1)
  assert.equal(f.children.size, 1)
  assert.ok(!JSON.stringify(f.diagnostics).includes('PRIVATE_DELETE_FAILURE'))
  f.deleteFailure(false)
  await f.models.dispose()
  assert.equal(f.children.size, 0)
  assert.equal(f.models.inspect().cleanupFailed, 0)
})

test('a negative deletion receipt cannot silently declare an evaluator removed', async t => {
  const f = await fixture(t); f.deleteFailure('false')
  await f.models.evaluate(f.request())
  assert.equal(f.models.inspect().cleanupFailed, 1)
  f.deleteFailure(false)
  await f.models.dispose()
  assert.equal(f.children.size, 0)
})

test('turn cancellation during child cleanup rejects the computed verdict and its success diagnostic', { timeout: 5000 }, async t => {
  const f = await fixture(t), entered = f.holdDelete(), result = f.models.evaluate(f.request())
  await entered
  f.sessions.prompt('parent', 'next-turn', 'parent-model')
  f.finishDelete()
  await assert.rejects(result, { code: 'EXECUTION_CANCELLED' })
  assert.equal(f.children.size, 0)
  assert.ok(!JSON.stringify(f.diagnostics).includes('MODEL_EVALUATED'))
})
