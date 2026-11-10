import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { listNativeCodexHooks } from './native-codex-inventory.mjs'

export async function verifyNativeCodexDeclarations(binary, root, adapter, version) {
  const oracle = JSON.parse(await readFile(new URL('../../test/fixtures/codex-stop-inventory-oracle.json', import.meta.url), 'utf8'))
  const state = join(root, 'declarations'), home = join(state, 'home'), config = join(state, 'config'), project = join(state, 'project')
  await Promise.all([home, config, project].map(path => mkdir(path, { recursive: true })))
  const path = join(config, 'hooks.json'), settings = join(config, 'config.toml')
  const groups = oracle.cases.map(row => ({ ...(row.matcher !== undefined ? { matcher: row.matcher } : {}), hooks: [row.handler] }))
  const bytes = JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'true' }] }], Stop: [...groups, { hooks: [{ type: 'prompt' }, { type: 'agent' }] }] } })
  const settingsBytes = '[features]\nhooks=true\n[hooks.state.' + JSON.stringify(path + ':stop:2:0') + ']\nenabled=false\n'
  await writeFile(path, bytes)
  await writeFile(settings, settingsBytes)
  const env = { PATH: process.env.PATH, HOME: home, CODEX_HOME: config, LANG: 'C', SHELL: '/bin/sh' }
  const inventory = await listNativeCodexHooks(binary, project, env)
  assert.equal(inventory.data.length, 1)
  assert.deepEqual(inventory.data[0].errors, [])
  const rows = inventory.data[0].hooks.filter(row => row.sourcePath === path)
  assert.equal(rows.length, oracle.cases.length + 1)
  assert.equal(rows[0].eventName, 'preToolUse')
  for (const [index, scenario] of oracle.cases.entries()) {
    const row = rows[index + 1]
    assert.equal(row.key, path + ':stop:' + index + ':0')
    assert.deepEqual({ currentHash: row.currentHash, matcher: row.matcher, timeoutSec: row.timeoutSec, enabled: row.enabled, relativeOrder: row.displayOrder - rows[0].displayOrder }, scenario.expected)
  }
  if (adapter) {
    const sources = await adapter.loadSources([{ id: 'native', dialect: 'codex', path, codexConfig: { layers: [{ scope: 'user', path: settings }] } }])
    const bound = adapter.bindCodexStopInventory({ sources, nativeVersion: version, cwd: project, inventory })
    assert.deepEqual(bound.map(row => row.ordinal), rows.filter(row => row.eventName === 'stop' && row.enabled).map(row => row.displayOrder))
  }
  assert.equal(await readFile(path, 'utf8'), bytes)
  assert.equal(await readFile(settings, 'utf8'), settingsBytes)
  return { declarationHashes: true, skippedHandlersDoNotAllocatePositions: true, sourceBytesUnchanged: true, adapterComparison: !!adapter }
}
