import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import definition from '../src/index.js'

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
