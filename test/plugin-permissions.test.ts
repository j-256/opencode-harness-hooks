import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createHarnessHooks, setupHarnessHooks } from './helpers/isolated-v1.js'
import type { RuntimeServices } from '../src/runtime.js'

async function fixture(t: { after: (callback: () => Promise<void>) => void }) {
  const directory = await mkdtemp(join(tmpdir(), 'harness-permission-plugin-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'hooks.json')
  const source = JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: process.execPath, args: ['-e', 'console.log(JSON.stringify({hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"allow"}}))'] }] }] } })
  await writeFile(path, source)
  return { directory, options: { sources: [{ id: 'claude', dialect: 'claude-code', path }], reviewedDigests: { claude: createHash('sha256').update(source).digest('hex') }, permissionMode: 'default' } }
}
const services = { report: () => {}, dispatchDiagnostic: () => {}, nativeData: async () => ({ 'claude-code': { transcript_path: '/externally-supplied-fixture.jsonl' } }) }

test('V1 projects native allow through the SDK reply and removes it after the tool finishes', async t => {
  const f = await fixture(t)
  const replies: unknown[] = []
  const hooks = await createHarnessHooks({ directory: f.directory, client: {
    session: { get: async () => ({}), messages: async () => ({}) },
    postSessionIdPermissionsPermissionId: async input => { replies.push({ path: input.path, body: input.body }); return { data: true } },
  } }, f.options, services)
  t.after(() => hooks.dispose())
  await hooks['chat.message']({ sessionID: 'session', model: { modelID: 'model' } }, { message: { id: 'turn' } })
  const call = { tool: 'bash', sessionID: 'session', callID: 'call' }
  const args = { command: 'original' }
  await hooks['tool.execute.before'](call, { args })
  const event = { event: { type: 'permission.asked', properties: { id: 'request', sessionID: 'session', tool: { callID: 'call', messageID: 'assistant' } } } }
  await hooks.event(event)
  await hooks.event(event)
  assert.deepEqual(replies, [{ path: { id: 'session', permissionID: 'request' }, body: { response: 'once' } }])
  await hooks['tool.execute.after']({ ...call, args }, { title: 'Fixture', output: '', metadata: { exit: 0 } })
  assert.equal(hooks.inspect().permissions.grants, 0)
  await hooks.event({ event: { ...event.event, properties: { ...event.event.properties, id: 'later' } } })
  assert.equal(replies.length, 1)
})

test('V2 registers a native permission evaluator whose allow expires with the call', async t => {
  const f = await fixture(t)
  const callbacks = new Map<string, (event: any) => Promise<void>>()
  const hook = (domain: string) => async (name: string, callback: (event: any) => Promise<void>) => { const key = domain + '.' + name; callbacks.set(key, callback); return { dispose: () => { callbacks.delete(key) } } }
  const dispose = await setupHarnessHooks({ location: { directory: f.directory }, options: f.options, session: { hook: hook('session') }, tool: { hook: hook('tool') }, permission: { hook: hook('permission') } }, services)
  t.after(dispose)
  await callbacks.get('session.prompt')!({ sessionID: 'session', messageID: 'turn' })
  const call = { tool: 'shell', sessionID: 'session', id: 'call', messageID: 'assistant', agent: 'build', input: { command: 'original' } }
  await callbacks.get('tool.execute.before')!(call)
  const permission = { sessionID: 'session', action: 'shell', resources: ['command'], source: { type: 'tool', id: 'call', messageID: 'assistant' }, effect: 'ask' }
  await callbacks.get('permission.evaluate')!(permission)
  assert.equal(permission.effect, 'allow')
  await callbacks.get('tool.execute.after')!({ ...call, status: 'completed', result: {} })
  permission.effect = 'ask'
  await callbacks.get('permission.evaluate')!(permission)
  assert.equal(permission.effect, 'ask')
  await dispose()
  assert.equal(callbacks.size, 0)
})

test('roots require a native preapproval service and preserve an explicit service override', async t => {
  const f = await fixture(t)
  for (const host of ['v1', 'v2'] as const) {
    for (const custom of [false, true]) {
      let approved = 0
      const selected: RuntimeServices = { ...services, tools: { diagnostic: () => {}, ...(custom ? { preapprove: async () => { approved++ } } : {}) } }
      if (host === 'v1') {
        const hooks = await createHarnessHooks({ directory: f.directory, ...(custom ? { client: { session: { get: async () => ({}), messages: async () => ({}) }, postSessionIdPermissionsPermissionId: async () => { throw new Error('Custom service owns approval') } } } : {}) }, f.options, selected)
        t.after(() => hooks.dispose())
        await hooks['chat.message']({ sessionID: 'session' }, { message: { id: 'turn' } })
        const before = () => hooks['tool.execute.before']({ sessionID: 'session', callID: 'call', tool: 'bash' }, { args: { command: 'original' } })
        if (custom) {
          await before()
          assert.equal(approved, 1)
          assert.equal(hooks.inspect().permissions.grants, 0)
          await hooks.event({ event: { type: 'permission.asked', properties: { id: 'request', sessionID: 'session', tool: { callID: 'call', messageID: 'assistant' } } } })
          assert.equal(hooks.inspect().permissions.failures, 0)
        }
        else await assert.rejects(before(), { code: 'HOST_TOOL_PREAPPROVAL_UNAVAILABLE' })
      } else {
        const callbacks = new Map<string, (event: any) => Promise<void>>()
        const hook = (domain: string) => async (name: string, callback: (event: any) => Promise<void>) => { const key = domain + '.' + name; callbacks.set(key, callback); return { dispose: () => { callbacks.delete(key) } } }
        const dispose = await setupHarnessHooks({ location: { directory: f.directory }, options: f.options, session: { hook: hook('session') }, tool: { hook: hook('tool') }, ...(custom ? { permission: { hook: hook('permission') } } : {}) }, selected)
        t.after(dispose)
        await callbacks.get('session.prompt')!({ sessionID: 'session', messageID: 'turn' })
        const before = () => callbacks.get('tool.execute.before')!({ sessionID: 'session', id: 'call', messageID: 'assistant', tool: 'shell', input: { command: 'original' } })
        if (custom) {
          await before()
          assert.equal(approved, 1)
          const permission = { sessionID: 'session', source: { type: 'tool', id: 'call', messageID: 'assistant' }, effect: 'ask' }
          await callbacks.get('permission.evaluate')!(permission)
          assert.equal(permission.effect, 'ask')
        }
        else await assert.rejects(before(), { code: 'HOST_TOOL_PREAPPROVAL_UNAVAILABLE' })
      }
    }
  }
})
