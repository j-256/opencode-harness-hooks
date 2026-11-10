import assert from 'node:assert/strict'
import { access, mkdtemp, mkdir, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { verifyNativeCodexLayers } from './lib/native-codex-layers.mjs'
import { listNativeCodexHooks } from './lib/native-codex-inventory.mjs'
import { NativeProbeError as ProbeError, nativeCheckError, runNativeProcess } from './lib/native-process.mjs'

const VERSION = '0.167.0'
const SCENARIOS = Object.freeze({ JSON_STATE: 'json-state', TOML_STATE: 'toml-state', INLINE_STATE: 'inline-state', INLINE_SYMLINK: 'inline-symlink', JSON_SYMLINK: 'json-symlink' })
const VERSION_QUERY_LIMITS = Object.freeze({ durationMs: 5000, graceMs: 1000, maxBytes: 4096 })
const HELP = `Usage: node scripts/verify-codex-sources.mjs [-b PATH]

Check Codex ${VERSION} source identity, event scan order and enabled state through
read-only app-server hooks/list. Requires Node.js 22+, POSIX and pinned Codex.
Uses isolated temporary HOME/config/project state; no package build, model
account, hook execution, installation or live configuration changes.
Exercises hooks.json, inline config.toml, state overrides and source symlinks.
Checks user/project/session state precedence and effective feature requirements.
Machine-managed native sources can remain present and are counted separately.

Options:
  -b, --binary PATH  Codex executable (CODEX_BINARY, then codex)
  -h, --help         Show help without dependencies or executables

Metadata-only JSON goes to stdout; bounded diagnostic codes go to stderr.
Temporary state is removed. No commands, paths or native output are printed.
Exit status: 0 checks pass; 1 runtime/check failure;
2 usage/version/platform precondition; 3 missing executable.
This native reference does not establish OpenCode parity; equivalent is false.
`

async function exists(path) { try { await access(path); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error } }
async function verify(binary) {
  if (process.platform === 'win32') throw new ProbeError('PLATFORM_UNAVAILABLE: POSIX process groups', 2)
  let version
  try { version = (await runNativeProcess(binary, ['--version'], '', process.cwd(), { PATH: process.env.PATH, LANG: 'C' }, VERSION_QUERY_LIMITS)).stdout.trim().replace(/^codex-cli /, '') } catch (error) { throw new ProbeError(error.systemCode === 'ENOENT' || error.systemCode === 'EACCES' ? 'DEPENDENCY_UNAVAILABLE: codex' : 'DEPENDENCY_QUERY_FAILED: codex', error.systemCode === 'ENOENT' || error.systemCode === 'EACCES' ? 3 : 1) }
  if (version !== VERSION) throw new ProbeError('NATIVE_VERSION_MISMATCH', 2)
  const oracle = JSON.parse(await readFile(new URL('../test/fixtures/codex-source-order-oracle.json', import.meta.url), 'utf8'))
  const root = await realpath(await mkdtemp(join(tmpdir(), 'harness-codex-sources-')))
  const results = []
  let stage = 'setup'
  try {
    for (const name of Object.values(SCENARIOS)) {
      stage = name
      const state = join(root, name), home = join(state, 'home'), config = join(state, 'config'), project = join(state, 'project'), marker = join(state, 'executed')
      await Promise.all([home, config, project].map(path => mkdir(path, { recursive: true })))
      const hook = join(state, 'hook.cjs')
      await writeFile(hook, `require('node:fs').writeFileSync(${JSON.stringify(marker)},'Unexpected hook execution');process.exitCode=97`)
      const quote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'"
      const command = [process.execPath, hook].map(quote).join(' ')
      const hooks = Object.fromEntries([...oracle.events].reverse().map(event => [event, [{ hooks: Array.from({ length: event === 'Stop' ? 2 : 1 }, () => ({ type: 'command', command })) }]]))
      const inline = name.startsWith('inline-'), path = join(config, inline ? 'config.toml' : 'hooks.json'), target = join(config, inline ? 'target.toml' : 'target.json')
      const overridePath = name === SCENARIOS.JSON_SYMLINK ? target : path
      const key = overridePath + ':stop:0:1'
      let toml = '[features]\nhooks=true\n'
      if (inline) for (const [event, groups] of Object.entries(hooks)) {
        toml += `[[hooks.${event}]]\n`
        for (const handler of groups[0].hooks) toml += `[[hooks.${event}.hooks]]\ntype="command"\ncommand=${JSON.stringify(handler.command)}\n`
      }
      if (name !== SCENARIOS.JSON_STATE) toml += `[hooks.state.${JSON.stringify(key)}]\nenabled=false\n`
      if (!inline) await writeFile(path, JSON.stringify({ hooks: { ...hooks, state: { [key]: { enabled: false } } } }))
      await writeFile(join(config, 'config.toml'), toml)
      if (name.endsWith('-symlink')) { await rename(path, target); await symlink(inline ? 'target.toml' : 'target.json', path) }
      let configHome = config
      if (name === SCENARIOS.INLINE_SYMLINK) { configHome = join(state, 'config-alias'); await symlink('config', configHome) }
      const before = await readFile(path)
      const env = { PATH: process.env.PATH, HOME: home, CODEX_HOME: configHome, LANG: 'C', SHELL: '/bin/sh' }
      const first = await listNativeCodexHooks(binary, project, env)
      assert.equal(first.data.length, 1)
      assert.deepEqual(first.data[0].errors, [])
      const source = first.data[0].hooks.filter(row => !row.isManaged)
      assert.ok(source.every(row => row.sourcePath === path))
      assert.deepEqual([...new Set(source.map(row => row.eventName[0].toUpperCase() + row.eventName.slice(1)))], oracle.events)
      const stopped = source.filter(row => row.eventName === 'stop')
      assert.equal(stopped.length, 2)
      assert.deepEqual(stopped.map(row => row.enabled), [true, name === SCENARIOS.JSON_STATE || name === SCENARIOS.JSON_SYMLINK])
      assert.deepEqual(stopped.map(row => row.key), [path + ':stop:0:0', path + ':stop:0:1'])
      assert.equal(stopped[1].displayOrder, stopped[0].displayOrder + 1)
      if (name === SCENARIOS.TOML_STATE) {
        await writeFile(join(config, 'config.toml'), toml.replace('enabled=false', 'enabled=true'))
        const second = await listNativeCodexHooks(binary, project, env)
        assert.deepEqual(second.data[0].errors, [])
        assert.deepEqual(second.data[0].hooks.map(row => [row.key, row.displayOrder]), first.data[0].hooks.map(row => [row.key, row.displayOrder]))
        assert.ok(second.data[0].hooks.filter(row => !row.isManaged).every(row => row.enabled))
      }
      assert.deepEqual(await readFile(path), before)
      assert.equal(await exists(marker), false)
      results.push({ name, sourceIdentity: true, eventOrder: true, stateMatches: true, sourceBytesUnchanged: true, hooksExecuted: false, additionalManagedHandlers: first.data[0].hooks.filter(row => row.isManaged).length })
    }
    stage = 'layers'
    const layers = await verifyNativeCodexLayers(binary, root)
    return { version, cases: results, layers, disabledRegistrationOrdinalPreserved: true, nativeInventoryReference: true, bridgeSourceComparison: 'not-implemented', equivalent: false }
  } catch (error) { throw nativeCheckError('NATIVE_SOURCE_CHECK_FAILED', stage, error, import.meta.url) } finally { await rm(root, { recursive: true, force: true }) }
}

try {
  let parsed
  try { parsed = parseArgs({ options: { binary: { type: 'string', short: 'b' }, help: { type: 'boolean', short: 'h' } }, strict: true, allowPositionals: false }) } catch { throw new ProbeError('USAGE_INVALID: use --help', 2) }
  if (parsed.values.help) process.stdout.write(HELP)
  else {
    const binary = parsed.values.binary ?? process.env.CODEX_BINARY ?? 'codex'
    if (!binary.trim()) throw new ProbeError('USAGE_BINARY_EMPTY', 2)
    process.stdout.write(JSON.stringify(await verify(binary)) + '\n')
  }
} catch (error) { process.stderr.write((error instanceof ProbeError ? error.message : 'NATIVE_SOURCE_PROBE_FAILED') + '\n'); process.exitCode = error instanceof ProbeError ? error.status : 1 }
