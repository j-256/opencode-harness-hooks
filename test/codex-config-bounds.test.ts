import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { loadSources, snapshotSourceSpec } from '../src/config.js'
import { inspectSources } from '../src/inspection.js'
import type { CodexConfigContext } from '../src/types.js'

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'harness-codex-config-bounds-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'hooks.json')
  await writeFile(path, '{"hooks":{}}')
  return { root, spec: { id: 'native', dialect: 'codex' as const, path } }
}

test('oversized inline settings fail before serialization or cloning through loader and inspection', async t => {
  const f = await fixture(t), payload = 'PRIVATE_CONTEXT_VALUE'.repeat(250000)
  const settings = { payload }
  const spec = { ...f.spec, codexConfig: { layers: [{ scope: 'session' as const, settings }] } }
  const stringify = JSON.stringify, clone = globalThis.structuredClone
  let serialized = 0, copied = 0
  try {
    JSON.stringify = ((value: unknown, ...args: unknown[]) => {
      if (value && typeof value === 'object' && 'payload' in value && value.payload === payload) serialized++
      return Reflect.apply(stringify, JSON, [value, ...args])
    }) as typeof JSON.stringify
    globalThis.structuredClone = ((value: unknown, ...args: unknown[]) => {
      if (value === spec || value === spec.codexConfig || value === settings) copied++
      return Reflect.apply(clone, globalThis, [value, ...args])
    }) as typeof structuredClone
    await assert.rejects(loadSources([spec], { maxBytes: 1024 }), { code: 'SOURCE_SIZE' })
    await assert.rejects(inspectSources('v1', f.root, { sources: [spec], reviewedDigests: {} }), { code: 'SOURCE_SIZE' })
  } finally { JSON.stringify = stringify; globalThis.structuredClone = clone }
  assert.equal(serialized, 0)
  assert.equal(copied, 0)
})

test('serialized aliases and aggregate inline layers consume the declared byte ceiling', async t => {
  const f = await fixture(t), shared = { value: 'x'.repeat(400) }
  const stringify = JSON.stringify
  let serialized = 0
  try {
    JSON.stringify = ((value: unknown, ...args: unknown[]) => {
      if (value && typeof value === 'object' && 'entries' in value) serialized++
      return Reflect.apply(stringify, JSON, [value, ...args])
    }) as typeof JSON.stringify
    await assert.rejects(loadSources([{ ...f.spec, codexConfig: { layers: [{ scope: 'session', settings: { entries: Array(8).fill(shared) } }] } }], { maxBytes: 1024 }), { code: 'SOURCE_SIZE' })
    await assert.rejects(loadSources([{ ...f.spec, codexConfig: { layers: [{ scope: 'session', settings: { value: 'a'.repeat(600) } }, { scope: 'session', settings: { value: 'b'.repeat(600) } }] } }], { maxBytes: 1024 }), { code: 'SOURCE_SIZE' })
  } finally { JSON.stringify = stringify }
  assert.equal(serialized, 0)
})

test('inline settings accessors are rejected without executing them', async t => {
  const f = await fixture(t), settings: Record<string, string> = {}
  let reads = 0
  Object.defineProperty(settings, 'value', { enumerable: true, get() { reads++; return 'value' } })
  await assert.rejects(loadSources([{ ...f.spec, codexConfig: { layers: [{ scope: 'session', settings }] } }]), { code: 'SOURCE_SPEC' })
  assert.equal(reads, 0)
})

test('context metadata accessors are rejected without evaluating them', async t => {
  const f = await fixture(t)
  for (const target of ['context', 'layers', 'settings', 'requirements'] as const) {
    let reads = 0
    const layer = { scope: 'session', settings: {} }
    const context = { layers: [layer], featureRequirements: {} }
    const spec = { ...f.spec, codexConfig: context }
    const read = () => { reads++; return target === 'context' ? context : target === 'layers' ? [layer] : target === 'settings' ? {} : true }
    if (target === 'context') Object.defineProperty(spec, 'codexConfig', { enumerable: true, get: read })
    else if (target === 'layers') Object.defineProperty(context, 'layers', { enumerable: true, get: read })
    else if (target === 'settings') Object.defineProperty(layer, 'settings', { enumerable: true, get: read })
    else Object.defineProperty(context.featureRequirements, 'hooks', { enumerable: true, get: read })
    await assert.rejects(loadSources([spec as unknown as Parameters<typeof loadSources>[0][number]]), { code: 'SOURCE_SPEC' })
    assert.equal(reads, 0)
  }
})

test('inline settings charge exact JSON bytes including escapes and surrogate handling', async t => {
  const f = await fixture(t)
  for (const value of ['x', '"\\\b\f\n\r\t\0', 'é\u0085\ufeff🐈', '\ud800', '\udc00', Array(3)]) {
    const settings = { value }, text = JSON.stringify(settings)
    const context = { layers: [{ scope: 'session', settings }] } as CodexConfigContext
    const sourceBytes = Buffer.byteLength('{"hooks":{}}'), limit = sourceBytes + Buffer.byteLength(text)
    const [source] = await loadSources([{ ...f.spec, codexConfig: context }], { maxBytes: limit })
    assert.ok(source?.codexConfig)
    await assert.rejects(loadSources([{ ...f.spec, codexConfig: context }], { maxBytes: limit - 1 }), { code: 'SOURCE_SIZE' })
  }
})

test('context schema rejects ambiguous layers, unknown scopes and unavailable owning indexes', async t => {
  const f = await fixture(t)
  const invalid = [
    null, [], { layers: null }, { layers: [], unknown: 'PRIVATE_CONTEXT_SENTINEL' },
    { layers: [{ scope: 'session', path: 'config.toml' }] }, { layers: [{ scope: 'user' }] },
    { layers: [{ scope: 'user', path: 'config.toml', settings: {} }] },
    { layers: [{ scope: 'project', settings: {} }] }, { layers: [{ scope: 'user', path: 'hooks.json' }] },
    { layers: [{ scope: 'user', settings: {}, disabled: 'false' }] },
    { layers: [{ scope: 'user', settings: {}, unknown: true }] },
    { layers: [], sourceLayer: 0 }, { layers: [{}], sourceLayer: -1 }, { layers: [{}], sourceLayer: 0.5 },
    { layers: [], featureRequirements: { hooks: 'true' } }, { layers: [], featureRequirements: { unknown: true } },
    { layers: Array(65).fill({ scope: 'session', settings: {} }) },
  ]
  for (const context of invalid) await assert.rejects(loadSources([{ ...f.spec, codexConfig: context as CodexConfigContext }]), (error: unknown) => {
    assert.ok(error instanceof Error)
    assert.equal(error.message, 'SOURCE_SPEC: native')
    return true
  })
  await assert.rejects(loadSources([{ ...f.spec, dialect: 'claude-code', codexConfig: { layers: [] } }]), { code: 'SOURCE_SPEC' })
})

test('settings snapshots reject unsupported JSON graphs and preserve caller data', async t => {
  const f = await fixture(t), cycle: Record<string, unknown> = {}
  cycle.self = cycle
  let deep: unknown = {}
  for (let index = 0; index < 130; index++) deep = { next: deep }
  for (const settings of [cycle, { value: Number.NaN }, { value: Number.POSITIVE_INFINITY }, { value: undefined }, { value: () => {} }, { value: 1n }, { value: new Date() }, { value: deep }]) {
    await assert.rejects(loadSources([{ ...f.spec, codexConfig: { layers: [{ scope: 'session', settings: settings as never }] } }]), { code: 'SOURCE_SPEC' })
  }
  assert.equal(cycle.self, cycle)
})

test('bounded snapshots honor smaller later limits and retain immutable context metadata', async t => {
  const f = await fixture(t)
  const spec = snapshotSourceSpec({ ...f.spec, codexConfig: { layers: [{ scope: 'session', settings: { value: 'x'.repeat(300) } }] } }, 1024)
  assert.ok(Object.isFrozen(spec) && Object.isFrozen(spec.codexConfig!.layers[0]!.settings))
  await assert.rejects(loadSources([spec], { maxBytes: 128 }), { code: 'SOURCE_SIZE' })
  const [source] = await loadSources([spec], { maxBytes: 1024 })
  assert.ok(Object.isFrozen(source?.codexConfig) && Object.isFrozen(source?.codexConfig?.layers[0]))
})

test('primary TOML is charged once and cannot be omitted from its explicit stack', async t => {
  const f = await fixture(t), path = join(f.root, 'config.toml'), bytes = '[features]\nhooks=true\n'
  await writeFile(path, bytes)
  const spec = { ...f.spec, path, codexConfig: { layers: [{ scope: 'user' as const, path }] } }
  assert.ok((await loadSources([spec], { maxBytes: Buffer.byteLength(bytes) }))[0])
  await assert.rejects(loadSources([{ ...spec, codexConfig: { layers: [] } }]), { code: 'SOURCE_SPEC' })
})

test('context file reads retain regular-file, parse, combined-size and diagnostic limits', async t => {
  const f = await fixture(t), path = join(f.root, 'private-config.toml')
  const spec = { ...f.spec, codexConfig: { layers: [{ scope: 'user' as const, path }] } }
  await assert.rejects(loadSources([spec]), { code: 'SOURCE_READ' })
  await writeFile(path, 'PRIVATE_CONTEXT_SENTINEL=[')
  await assert.rejects(loadSources([spec]), (error: unknown) => { assert.ok(error instanceof Error); assert.equal(error.message, 'SOURCE_PARSE: native'); return true })
  await writeFile(path, 'value="' + 'x'.repeat(100) + '"\n')
  await assert.rejects(loadSources([spec], { maxBytes: 64 }), { code: 'SOURCE_SIZE' })
  const directory = join(f.root, 'directory.toml')
  await mkdir(directory)
  await assert.rejects(loadSources([{ ...f.spec, codexConfig: { layers: [{ scope: 'user', path: directory }] } }]), { code: 'SOURCE_READ' })
})
