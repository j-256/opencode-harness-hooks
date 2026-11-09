import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import definition from '../src/index.js'
import { setupHarnessHooks } from '../src/plugin.js'

test('the root exports one definition accepted by both host APIs', async () => {
  const root = await import('../src/index.js')
  assert.deepEqual(Object.keys(root), ['default'])
  assert.equal(definition.id, 'opencode-harness-hooks')
  assert.equal(typeof definition.server, 'function')
  assert.equal(typeof definition.setup, 'function')
})

test('both entrypoints use native options, host metadata and their tool schema', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'harness-plugin-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'hooks.json')
  const command = 'printf \'{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","updatedInput":{"command":"rewritten"}}}\''
  const source = JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command }] }] } })
  await writeFile(path, source)
  const options = { sources: [{ id: 'codex', dialect: 'codex', path }], reviewedDigests: { codex: createHash('sha256').update(source).digest('hex') }, permissionMode: 'default' }
  const hooks = await definition.server({ directory }, options)
  t.after(() => hooks.dispose())
  await hooks['chat.message']({ sessionID: 'one', model: { modelID: 'model' } }, { message: { id: 'turn' } })
  const args = { command: 'original', description: 'removed' }
  await hooks['tool.execute.before']({ sessionID: 'one', callID: 'call', tool: 'bash' }, { args })
  assert.deepEqual(args, { command: 'rewritten' })

  const sessionCallbacks = new Map<string, (event: any) => Promise<void>>()
  const toolCallbacks = new Map<string, (event: any) => Promise<void>>()
  const hook = (callbacks: typeof sessionCallbacks) => async (name: string, callback: (event: any) => Promise<void>) => { callbacks.set(name, callback); return { dispose: () => { callbacks.delete(name) } } }
  const dispose = await definition.setup({ location: { directory }, options, session: { hook: hook(sessionCallbacks) }, tool: { hook: hook(toolCallbacks) } })
  await sessionCallbacks.get('prompt')!({ sessionID: 'two', messageID: 'turn-two', prompt: { text: 'Prompt' } })
  await sessionCallbacks.get('context')!({ sessionID: 'two', model: { id: 'model-two' } })
  const event = { sessionID: 'two', id: 'call', messageID: 'assistant-message', agent: 'build', tool: 'shell', input: { command: 'original', description: 'removed' } }
  await toolCallbacks.get('execute.before')!(event)
  assert.deepEqual(event.input, { command: 'rewritten' })
  await Promise.all([dispose(), dispose()])
  assert.equal(toolCallbacks.size, 0)
  assert.equal(sessionCallbacks.size, 0)
})

test('V2 setup failure removes metadata registrations before returning its error', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'harness-plugin-failure-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'hooks.json')
  const source = JSON.stringify({ hooks: {} })
  await writeFile(path, source)
  const handles = new Set<string>()
  const options = { sources: [{ id: 'source', dialect: 'codex', path }], reviewedDigests: { source: createHash('sha256').update(source).digest('hex') } }
  await assert.rejects(definition.setup({ location: { directory }, options, session: { hook: async name => { handles.add(name); return { dispose: () => { handles.delete(name) } } } }, tool: { hook: async () => { throw new Error('Fixture registration failure') } } }), /Fixture registration failure/)
  assert.equal(handles.size, 0)
})

test('the default V1 entrypoint supplies a Claude transcript read by the unchanged native command contract', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'harness-claude-plugin-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'hooks.json')
  const command = 'const fs=require("node:fs");const p=JSON.parse(fs.readFileSync(0,"utf8"));const rows=fs.readFileSync(p.transcript_path,"utf8").trim().split(String.fromCharCode(10)).map(JSON.parse);if(rows[0].message.content!=="Prompt"||rows.at(-1).message.content[0].input.command!=="original")process.exit(7);console.log(JSON.stringify({hookSpecificOutput:{hookEventName:"PreToolUse",updatedInput:{command:"from-transcript"}}}));'
  const source = JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: process.execPath, args: ['-e', command] }] }] } })
  await writeFile(path, source)
  const options = { sources: [{ id: 'claude', dialect: 'claude-code', path }], reviewedDigests: { claude: createHash('sha256').update(source).digest('hex') }, permissionMode: 'default' }
  const hooks = await definition.server({ directory, client: { session: {
    get: async () => ({ data: { id: 'session' } }),
    messages: async () => ({ data: [
      { info: { id: 'turn', sessionID: 'session', role: 'user', time: { created: 1 } }, parts: [{ type: 'text', text: 'Prompt' }] },
      { info: { id: 'answer', sessionID: 'session', parentID: 'turn', role: 'assistant', modelID: 'fixture', time: { created: 2 } }, parts: [{ type: 'tool', callID: 'call', tool: 'bash', state: { status: 'running', input: { command: 'original' } } }] },
    ] }),
  } } }, options)
  t.after(() => hooks.dispose())
  await hooks['chat.message']({ sessionID: 'session', model: { modelID: 'fixture' } }, { message: { id: 'turn' } })
  const args = { command: 'original' }
  await hooks['tool.execute.before']({ sessionID: 'session', callID: 'call', tool: 'bash' }, { args })
  assert.deepEqual(args, { command: 'from-transcript' })
})

test('V2 unregisters every callback even when artifact cleanup fails and permits a cleanup retry', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'harness-cleanup-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'hooks.json')
  const source = '{"hooks":{}}'
  await writeFile(path, source)
  const handles = new Set<string>()
  const hook = async (name: string) => { handles.add(name); return { dispose: () => { handles.delete(name) } } }
  let cleanup = 0
  const dispose = await setupHarnessHooks({ location: { directory }, options: { sources: [{ id: 'source', dialect: 'codex', path }], reviewedDigests: { source: createHash('sha256').update(source).digest('hex') } }, session: { hook }, tool: { hook } }, {
    report: () => {}, transcripts: { observe: () => {}, prepare: async () => { throw new Error('Unused') }, dispose: async () => { if (++cleanup === 1) throw new Error('Fixture artifact cleanup failure') } },
  })
  await assert.rejects(dispose(), /Fixture artifact cleanup failure/)
  assert.equal(handles.size, 0)
  await dispose()
  assert.equal(cleanup, 2)
})
