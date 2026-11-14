import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createHarnessHooks } from './helpers/isolated-v1.js'
import { AGENT_VERDICT_TOOL } from '../src/hosts/agent-v1.js'
import type { V1Input } from '../src/hosts/plugin-v1.js'
import type { V1ModelClient } from '../src/hosts/model-v1.js'

async function fixture(t: { after: (fn: () => Promise<void>) => void }, custom = false, deny = false, invalid = false) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'plugin-agent-model-'))), path = join(directory, 'hooks.json')
  await writeFile(join(directory, 'record.cjs'), 'const fs=require("node:fs");const p=JSON.parse(fs.readFileSync(0,"utf8"));fs.appendFileSync("calls.jsonl",JSON.stringify(p)+"\\n")')
  const source = JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'agent', prompt: 'OWNED_AGENT $ARGUMENTS', timeout: 5 }] }], PreToolUse: [{ hooks: [{ type: 'command', command: 'node record.cjs' }, { type: 'prompt', prompt: 'MUST_NOT_RECURSE' }] }], PostToolUse: [{ hooks: [{ type: 'command', command: 'node record.cjs' }] }] } })
  await writeFile(path, source)
  let hooks!: Awaited<ReturnType<typeof createHarnessHooks>>, promptModels = 0, agentModels = 0
  const children: string[] = [], deleted: string[] = [], nativeSessions: string[] = [], prompts: unknown[] = [], requests: Request[] = []
  const config = { model: 'fixture/parent', small_model: 'fixture/small', permission: {} as Record<string, unknown>, agent: {} as Record<string, unknown>, provider: { fixture: { options: { fetch: async (input: RequestInfo | URL, init?: RequestInit) => { const request = new Request(input, init); requests.push(request); return new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }) } } } } }
  const sdk: V1ModelClient['session'] = {
    get: async request => ({ data: { id: request.path.id, directory } }),
    create: async request => { const info = { permission: request.body.permission, id: 'owned-agent', parentID: request.body.parentID, title: request.body.title, directory }; children.push(info.id); await hooks.event({ event: { type: 'session.created', properties: { info } } }); return { data: info } },
    prompt: async request => {
      assert.ok(request.body.messageID)
      prompts.push(structuredClone(request.body))
      const sessionID = request.path.id, model = request.body.model, message = { id: request.body.messageID, agent: request.body.agent, model }, prompt = { sessionID, agent: request.body.agent, model, message }
      await hooks['chat.message'](prompt, { message, parts: request.body.parts })
      const system = { system: ['PRIVATE_PROJECT_POLICY'] }; await hooks['experimental.chat.system.transform']({ sessionID, model: { providerID: model.providerID, modelID: model.modelID } }, system); assert.ok(!system.system.includes('PRIVATE_PROJECT_POLICY'))
      await hooks['chat.params']({ ...prompt, provider: { id: 'fixture', options: config.provider.fixture.options } })
      const send = async () => { const headers: Record<string, string> = {}; await hooks['chat.headers'](prompt, { headers }); await config.provider.fixture.options.fetch('https://fixture.invalid/chat/completions', { method: 'POST', headers, body: '{}' }).then(response => response.text()) }
      await hooks.event({ event: { type: 'message.updated', properties: { info: { id: 'answer', sessionID, parentID: message.id, role: 'assistant' } } } })
      await send()
      const read = { sessionID, tool: 'read', callID: 'read-call' }, readArgs = { filePath: join(directory, 'owned.txt') }
      await hooks['tool.execute.before'](read, { args: readArgs }); await hooks['tool.execute.after']({ ...read, args: readArgs }, { title: 'Read', output: 'OWNED_RESULT', metadata: {} })
      await send()
      const call = { sessionID, tool: AGENT_VERDICT_TOOL, callID: 'verdict-call' }, args = invalid ? { ok: 'wrong' } : deny ? { ok: false, reason: 'Owned denial' } : { ok: true }
      await hooks['tool.execute.before'](call, { args })
      await hooks.tool![AGENT_VERDICT_TOOL]!.execute(args, { sessionID, callID: call.callID, messageID: 'answer', agent: request.body.agent, abort: request.signal })
      await hooks['tool.execute.after']({ ...call, args }, { title: 'Verdict', output: 'Captured', metadata: {} })
      await assert.rejects(send(), { code: 'HOST_AGENT_VERDICT_CAPTURED' })
      return { data: { info: { id: 'answer', sessionID, parentID: message.id, role: 'assistant', modelID: model.modelID, providerID: model.providerID, error: { name: 'UnknownError', data: { message: 'HOST_AGENT_VERDICT_CAPTURED' } } }, parts: [] } }
    },
    abort: async () => ({ data: true }), delete: async request => { deleted.push(request.path.id); await hooks.event({ event: { type: 'session.deleted', properties: { info: { id: request.path.id } } } }); return { data: true } },
  }
  const client: V1Input['client'] = { app: { agents: async () => ({ data: [{ name: 'build', permission: [{ permission: '*', pattern: '*', action: 'allow' }] }] }) }, session: { ...sdk, get: sdk.get!, messages: async () => ({ data: [] }) } }
  hooks = await createHarnessHooks({ directory, client }, { sources: [{ id: 'claude', dialect: 'claude-code', path }], reviewedDigests: { claude: createHash('sha256').update(source).digest('hex') }, permissionMode: 'bypassPermissions', agentModel: 'fixture/cheap' }, {
    report: () => {}, dispatchDiagnostic: () => {}, promptDiagnostic: () => {}, nativeState: { ensure: async session => { nativeSessions.push(session.sessionID) }, checkpoint: async session => { nativeSessions.push(session.sessionID) } },
    transcripts: { observe: () => {}, prepare: async () => join(directory, 'reserved.jsonl'), admitPrompt: () => {}, dispose: async () => {} },
    host: { environment: process.env, evaluatePrompt: async () => { promptModels++; return { ok: true } }, ...(custom ? { runAgent: async () => { agentModels++; return { ok: true } } } : {}) },
  })
  await hooks.config(config)
  t.after(async () => { await hooks.dispose(); await rm(directory, { recursive: true, force: true }) })
  return { hooks, config, prompts, children, deleted, nativeSessions, requests, models: () => ({ prompt: promptModels, agent: agentModels }), submit: () => hooks['chat.message']({ sessionID: 'parent', model: { providerID: 'fixture', modelID: 'parent' } }, { message: { id: 'turn', agent: 'build', model: { providerID: 'fixture', modelID: 'parent' } }, parts: [{ type: 'text', text: 'Original input' }] }), calls: async () => (await readFile(join(directory, 'calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)) }
}

test('default agent binding runs nested policies with native parent identity while keeping child host state private', async t => {
  const f = await fixture(t); await f.submit()
  assert.equal(f.prompts.length, 1); assert.equal(f.requests.length, 2); assert.deepEqual(f.models(), { prompt: 0, agent: 0 })
  const body = f.prompts[0] as { model: unknown; tools?: unknown; format?: unknown }
  assert.deepEqual(body.model, { providerID: 'fixture', modelID: 'cheap' }); assert.equal(body.tools, undefined); assert.equal(body.format, undefined)
  const calls = await f.calls(); assert.equal(calls.length, 4)
  assert.deepEqual(calls.map(row => row.tool_name), ['Read', 'Read', 'StructuredOutput', 'StructuredOutput'])
  for (const row of calls) { assert.equal(row.session_id, 'parent'); assert.equal(row.permission_mode, 'dontAsk') }
  assert.ok(f.nativeSessions.every(session => session === 'parent')); assert.deepEqual(f.deleted, f.children)
  assert.equal(f.config.permission[AGENT_VERDICT_TOOL], 'deny')
  for (const request of f.requests) assert.equal([...request.headers.keys()].some(key => key.startsWith('x-opencode-harness-')), false)
})

test('default agent denial blocks prompt admission after its child is removed', async t => {
  const f = await fixture(t, false, true)
  await assert.rejects(f.submit(), { code: 'HOOK_PROMPT_BLOCKED' }); assert.deepEqual(f.deleted, f.children)
})

test('custom agent services retain ownership without installing a default evaluator or verdict tool', async t => {
  const f = await fixture(t, true); await f.submit()
  assert.deepEqual(f.models(), { prompt: 0, agent: 1 }); assert.deepEqual(f.children, [])
  assert.equal(f.config.agent['opencode-harness-hooks-agent'], undefined); assert.equal(f.hooks.tool?.[AGENT_VERDICT_TOOL], undefined)
})

test('agent activation supports host permission shorthand without widening a global deny', async t => {
  const f = await fixture(t)
  const editable = f.config as unknown as { permission: unknown }
  editable.permission = 'deny'
  await f.hooks.config(f.config)
  assert.equal(f.config.permission['*'], 'deny'); assert.equal(f.config.permission[AGENT_VERDICT_TOOL], 'deny')
  const agent = f.config.agent['opencode-harness-hooks-agent'] as { permission: Record<string, unknown> }
  const action = Object.entries(agent.permission).filter(([name]) => name === '*' || name === 'read').at(-1)?.[1]
  assert.equal(action, 'deny')
})


test('failed evaluator tools release nested permission and bridge state when their child closes', async t => {
  const f = await fixture(t, false, false, true)
  await f.submit()
  assert.equal(f.hooks.inspect().agentPermissions?.calls, 0)
  assert.equal(f.hooks.inspect().agentTools?.calls, 0)
  assert.deepEqual(f.deleted, f.children)
})
