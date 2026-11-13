import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import definition from '../src/index.js'

for (const host of ['v1', 'v2'] as const) for (const scenario of ['review', 'event', 'missing', 'malformed'] as const) for (const dialect of scenario === 'event' ? ['claude-code', 'codex'] : ['codex']) {
  test(`${host} ${dialect} default activation retains fatal guards after ${scenario} rejection`, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'harness-activation-rejection-'))
    t.after(() => rm(directory, { recursive: true, force: true }))
    const path = join(directory, 'hooks.json')
    const source = JSON.stringify({ hooks: { [scenario === 'event' ? 'Stop' : 'PreToolUse']: [{ hooks: [{ type: 'command', command: 'PRIVATE_HOOK_BODY' }] }] } })
    if (scenario !== 'missing') await writeFile(path, scenario === 'malformed' ? '{PRIVATE_MALFORMED_BODY' : source)
    const options = { sources: [{ id: 'incompatible', dialect, path }], reviewedDigests: { incompatible: scenario === 'review' ? '0'.repeat(64) : createHash('sha256').update(source).digest('hex') } }
    const code = scenario === 'review' ? 'SOURCE_REVIEW_MISMATCH' : scenario === 'event' ? 'HOST_STOP_UNSUPPORTED' : scenario === 'missing' ? 'SOURCE_READ' : 'SOURCE_PARSE'
    if (host === 'v1') {
      const guards = await definition.server({ directory }, options)
      t.after(() => guards.dispose())
      await assert.rejects(guards.config({}), { code })
      await assert.rejects(guards['chat.message']({ sessionID: 'session' }, { message: { id: 'turn' } }), { code })
      await assert.rejects(guards['tool.execute.before']({ sessionID: 'session', callID: 'call', tool: 'bash' }, { args: {} }), { code })
      await assert.rejects(guards['shell.env']({ sessionID: 'session' }, { env: {} }), { code })
    } else {
      const callbacks: (() => Promise<void>)[] = []
      const hook = async (_name: string, callback: (event: any) => Promise<void>) => { const invoke = () => callback({}); callbacks.push(invoke); return { dispose: () => {} } }
      const dispose = await definition.setup({ location: { directory }, options, session: { hook }, tool: { hook } })
      t.after(() => dispose?.())
      assert.ok(callbacks.length)
      for (const callback of callbacks) await assert.rejects(callback(), { code })
    }
  })
}

for (const failureAt of ['context', 'execute.before', 'execute.after']) test(`V2 rejection setup removes partial guards after native registration fails at ${failureAt}`, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'harness-guard-setup-failure-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'hooks.json')
  await writeFile(path, JSON.stringify({ hooks: {} }))
  const handles = new Set<string>()
  const hook = async (name: string) => {
    if (name === failureAt) throw new Error('Fixture guard registration failure')
    handles.add(name)
    return { dispose: () => { handles.delete(name) } }
  }
  const options = { sources: [{ id: 'source', dialect: 'codex', path }], reviewedDigests: { source: '0'.repeat(64) } }
  await assert.rejects(definition.setup({ location: { directory }, options, session: { hook }, tool: { hook } }), /Fixture guard registration failure/)
  assert.equal(handles.size, 0)
})
