import assert from 'node:assert/strict'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { listNativeCodexHooks, readNativeCodexConfig, readNativeCodexRequirements } from './native-codex-inventory.mjs'
import { nativeCheckError, runNativeProcess } from './native-process.mjs'

const STATE_CASES = Object.freeze(['project-state', 'session-enable', 'session-trust-field', 'trim-order', 'rust-whitespace', 'bom-key', 'repaired-state', 'invalid-hooks'])
const INVALID_HOOKS = 'invalid-hooks'

export async function verifyNativeCodexLayers(binary, root) {
  const state = join(root, 'layers'), home = join(state, 'home'), config = join(state, 'config'), project = join(state, 'project'), local = join(project, '.codex'), marker = join(state, 'executed')
  await Promise.all([home, config, local].map(path => mkdir(path, { recursive: true })))
  const path = join(config, 'hooks.json'), localHooks = join(local, 'hooks.json'), userConfig = join(config, 'config.toml'), projectConfig = join(local, 'config.toml'), script = join(state, 'hook.cjs')
  await writeFile(script, `require('node:fs').writeFileSync(${JSON.stringify(marker)},'Unexpected execution')`)
  const quote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'"
  const command = [process.execPath, script].map(quote).join(' ')
  const sourceBytes = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command }] }] } })
  const localBytes = JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command }] }] } })
  await writeFile(path, sourceBytes)
  await writeFile(localHooks, localBytes)
  const key = path + ':stop:0:0'
  const stateTable = (name, fields) => `[hooks.state.${JSON.stringify(name)}]\n${fields}\n`
  const trusted = '[projects.' + JSON.stringify(project) + ']\ntrust_level="trusted"\n'
  const env = { PATH: process.env.PATH, HOME: home, CODEX_HOME: config, LANG: 'C', SHELL: '/bin/sh' }
  const cases = []
  let stage = 'setup'
  try {
    for (const name of STATE_CASES) {
      stage = name
      let lower = '[features]\nhooks=true\n', higher = '', overrides = [], enabled = false
      if (name === 'project-state') { lower += stateTable(key, 'enabled=false'); higher = stateTable(key, 'enabled=true') }
      else if (name === 'session-enable') { lower += stateTable(key, 'enabled=false'); overrides = ['hooks.state={' + JSON.stringify(key) + '={enabled=true}}']; enabled = true }
      else if (name === 'session-trust-field') { lower += stateTable(key, 'enabled=false'); overrides = ['hooks.state={' + JSON.stringify(key) + '={trusted_hash="synthetic"}}'] }
      else if (name === 'trim-order') lower += stateTable(key, 'enabled=true') + stateTable('  ' + key + '  ', 'enabled=false')
      else if (name === 'rust-whitespace') lower += stateTable('\u0085' + key + '\u0085', 'enabled=false')
      else if (name === 'bom-key') { lower += stateTable('\ufeff' + key + '\ufeff', 'enabled=false'); enabled = true }
      else if (name === 'repaired-state') { lower += stateTable(key, 'enabled=false\ntrusted_hash=3'); overrides = ['hooks.state={' + JSON.stringify(key) + '={trusted_hash="synthetic"}}']; enabled = true }
      else lower = 'hooks=3\n'
      await writeFile(userConfig, lower + trusted)
      await writeFile(projectConfig, higher)
      const result = await listNativeCodexHooks(binary, project, env, overrides), group = result.data[0]
      const owned = group.hooks.filter(row => row.sourcePath === path)
      if (name === INVALID_HOOKS) { assert.ok(group.errors.length > 0); assert.deepEqual(owned, []) }
      else {
        assert.deepEqual(group.errors, [])
        assert.equal(owned.length, 1)
        assert.equal(owned[0].enabled, enabled)
        assert.ok(group.hooks.some(row => row.sourcePath === localHooks))
      }
      assert.equal(await readFile(userConfig, 'utf8'), lower + trusted)
      assert.equal(await readFile(projectConfig, 'utf8'), higher)
      cases.push({ name, nativeConfigAccepted: name !== INVALID_HOOKS, ...(name !== INVALID_HOOKS ? { enabled } : {}), sourceBytesUnchanged: true })
    }
    stage = 'feature-requirement'
    await writeFile(userConfig, trusted + '[features]\nhooks=false\n')
    await writeFile(projectConfig, '[features]\nhooks=false\n')
    const nativeConfig = await readNativeCodexConfig(binary, project, env)
    const nativeRequirements = await readNativeCodexRequirements(binary, project, env)
    assert.equal(nativeConfig.config.features.hooks, false)
    const requirement = nativeRequirements.requirements?.featureRequirements?.hooks
    assert.ok(requirement === undefined || typeof requirement === 'boolean')
    const featureList = await runNativeProcess(binary, ['features', 'list'], '', project, env)
    const hooks = featureList.stdout.split('\n').find(line => /^hooks\s/.test(line))
    assert.ok(hooks && /\s(true|false)\s*$/.test(hooks))
    assert.equal(/\strue\s*$/.test(hooks), requirement ?? false)
    assert.equal(await readFile(path, 'utf8'), sourceBytes)
    assert.equal(await readFile(localHooks, 'utf8'), localBytes)
    let executed = false
    try { await access(marker); executed = true } catch (error) { if (error.code !== 'ENOENT') throw error }
    assert.equal(executed, false)
    assert.ok(nativeConfig.layers.some(layer => layer.name.type === 'project'))
    return { cases, effectiveFeatureRequirement: true, configReadIncludesProject: true, hooksExecuted: false }
  } catch (error) { throw nativeCheckError('NATIVE_LAYER_CHECK_FAILED', stage, error, import.meta.url) }
}
