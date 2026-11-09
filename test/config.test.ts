import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), 'hook-config-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

test('loads native JSON and inline TOML without importing unrelated config or deduplicating sources', async t => {
  const { loadSources } = await import('../src/config.js')
  const root = await fixture(t)
  const claude = join(root, 'claude.json')
  const codex = join(root, 'codex.toml')
  await writeFile(claude, JSON.stringify({
    provider: { secret: 'UNRELATED_SECRET_SENTINEL' },
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo duplicate', timeout: 12 }] }] },
  }))
  await writeFile(codex, '[provider]\nsecret = "UNRELATED_SECRET_SENTINEL"\n[[hooks.PreToolUse]]\nmatcher = "Bash"\n[[hooks.PreToolUse.hooks]]\ntype = "command"\ncommand = "echo duplicate"\ntimeout = 12\n[hooks.state]\ntrusted = true\n')
  const sources = await loadSources([
    { id: 'claude', dialect: 'claude-code', path: claude },
    { id: 'codex', dialect: 'codex', path: codex },
  ])
  assert.equal(sources.length, 2)
  assert.equal(sources[0]?.registrations[0]?.handler.command, 'echo duplicate')
  assert.equal(sources[1]?.registrations[0]?.handler.command, 'echo duplicate')
  assert.notEqual(sources[0]?.registrations[0]?.id, sources[1]?.registrations[0]?.id)
  assert.equal(sources[1]?.registrations[0]?.handler.timeout, 12)
  assert.equal(JSON.stringify(sources).includes('UNRELATED_SECRET_SENTINEL'), false)
})

test('source snapshots are deeply immutable and loading never rewrites native files', async t => {
  const { loadSources } = await import('../src/config.js')
  const root = await fixture(t)
  const path = join(root, 'hooks.json')
  const original = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'original', args: ['one'] }] }] } })
  await writeFile(path, original)
  const [source] = await loadSources([{ id: 'source', dialect: 'claude-code', path, projectRoot: root, pluginRoot: join(root, 'plugin') }])
  assert.equal(await readFile(path, 'utf8'), original)
  await writeFile(path, original.replace('original', 'changed'))
  assert.equal(source?.registrations[0]?.handler.command, 'original')
  assert.throws(() => { (source!.registrations[0]!.handler as Record<string, unknown>).command = 'tampered' }, TypeError)
  assert.equal(source?.projectRoot, root)
  assert.equal(source?.pluginRoot, join(root, 'plugin'))
})

test('captures source descriptors before asynchronous reads can observe caller mutation', async t => {
  const { loadSources } = await import('../src/config.js')
  const root = await fixture(t)
  const path = join(root, 'hooks.json')
  await writeFile(path, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'keep' }] }] } }))
  const spec = { id: 'original', dialect: 'claude-code' as const, path }
  const pending = loadSources([spec])
  spec.id = 'changed'
  spec.path = join(root, 'different.json')
  const [source] = await pending
  assert.equal(source?.id, 'original')
  assert.equal(source?.path, path)
  assert.equal(source?.registrations[0]?.sourceID, 'original')
})

test('disabled sources and explicit selection report every excluded registration', async t => {
  const { loadSources } = await import('../src/config.js')
  const root = await fixture(t)
  const path = join(root, 'settings.json')
  const hooks = { PreToolUse: [{ hooks: [{ type: 'command', command: 'keep' }, { type: 'command', command: 'exclude' }] }], Stop: [{ hooks: [{ type: 'command', command: 'stop' }] }] }
  await writeFile(path, JSON.stringify({ hooks }))
  const [selected] = await loadSources([{ id: 'selected', dialect: 'claude-code', path, selection: { events: ['PreToolUse'], excludeCommands: ['exclude'] } }])
  assert.deepEqual(selected?.registrations.map(item => item.handler.command), ['keep'])
  assert.deepEqual(selected?.excluded.map(item => item.reason).sort(), ['command-excluded', 'event-excluded'])
  assert.equal(JSON.stringify(selected?.excluded).includes('exclude"'), false)
  await writeFile(path, JSON.stringify({ disableAllHooks: true, hooks }))
  const [disabled] = await loadSources([{ id: 'disabled', dialect: 'claude-code', path }])
  assert.equal(disabled?.registrations.length, 0)
  assert.equal(disabled?.excluded.length, 3)
  assert.ok(disabled?.excluded.every(item => item.reason === 'source-disabled'))
})

test('native feature disablement affects only the selected source', async t => {
  const { loadSources } = await import('../src/config.js')
  const root = await fixture(t)
  const path = join(root, 'codex.toml')
  await writeFile(path, '[features]\nhooks = false\n[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ntype = "command"\ncommand = "stop"\n')
  const [source] = await loadSources([{ id: 'codex', dialect: 'codex', path }])
  assert.equal(source?.enabled, false)
  assert.equal(source?.registrations.length, 0)
  assert.equal(source?.excluded[0]?.reason, 'source-disabled')
})

test('preserves per-handler Codex disablement from native state keys', async t => {
  const { loadSources } = await import('../src/config.js')
  const root = await fixture(t)
  const path = join(root, 'config.toml')
  await writeFile(path, `[[hooks.PreToolUse]]\n[[hooks.PreToolUse.hooks]]\ntype = "command"\ncommand = "disabled"\n[hooks.state.${JSON.stringify(path + ':pre_tool_use:0:0')}]\nenabled = false\n`)
  const [source] = await loadSources([{ id: 'codex', dialect: 'codex', path }])
  assert.equal(source?.registrations.length, 0)
  assert.equal(source?.excluded[0]?.reason, 'handler-disabled')
})

test('invalid native definitions fail with bounded diagnostics that exclude source text', async t => {
  const { loadSources } = await import('../src/config.js')
  const root = await fixture(t)
  const path = join(root, 'invalid.json')
  const cases = [
    { hooks: [] },
    { hooks: { UnexpectedEvent: [] } },
    { hooks: { PreToolUse: {} } },
    { hooks: { PreToolUse: [{ matcher: 7, hooks: [] }] } },
    { hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: '' }] }] } },
    { hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'SECRET_SENTINEL', timeout: -1 }] }] } },
    { hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'SECRET_SENTINEL', args: 'wrong' }] }] } },
    { hooks: { PreToolUse: [{ hooks: [{ type: 'unknown', command: 'SECRET_SENTINEL' }] }] } },
  ]
  for (const value of cases) {
    await writeFile(path, JSON.stringify(value))
    await assert.rejects(loadSources([{ id: 'invalid', dialect: 'claude-code', path }]), error => {
      assert.equal(String(error).includes('SECRET_SENTINEL'), false)
      return error instanceof Error && /^SOURCE_/.test(error.message)
    })
  }
  await writeFile(path, '{"secret":"SECRET_SENTINEL",')
  await assert.rejects(loadSources([{ id: 'invalid', dialect: 'claude-code', path }]), error => {
    assert.equal(String(error).includes('SECRET_SENTINEL'), false)
    return error instanceof Error && error.message.startsWith('SOURCE_PARSE')
  })
})

test('bounds source reads and rejects duplicate source identities before executing anything', async t => {
  const { loadSources } = await import('../src/config.js')
  const root = await fixture(t)
  const path = join(root, 'large.json')
  await writeFile(path, JSON.stringify({ hooks: {}, extra: 'x'.repeat(4096) }))
  await assert.rejects(loadSources([{ id: 'large', dialect: 'claude-code', path }], { maxBytes: 128 }), /SOURCE_SIZE/)
  const spec = { id: 'same', dialect: 'claude-code' as const, path }
  await assert.rejects(loadSources([spec, spec]), /SOURCE_DUPLICATE_ID/)
  await assert.rejects(loadSources([{ ...spec, path: join(root, 'missing') }]), /SOURCE_READ/)
})

test('retains native handler families and fields without executing them during inspection', async t => {
  const { loadSources } = await import('../src/config.js')
  const root = await fixture(t)
  const path = join(root, 'handlers.json')
  const handlers = [
    { type: 'command', command: 'never execute this', args: ['literal $value'], async: true, onFailure: 'block', if: 'Bash(git *)' },
    { type: 'http', url: 'http://127.0.0.1:1/unreachable', allowedEnvVars: ['TOKEN'] },
    { type: 'prompt', prompt: 'Deny $ARGUMENTS' },
    { type: 'agent', prompt: 'Verify $ARGUMENTS' },
    { type: 'mcp_tool', server: 'scanner', tool: 'inspect', input: { nested: ['${tool_input.command}'] } },
  ]
  await writeFile(path, JSON.stringify({ hooks: { PreToolUse: [{ hooks: handlers }] } }))
  const [source] = await loadSources([{ id: 'handlers', dialect: 'claude-code', path }])
  assert.deepEqual(source?.registrations.map(item => item.handler), handlers)
  assert.equal(source?.registrations[0]?.handler.async, true)
})

