import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { loadSources } from '../src/config.js'
import { bindCodexStopInventory } from '../src/codex-stop-inventory.js'
import { compileCodexStopPrompt } from '../src/codex-stop-prompts.js'
import { dispatchEvent } from '../src/engine.js'

interface NativeCase { readonly name: string; readonly matcher?: string; readonly handler: { readonly command: string; readonly async?: boolean; readonly statusMessage?: string }; readonly expected: { readonly currentHash: string; readonly timeoutSec: number; readonly enabled: boolean; readonly relativeOrder: number } }
const oracle = JSON.parse(readFileSync(new URL('./fixtures/codex-stop-inventory-oracle.json', import.meta.url), 'utf8')) as { readonly cases: readonly NativeCase[] }
async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'harness-stop-inventory-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'hooks.json')
  const groups = oracle.cases.map(row => ({ ...(row.matcher !== undefined ? { matcher: row.matcher } : {}), hooks: [row.handler] }))
  await writeFile(path, JSON.stringify({ hooks: { Stop: [...groups, { hooks: [{ type: 'prompt' }, { type: 'agent' }] }] } }))
  const settings = { hooks: { state: { [path + ':stop:2:0']: { enabled: false } } } }
  const sources = await loadSources([{ id: 'native', dialect: 'codex', path, codexConfig: { layers: [{ scope: 'user', settings }] } }])
  const nativeRows = oracle.cases.map((row, index) => ({
    key: path + ':stop:' + index + ':0', sourcePath: path, eventName: 'stop', displayOrder: row.expected.relativeOrder + 1,
    handlerType: 'command', command: row.handler.command, async: row.handler.async ?? false, matcher: null,
    timeoutSec: row.expected.timeoutSec, statusMessage: row.handler.statusMessage ?? null, additionalContextLimit: null,
    currentHash: row.expected.currentHash, enabled: row.expected.enabled, isManaged: false, source: 'user', pluginId: null, environmentId: null, trustStatus: 'untrusted',
  }))
  const other = (order: number) => ({ key: 'other:' + order, displayOrder: order, sourcePath: '/other/config.toml', eventName: 'preToolUse' })
  const inventory = { data: [{ cwd: root, errors: [], hooks: [other(0), other(1), ...nativeRows], warnings: [] }] }
  return { root, sources, nativeRows, inventory, input: { sources, nativeVersion: '0.167.0', cwd: root, inventory } }
}

test('binds selected Stop declarations to native hashes and global positions including disabled and other hooks', async t => {
  const f = await fixture(t)
  const identities = bindCodexStopInventory(f.input)
  assert.deepEqual(identities.map(row => row.ordinal), f.nativeRows.filter(row => row.enabled).map(row => row.displayOrder))
  assert.ok(identities.every(row => row.sourceDigest === f.sources[0]!.digest && row.sourcePath === f.sources[0]!.path))
  assert.ok(Object.isFrozen(identities) && Object.isFrozen(identities[0]))
  assert.ok(!JSON.stringify(identities).includes('native &'))
  const before = JSON.stringify(identities)
  f.nativeRows[0]!.displayOrder = 99
  assert.equal(JSON.stringify(identities), before)
})

test('retains independent repeated source registrations without allocating new native ordinals', async t => {
  const f = await fixture(t), source = f.sources[0]!
  const duplicate = { ...source, id: 'again', registrations: source.registrations.map(row => ({ ...row, id: row.id.replace('native:', 'again:'), sourceID: 'again' })) }
  const value = bindCodexStopInventory({ ...f.input, sources: [source, duplicate] })
  assert.deepEqual(value.filter(row => row.sourceID === 'native').map(row => row.ordinal), value.filter(row => row.sourceID === 'again').map(row => row.ordinal))
})

test('normalizes every captured declaration and uses positions independently of listing array order', async t => {
  const f = await fixture(t)
  const sources = await loadSources([{ id: 'native', dialect: 'codex', path: f.sources[0]!.path }])
  f.nativeRows[2]!.enabled = true
  f.inventory.data[0]!.hooks.reverse()
  const result = bindCodexStopInventory({ ...f.input, sources })
  assert.deepEqual(result.map(row => row.ordinal), f.nativeRows.map(row => row.displayOrder))
})

test('bounds inventories and rejects selected unsupported native handler families', async t => {
  const f = await fixture(t), group = f.inventory.data[0]!
  for (const inventory of [{ data: Array(1025).fill(group) }, { data: [{ ...group, hooks: Array(10001).fill(f.nativeRows[0]) }] }]) assert.throws(() => bindCodexStopInventory({ ...f.input, inventory }), /CODEX_INVENTORY_/)
  const source = f.sources[0]!, first = source.registrations[0]!
  const mcp = { ...source, registrations: [{ ...first, handler: { type: 'mcp_tool' as const, server: 'fixture', tool: 'fixture' } }] }
  assert.throws(() => bindCodexStopInventory({ ...f.input, sources: [mcp] }), { code: 'CODEX_INVENTORY_HANDLER_UNSUPPORTED' })
})

test('bounds all declaration hash material before full serialization', async t => {
  const f = await fixture(t), path = join(f.root, 'large.json')
  for (const status of ['x'.repeat(33 * 1024 * 1024), '\0'.repeat(6 * 1024 * 1024)]) {
    await writeFile(path, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'true', statusMessage: status }] }] } }))
    const sources = await loadSources([{ id: 'large', dialect: 'codex', path }], { maxBytes: 64 * 1024 * 1024 })
    const inventory = { data: [{ cwd: f.root, errors: [], hooks: [{ ...f.nativeRows[0], key: path + ':stop:0:0', sourcePath: path, command: 'true', statusMessage: status }], warnings: [] }] }
    const stringify = JSON.stringify
    let fullSerializations = 0
    try {
      JSON.stringify = ((value: unknown, ...args: unknown[]) => { if (value === status) fullSerializations++; return Reflect.apply(stringify, JSON, [value, ...args]) }) as typeof JSON.stringify
      assert.throws(() => bindCodexStopInventory({ ...f.input, sources, inventory }), { code: 'CODEX_INVENTORY_LIMIT' })
    } finally { JSON.stringify = stringify }
    assert.equal(fullSerializations, 0)
  }
})

test('shared native declarations consume the aggregate binding budget for independent selections', async t => {
  const f = await fixture(t), index = oracle.cases.findIndex(row => row.name === 'chunked-unicode-status')
  const original = f.sources[0]!, registration = original.registrations.find(row => row.groupIndex === index)!
  const sources = Array.from({ length: 9000 }, (_, value) => ({ ...original, id: 'source' + value, registrations: [{ ...registration, id: 'row' + value, sourceID: 'source' + value }] }))
  assert.throws(() => bindCodexStopInventory({ ...f.input, sources }), { code: 'CODEX_INVENTORY_LIMIT' })
})

test('rejects stale native command mappings and malformed global inventory without leaking raw metadata', async t => {
  const f = await fixture(t)
  const badRows = [
    { command: 'PRIVATE_METADATA_SENTINEL' }, { currentHash: 'sha256:' + '0'.repeat(64) }, { enabled: false },
    { eventName: 'preToolUse' }, { sourcePath: '/foreign/hooks.json' }, { key: 'foreign:stop:0:0' },
    { displayOrder: -1 }, { displayOrder: 1.5 }, { displayOrder: 0 }, { isManaged: true }, { pluginId: 'plugin' },
    { handlerType: 'mcp_tool' }, { timeoutSec: 999 }, { matcher: '*' }, { async: true }, { statusMessage: 'changed' },
  ]
  for (const change of badRows) {
    const inventory = structuredClone(f.inventory)
    Object.assign(inventory.data[0]!.hooks[2]!, change)
    assert.throws(() => bindCodexStopInventory({ ...f.input, inventory }), (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /^CODEX_INVENTORY_/)
      assert.ok(!error.message.includes('PRIVATE_METADATA_SENTINEL') && !error.message.includes(f.root))
      return true
    })
  }
  for (const inventory of [null, { data: [] }, { data: [f.inventory.data[0], f.inventory.data[0]] }, { data: [{ ...f.inventory.data[0], errors: ['private error'] }] }, { data: [{ ...f.inventory.data[0], cwd: '/other' }] }, { data: [{ ...f.inventory.data[0], hooks: f.nativeRows.slice(1) }] }]) assert.throws(() => bindCodexStopInventory({ ...f.input, inventory }), /CODEX_INVENTORY_/)
  assert.throws(() => bindCodexStopInventory({ ...f.input, nativeVersion: 'changed' }), /CODEX_INVENTORY_VERSION/)
})

test('does not read unrelated commands or evaluate native metadata accessors', async t => {
  const f = await fixture(t)
  let reads = 0
  Object.defineProperty(f.inventory.data[0]!.hooks[0]!, 'command', { get() { reads++; throw new Error('private') } })
  assert.ok(bindCodexStopInventory(f.input).length)
  Object.defineProperty(f.nativeRows[0]!, 'currentHash', { get() { reads++; return 'private' } })
  assert.throws(() => bindCodexStopInventory(f.input), /CODEX_INVENTORY_/)
  assert.equal(reads, 0)
})

test('native inventory binding feeds actual command dispatch and Stop artifact compilation', async t => {
  const f = await fixture(t), command = 'printf \'{"decision":"block","reason":"Inventory feedback"}\''
  const path = join(f.root, 'dispatch.json')
  await writeFile(path, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command }] }] } }))
  const sources = await loadSources([{ id: 'dispatch', dialect: 'codex', path }])
  const inventory = { data: [{ cwd: f.root, errors: [], hooks: [{ ...f.nativeRows[0], key: path + ':stop:0:0', sourcePath: path, command, currentHash: oracle.cases.find(row => row.name === 'dispatch-feedback')!.expected.currentHash }], warnings: [] }] }
  const registrations = bindCodexStopInventory({ ...f.input, sources, inventory })
  const dispatch = await dispatchEvent(sources, { event: 'Stop', sessionID: 'thread', cwd: f.root, data: { turn_id: 'turn', model: 'fixture', permission_mode: 'default', last_assistant_message: 'Answer', stop_hook_active: false } }, { environment: { SHELL: '/bin/sh' }, projectRoot: f.root })
  assert.equal(dispatch.diagnostic.failed, 0)
  const artifacts = compileCodexStopPrompt({ dispatch, sources, registrations, identity: { threadID: 'thread', turnID: 'turn', messageID: 'prompt', createTime: 1, startedAtMs: 1000, completedAtMs: 1001 } })!
  assert.deepEqual(artifacts.event.item.fragments, [{ text: 'Inventory feedback', hookRunId: 'stop:' + f.nativeRows[0]!.displayOrder + ':' + path }])
})
