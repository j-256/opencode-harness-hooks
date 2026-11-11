import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import definition from '../src/index.js'
import type { Dialect } from '../src/contracts.js'
import type { SourceSpec } from '../src/types.js'

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'harness-v2-stop-rejection-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const sources: SourceSpec[] = [], reviewedDigests: Record<string, string> = {}, registrations: string[] = []
  const callbacks = new Map<string, (event: any) => Promise<void>>()
  const marker = join(directory, 'hook-executed')
  const hook = async (name: string, callback: (event: any) => Promise<void>) => { registrations.push(name); callbacks.set(name, callback); return { dispose: () => { callbacks.delete(name) } } }
  const context = {
    app: { version: '2.2.5' }, location: { directory }, options: { sources, reviewedDigests },
    event: { subscribe: async function* () {} },
    session: {
      hook,
      get: async () => { assert.fail('Incompatible activation read session state') },
      context: async () => { assert.fail('Incompatible activation read model context') },
      synthetic: async () => { assert.fail('Incompatible activation admitted synthetic input') },
    },
    tool: { hook },
  }
  return { context, registrations, callbacks, marker, async add(id: string, dialect: Dialect, selection?: SourceSpec['selection'], enabled = true) {
    const path = join(directory, id + ' hooks.json')
    const command = 'PRIVATE_NATIVE_BODY ' + marker
    const bytes = JSON.stringify({ ...(!enabled ? { disableAllHooks: true } : {}), hooks: { Stop: [{ matcher: 'unmatched', hooks: [{ type: 'command', command, if: 'Bash(*)' }] }] } })
    await writeFile(path, bytes)
    sources.push({ id, dialect, path, ...(selection ? { selection } : {}) })
    reviewedDigests[id] = createHash('sha256').update(bytes).digest('hex')
    return path
  } }
}

for (const dialects of [['claude-code'], ['codex'], ['claude-code', 'codex']] as const) {
  test(`default stock V2 retains only fatal guards for selected Stop (${dialects.join('+')})`, async t => {
    const f = await fixture(t)
    const paths = await Promise.all(dialects.map((dialect, index) => f.add('source-' + index, dialect)))
    const dispose = await definition.setup(f.context)
    t.after(() => dispose?.())
    assert.deepEqual(f.registrations, ['prompt', 'context', 'model.request', 'http.request', 'execute.before', 'execute.after'])
    for (const callback of f.callbacks.values()) await assert.rejects(callback({}), error => {
      assert.ok(error instanceof Error && 'code' in error && 'outcome' in error)
      assert.equal(error.code, 'HOST_STOP_UNSUPPORTED')
      assert.equal(error.outcome, 'unsupported')
      for (const value of ['V2', 'Stop', 'awaited-completion-decision', ...paths, ...f.context.options.sources.map(source => source.id)]) assert.ok(error.message.includes(value), value)
      assert.equal(error.message.includes('PRIVATE_NATIVE_BODY'), false)
      return true
    })
    await assert.rejects(readFile(f.marker), { code: 'ENOENT' })
  })
}

test('advertising completion cannot enable an unintegrated default V2 Stop adapter', async t => {
  const f = await fixture(t)
  const path = await f.add('claimed-completion', 'claude-code')
  const dispose = await definition.setup({ ...f.context, experimental: { capabilities: { 'session.response.completed': true } } } as typeof f.context)
  t.after(() => dispose?.())
  for (const callback of f.callbacks.values()) await assert.rejects(callback({}), error => {
    assert.ok(error instanceof Error && 'code' in error)
    assert.equal(error.code, 'HOST_STOP_UNSUPPORTED')
    for (const value of [path, 'Stop', 'verified-completion-adapter']) assert.ok(error.message.includes(value), value)
    return true
  })
  assert.ok(!f.registrations.includes('experimental.idle'))
  await dispose?.()
  assert.equal(f.callbacks.size, 0)
})

for (const excluded of ['disabled', 'selection'] as const) test(`default stock V2 permits explicitly ${excluded} Stop without registering idle`, async t => {
  const f = await fixture(t)
  await f.add('excluded', 'claude-code', excluded === 'selection' ? { events: ['PreToolUse'] } : undefined, excluded !== 'disabled')
  const dispose = await definition.setup(f.context)
  assert.ok(!f.registrations.includes('experimental.idle'))
  await dispose?.()
})
