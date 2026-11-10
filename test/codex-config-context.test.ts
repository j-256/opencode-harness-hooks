import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { loadSources } from '../src/config.js'
import type { CodexConfigLayer, CodexConfigContext, SourceSpec } from '../src/types.js'

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'harness-codex-context-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'hooks.json'), config = join(root, 'config.toml')
  const bytes = JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'echo first' }, { type: 'command', command: 'echo second' }] }] } })
  await writeFile(path, bytes)
  const key = path + ':pre_tool_use:0:0'
  const state = (enabled: boolean) => `[hooks.state.${JSON.stringify(key)}]\nenabled=${enabled}\n`
  await writeFile(config, state(false))
  return { root, path, config, key, state, bytes, base: { id: 'native', dialect: 'codex' as const, path }, unchanged: async () => assert.equal(await readFile(path, 'utf8'), bytes) }
}

test('explicit Codex user settings disable a JSON registration without importing settings-layer hooks', async t => {
  const f = await fixture(t)
  const settings = f.state(false) + '[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ntype="command"\ncommand="must not import"\n[unrelated]\nvalue="PRIVATE_CONTEXT_SENTINEL"\n'
  await writeFile(f.config, settings)
  const [source] = await loadSources([{ ...f.base, codexConfig: { sourceLayer: 0, layers: [{ scope: 'user', path: f.config }] } }])
  assert.deepEqual(source?.registrations.map(row => row.handler.command), ['echo second'])
  assert.deepEqual(source?.excluded.map(row => [row.id, row.reason]), [['native:PreToolUse:0:0', 'handler-disabled']])
  assert.ok(!JSON.stringify(source).includes('PRIVATE_CONTEXT_SENTINEL'))
  assert.equal(await readFile(f.config, 'utf8'), settings)
  await f.unchanged()
})

test('project-style layers cannot change user state and session fields merge over it', async t => {
  const f = await fixture(t)
  const project = join(f.root, 'project.toml')
  await writeFile(project, f.state(true))
  const layers: CodexConfigLayer[] = [{ scope: 'user', path: f.config }, { scope: 'other', path: project }]
  const [ignoredProject] = await loadSources([{ ...f.base, codexConfig: { layers } }])
  assert.deepEqual(ignoredProject?.registrations.map(row => row.handler.command), ['echo second'])
  const [trustOnly] = await loadSources([{ ...f.base, codexConfig: { layers: [...layers, { scope: 'session', settings: { hooks: { state: { [f.key]: { trusted_hash: 'synthetic' } } } } }] } }])
  assert.deepEqual(trustOnly?.registrations.map(row => row.handler.command), ['echo second'])
  const [enabled] = await loadSources([{ ...f.base, codexConfig: { layers: [...layers, { scope: 'session', settings: { hooks: { state: { ['  ' + f.key + '  ']: { enabled: true } } } } }] } }])
  assert.deepEqual(enabled?.registrations.map(row => row.handler.command), ['echo first', 'echo second'])
})

test('native feature requirements apply after the declared settings layers', async t => {
  const f = await fixture(t)
  await writeFile(f.config, '[features]\nhooks=false\n')
  for (const required of [true, false]) {
    const [source] = await loadSources([{ ...f.base, codexConfig: { layers: [{ scope: 'user', path: f.config }], featureRequirements: { hooks: required } } }])
    assert.equal(source?.enabled, required)
    assert.equal(source?.registrations.length, required ? 2 : 0)
    if (!required) assert.ok(source?.excluded.every(row => row.reason === 'source-disabled'))
  }
})

test('disabled eligible layers still supply hook state but do not supply ordinary feature flags', async t => {
  const f = await fixture(t), owner = join(f.root, 'owner.toml')
  await writeFile(f.config, '[features]\nhooks=false\n' + f.state(false))
  await writeFile(owner, '[features]\nhooks=true\n')
  const [source] = await loadSources([{ ...f.base, codexConfig: { sourceLayer: 1, layers: [{ scope: 'user', path: f.config, disabled: true }, { scope: 'other', path: owner }] } }])
  assert.equal(source?.enabled, true)
  assert.deepEqual(source?.registrations.map(row => row.handler.command), ['echo second'])
  const [inactive] = await loadSources([{ ...f.base, codexConfig: { sourceLayer: 0, layers: [{ scope: 'user', path: f.config, disabled: true }], featureRequirements: { hooks: true } } }])
  assert.equal(inactive?.enabled, false)
  assert.equal(inactive?.registrations.length, 0)
})

test('context review digest binds layer bytes, session settings, scope and requirements', async t => {
  const f = await fixture(t)
  const context: CodexConfigContext = { layers: [{ scope: 'user', path: f.config }] }
  const [first] = await loadSources([{ ...f.base, codexConfig: context }])
  assert.notEqual(first?.digest, createHash('sha256').update(f.bytes).digest('hex'))
  await writeFile(f.config, f.state(true))
  const [changed] = await loadSources([{ ...f.base, codexConfig: context }])
  const [otherScope] = await loadSources([{ ...f.base, codexConfig: { layers: [{ scope: 'other', path: f.config }] } }])
  const [required] = await loadSources([{ ...f.base, codexConfig: { ...context, featureRequirements: { hooks: true } } }])
  const [session] = await loadSources([{ ...f.base, codexConfig: { layers: [...context.layers, { scope: 'session', settings: { hooks: { state: { [f.key]: { enabled: false } } } } }] } }])
  assert.equal(new Set([first?.digest, changed?.digest, otherScope?.digest, required?.digest, session?.digest]).size, 5)
  assert.deepEqual(first?.registrations.map(row => row.handler.command), ['echo second'])
  await f.unchanged()
})

test('context descriptors are snapshotted before asynchronous source reads', async t => {
  const f = await fixture(t), other = join(f.root, 'other.toml')
  await writeFile(other, f.state(true))
  const spec = { ...f.base, codexConfig: { layers: [{ scope: 'user' as const, path: f.config }] } } satisfies SourceSpec
  const pending = loadSources([spec])
  spec.codexConfig.layers[0]!.path = other
  const [source] = await pending
  assert.deepEqual(source?.registrations.map(row => row.handler.command), ['echo second'])
})

test('active malformed native state fails while disabled raw layers skip malformed entries', async t => {
  const f = await fixture(t)
  await writeFile(f.config, f.state(false) + 'trusted_hash=3\n')
  await assert.rejects(loadSources([{ ...f.base, codexConfig: { layers: [{ scope: 'user', path: f.config }] } }]), { code: 'SOURCE_SCHEMA' })
  const [source] = await loadSources([{ ...f.base, codexConfig: { sourceLayer: 1, layers: [{ scope: 'user', path: f.config, disabled: true }, { scope: 'other', settings: {} }] } }])
  assert.deepEqual(source?.registrations.map(row => row.handler.command), ['echo first', 'echo second'])
})

test('native state key trimming preserves raw entry order and Rust whitespace', async t => {
  const f = await fixture(t)
  const state = (key: string, enabled: boolean) => `[hooks.state.${JSON.stringify(key)}]\nenabled=${enabled}\n`
  for (const [bytes, enabled] of [
    [state(f.key, true) + state('  ' + f.key + '  ', false), false],
    [state('  ' + f.key + '  ', false) + state(f.key, true), true],
    [state('\u0085' + f.key + '\u0085', false), false],
    [state('\ufeff' + f.key + '\ufeff', false), true],
  ] as const) {
    await writeFile(f.config, bytes)
    const [source] = await loadSources([{ ...f.base, codexConfig: { layers: [{ scope: 'user', path: f.config }] } }])
    assert.deepEqual(source?.registrations.map(row => row.handler.command), enabled ? ['echo first', 'echo second'] : ['echo second'])
  }
})

test('effective config validation permits repaired lower state while raw extraction skips it', async t => {
  const f = await fixture(t)
  await writeFile(f.config, f.state(false) + 'trusted_hash=3\n')
  const [source] = await loadSources([{ ...f.base, codexConfig: { layers: [{ scope: 'user', path: f.config }, { scope: 'session', settings: { hooks: { state: { [f.key]: { trusted_hash: 'synthetic' } } } } }] } }])
  assert.deepEqual(source?.registrations.map(row => row.handler.command), ['echo first', 'echo second'])
})

test('effective active hooks shape must be valid after configuration merging', async t => {
  const f = await fixture(t)
  await writeFile(f.config, 'hooks=3\n')
  await assert.rejects(loadSources([{ ...f.base, codexConfig: { layers: [{ scope: 'user', path: f.config }], featureRequirements: { hooks: true } } }]), { code: 'SOURCE_SCHEMA' })
  const [repaired] = await loadSources([{ ...f.base, codexConfig: { layers: [{ scope: 'user', path: f.config }, { scope: 'session', settings: { hooks: { state: { [f.key]: { enabled: false } } } } }] } }])
  assert.deepEqual(repaired?.registrations.map(row => row.handler.command), ['echo second'])
})
