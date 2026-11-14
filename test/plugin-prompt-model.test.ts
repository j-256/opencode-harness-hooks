import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createHarnessHooks } from './helpers/isolated-v1.js'
import type { V1Input } from '../src/hosts/plugin-v1.js'
import type { V1ModelClient } from '../src/hosts/model-v1.js'

async function fixture(t: { after: (callback: () => Promise<void>) => void }, deny = false, custom = false) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'plugin-prompt-model-'))), path = join(directory, 'hooks.json')
  const source = JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'prompt', prompt: 'OWNED_CONDITION $ARGUMENTS', timeout: 5, model: 'native-model' }] }] } })
  await writeFile(path, source)
  let hooks!: Awaited<ReturnType<typeof createHarnessHooks>>, sequence = 0
  const nativeSessions: string[] = [], childIDs: string[] = [], deleted: string[] = [], prompts: unknown[] = [], requests: Request[] = []
  const config = { model: 'fixture/parent', small_model: 'fixture/small', provider: { fixture: { options: { fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init); requests.push(request)
    const body = { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: 'StructuredOutput', arguments: JSON.stringify(deny ? { ok: false, reason: 'OWNED_DENIAL' } : { ok: true }) } }] } }] }
    return new Response('data: ' + JSON.stringify(body) + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
  } } } }, agent: {} as Record<string, unknown> }
  const modelClient: V1ModelClient['session'] = {
    get: async request => ({ data: { id: request.path.id, directory, title: 'Parent' } }),
    create: async request => {
      const info = { id: 'child-' + ++sequence, directory, parentID: request.body.parentID, title: request.body.title }
      childIDs.push(info.id)
      await hooks.event({ event: { type: 'session.created', properties: { info } } })
      return { data: info }
    },
    prompt: async request => {
      assert.ok(request.body.messageID)
      prompts.push(structuredClone(request.body))
      const prompt = { sessionID: request.path.id, agent: request.body.agent, model: { ...request.body.model, api: { npm: '@ai-sdk/openai-compatible' } }, message: { id: request.body.messageID, agent: request.body.agent, model: request.body.model } }
      await hooks['chat.message'](prompt, { message: prompt.message, parts: request.body.parts })
      await hooks['experimental.chat.messages.transform']({}, { messages: [{ info: { ...prompt.message, sessionID: request.path.id, role: 'user' }, parts: request.body.parts }] })
      const system = { system: ['PRIVATE_PROJECT_POLICY'] }, original = system.system
      await hooks['experimental.chat.system.transform'](prompt, system)
      assert.equal(system.system, original)
      assert.ok(!system.system.includes('PRIVATE_PROJECT_POLICY'))
      await hooks['chat.params']({ ...prompt, provider: { id: 'fixture', options: config.provider.fixture.options } })
      const headers: Record<string, string> = {}
      await hooks['chat.headers'](prompt, { headers })
      await config.provider.fixture.options.fetch('https://fixture.invalid/chat/completions', { method: 'POST', headers, body: JSON.stringify({ messages: [{ role: 'system', content: system.system.join('\n') }, { role: 'user', content: request.body.parts[0]!.text }] }) }).then(response => response.text())
      await hooks['tool.execute.before']({ sessionID: request.path.id, tool: 'StructuredOutput', callID: 'collector' }, { args: { ok: !deny } })
      await assert.rejects(hooks['tool.execute.before']({ sessionID: request.path.id, tool: 'bash', callID: 'effectful' }, { args: { command: 'touch prohibited' } }), { code: 'HOST_MODEL_TOOL_UNAVAILABLE' })
      return { data: { info: { id: 'answer', sessionID: request.path.id, parentID: request.body.messageID, providerID: request.body.model.providerID, modelID: request.body.model.modelID, role: 'assistant', structured: deny ? { ok: false, reason: 'OWNED_DENIAL' } : { ok: true } }, parts: [] } }
    },
    abort: async () => ({ data: true }), delete: async request => { deleted.push(request.path.id); await hooks.event({ event: { type: 'session.deleted', properties: { info: { id: request.path.id } } } }); return { data: true } },
  }
  const client: V1Input['client'] = { session: { ...modelClient, get: modelClient.get!, messages: async () => ({ data: [] }) } }
  const options = { sources: [{ id: 'claude', dialect: 'claude-code', path }], reviewedDigests: { claude: createHash('sha256').update(source).digest('hex') }, permissionMode: 'default', modelAliases: { 'native-model': 'fixture/explicit' } }
  hooks = await createHarnessHooks({ directory, client }, options, { report: () => {}, dispatchDiagnostic: () => {}, promptDiagnostic: () => {}, nativeState: { ensure: async session => { nativeSessions.push(session.sessionID) }, checkpoint: async session => { nativeSessions.push(session.sessionID) } }, transcripts: { observe: () => {}, prepare: async () => '/unused', admitPrompt: () => {}, dispose: async () => {} }, ...(custom ? { host: { environment: process.env, evaluatePrompt: async () => ({ ok: true }) } } : {}) })
  await hooks.config(config)
  t.after(async () => { await hooks.dispose(); await rm(directory, { recursive: true, force: true }) })
  const submit = () => hooks['chat.message']({ sessionID: 'parent', model: { providerID: 'fixture', modelID: 'parent' } }, { message: { id: 'turn', agent: 'build', model: { providerID: 'fixture', modelID: 'parent' } }, parts: [{ type: 'text', text: 'Original input' }] })
  return { hooks, submit, prompts, requests, nativeSessions, childIDs, deleted, config }
}

test('default V1 model service isolates evaluator callbacks from native state and hook recursion', async t => {
  const f = await fixture(t)
  await f.submit()
  assert.equal(f.prompts.length, 1)
  assert.equal(f.requests.length, 1)
  assert.ok(f.nativeSessions.every(value => value === 'parent'))
  assert.deepEqual(f.deleted, f.childIDs)
  assert.equal([...f.requests[0]!.headers.keys()].some(key => key.startsWith('x-opencode-harness-')), false)
  const prompt = f.prompts[0] as { model: unknown; parts: { text: string }[] }
  assert.deepEqual(prompt.model, { providerID: 'fixture', modelID: 'explicit' })
  assert.match(prompt.parts[0]!.text, /OWNED_CONDITION/)
  assert.match(prompt.parts[0]!.text, /Original input/)
})

test('default V1 model denial blocks admission after deleting its evaluator', async t => {
  const f = await fixture(t, true)
  await assert.rejects(f.submit(), { code: 'HOOK_PROMPT_BLOCKED' })
  assert.deepEqual(f.deleted, f.childIDs)
})

test('a supplied prompt evaluator retains its ownership and avoids internal host agents', async t => {
  const f = await fixture(t, false, true)
  await f.submit()
  assert.deepEqual(f.childIDs, [])
  assert.deepEqual(f.config.agent, {})
})
