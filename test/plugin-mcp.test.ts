import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createHarnessHooks } from './helpers/isolated-v1.js'
import { MCP_PROVIDER_ID, MCP_MODEL_ID, MCP_AGENT_ID } from '../src/hosts/mcp-transport-v1.js'
import type { V1Input } from '../src/hosts/plugin-v1.js'
import type { V1McpClient } from '../src/hosts/mcp-v1.js'

async function fixture(t: { after: (fn: () => Promise<void>) => void }, custom = false, deny = false, enabled = true) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'plugin-mcp-'))), path = join(directory, 'hooks.json')
  await writeFile(join(directory, 'record.cjs'), 'const fs=require("node:fs");const p=JSON.parse(fs.readFileSync(0,"utf8"));fs.appendFileSync("calls.jsonl",JSON.stringify(p)+"\\n")')
  const source = JSON.stringify({ disableAllHooks: !enabled, hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'mcp_tool', server: 'fixture', tool: 'check', input: { value: 'Owned input' }, timeout: 5 }] }, { hooks: [{ type: 'command', command: 'node record.cjs' }] }], PostToolUse: [{ hooks: [{ type: 'command', command: 'node record.cjs' }] }] } })
  await writeFile(path, source)
  let hooks!: Awaited<ReturnType<typeof createHarnessHooks>>, network = 0, customCalls = 0
  const children: string[] = [], deleted: string[] = [], nativeSessions: string[] = []
  type Provider = { options: { fetch: typeof fetch } }
  const config = { model: 'fixture/parent', agent: {} as Record<string, unknown>, provider: { fixture: { options: { fetch: async () => { network++; return new Response('{}') } } } } as Record<string, Provider> }
  const text = JSON.stringify(deny ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Owned denial' } } : {})
  const session: V1McpClient['session'] = {
    get: async request => ({ data: { id: request.path.id, directory } }),
    create: async request => { const info = { id: 'owned-mcp', directory, parentID: request.body.parentID, title: request.body.title, permission: request.body.permission }; children.push(info.id); await hooks.event({ event: { type: 'session.created', properties: { info } } }); return { data: info } },
    prompt: async request => {
      assert.ok(request.body.messageID)
      const sessionID = request.path.id, model = request.body.model, message = { id: request.body.messageID, agent: request.body.agent, model }, prompt = { sessionID, model, agent: request.body.agent, message }
      await hooks['chat.message'](prompt, { message, parts: request.body.parts })
      await hooks['experimental.chat.messages.transform']({}, { messages: [{ info: { ...message, sessionID, role: 'user' }, parts: request.body.parts }] })
      const system = { system: ['PRIVATE_PARENT_CONTEXT'] }; await hooks['experimental.chat.system.transform'](prompt, system); assert.ok(!system.system.includes('PRIVATE_PARENT_CONTEXT'))
      const provider = config.provider[MCP_PROVIDER_ID]!
      await hooks['chat.params']({ ...prompt, provider: { id: MCP_PROVIDER_ID, options: provider.options } })
      const headers: Record<string, string> = {}; await hooks['chat.headers'](prompt, { headers })
      await hooks.event({ event: { type: 'message.updated', properties: { info: { id: 'answer', sessionID, parentID: message.id, role: 'assistant' } } } })
      const response = await provider.options.fetch('https://private.invalid/chat/completions', { method: 'POST', headers, body: JSON.stringify({ model: MCP_MODEL_ID, tools: [{ type: 'function', function: { name: 'fixture_check' } }] }) })
      const frame = (await response.text()).split('\n').find(line => line.startsWith('data: {'))!, call = JSON.parse(frame.slice(6)).choices[0].delta.tool_calls[0]
      const input = { sessionID, tool: call.function.name, callID: call.id }, args = JSON.parse(call.function.arguments)
      assert.deepEqual(args, { value: 'Owned input' })
      await hooks['tool.execute.before'](input, { args }); await hooks['tool.execute.after']({ ...input, args }, { content: [{ type: 'text', text }] })
      await assert.rejects(hooks['chat.headers'](prompt, { headers: {} }), { code: 'HOST_MCP_RESULT_CAPTURED' })
      return { data: { info: { id: 'answer', sessionID, parentID: message.id, role: 'assistant', modelID: model.modelID, providerID: model.providerID, error: { name: 'UnknownError', data: { message: 'HOST_MCP_RESULT_CAPTURED' } } }, parts: [] } }
    },
    abort: async () => ({ data: true }), delete: async request => { deleted.push(request.path.id); await hooks.event({ event: { type: 'session.deleted', properties: { info: { id: request.path.id } } } }); return { data: true } },
  }
  const client: V1Input['client'] = { mcp: { status: async () => ({ data: { fixture: { status: 'connected' } } }) }, session: { ...session, get: session.get!, messages: async () => ({ data: [] }) } }
  hooks = await createHarnessHooks({ directory, client }, { permissionMode: 'bypassPermissions', sources: [{ id: 'native', dialect: 'claude-code', path }], reviewedDigests: { native: createHash('sha256').update(source).digest('hex') } }, { report: () => {}, dispatchDiagnostic: () => {}, nativeState: { ensure: async value => { nativeSessions.push(value.sessionID) }, checkpoint: async value => { nativeSessions.push(value.sessionID) } }, transcripts: { prepare: async () => '/unused', observe: () => {}, dispose: async () => {} }, ...(custom ? { host: { environment: process.env, mcp: { timeoutAccounting: 'wall' as const, execute: async () => { customCalls++; return { text } } } } } : {}) })
  await hooks.config(config)
  t.after(async () => { await hooks.dispose(); await rm(directory, { recursive: true, force: true }) })
  await hooks['chat.message']({ sessionID: 'parent', model: { providerID: 'fixture', modelID: 'parent' } }, { message: { id: 'turn', agent: 'build' }, parts: [{ type: 'text', text: 'Original input' }] })
  return { hooks, config, children, deleted, nativeSessions, network: () => network, customCalls: () => customCalls, run: () => hooks['tool.execute.before']({ sessionID: 'parent', tool: 'bash', callID: 'parent-call' }, { args: { command: 'true' } }), calls: async () => (await readFile(join(directory, 'calls.jsonl'), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error })).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) }
}

test('default MCP binding suppresses internal native callbacks and isolates state without provider network calls', async t => {
  const f = await fixture(t); await f.run()
  assert.deepEqual(f.deleted, ['owned-mcp']); assert.deepEqual(f.children, f.deleted); assert.equal(f.network(), 0)
  assert.ok(f.nativeSessions.every(value => value === 'parent'))
  const calls = await f.calls(); assert.equal(calls.length, 1); assert.equal(calls[0].tool_name, 'Bash')
  assert.ok(f.config.agent[MCP_AGENT_ID]); assert.equal(f.customCalls(), 0)
  await assert.rejects(f.config.provider[MCP_PROVIDER_ID]!.options.fetch('https://private.invalid'), { code: 'HOST_MCP_REQUEST_OWNER_MISMATCH' })
})

test('default MCP denial rejects the parent call after removing its child', async t => {
  const f = await fixture(t, false, true)
  await assert.rejects(f.run(), { outcome: 'denied' }); assert.deepEqual(f.deleted, ['owned-mcp'])
})

test('custom MCP services and disabled registrations do not install a private evaluator', async t => {
  for (const [custom, enabled] of [[true, true], [false, false]]) {
    const f = await fixture(t, custom, false, enabled); await f.run()
    assert.equal(f.config.agent[MCP_AGENT_ID], undefined); assert.equal(f.config.provider[MCP_PROVIDER_ID], undefined)
    assert.deepEqual(f.children, []); assert.equal(f.customCalls(), custom ? 1 : 0)
  }
})
