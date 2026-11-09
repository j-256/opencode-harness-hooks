#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs, promisify } from 'node:util'

const COMMAND_MS = 15000
const INSTALL_MS = 60000
const MAX_BYTES = 2 * 1024 * 1024
const run = promisify(execFile)
const HELP = `Usage: node scripts/verify-package.mjs [-p PATH]

Verify the built npm artifact in an isolated consumer. Run npm run build first.
Requires Node.js 22+, npm, tar and access to https://registry.npmjs.org for the
locked runtime dependencies. Installs only into disposable temporary state,
with scripts disabled and without machine credentials or user npm settings.
No package is published and no live configuration is changed.

Options:
  -p, --npm PATH  npm executable (default: npm)
  -h, --help      Show help without requiring npm, tar, a build or network access

Checks artifact contents, CLI dependency failures/help, a fresh consumer install,
plugin/library imports and the installed executable's native source inspection.
Success writes metadata JSON to stdout; failures use stderr without subprocess
output. Native equivalence and host behavior remain separate acceptance gates.
Exit status: 0 verified; 1 runtime/check failure; 2 usage; 3 missing dependency.
`
class ProbeError extends Error {
  constructor(code, status = 1) { super(code); this.status = status }
}
async function dependency(program, args, name) {
  try { await run(program, args, { timeout: COMMAND_MS, maxBuffer: MAX_BYTES }) } catch (error) {
    throw new ProbeError('DEPENDENCY_' + (error.code === 'ENOENT' || error.code === 'EACCES' ? 'UNAVAILABLE' : 'QUERY_FAILED') + ': ' + name, error.code === 'ENOENT' || error.code === 'EACCES' ? 3 : 1)
  }
}
async function verify(npm) {
  await dependency(npm, ['--version'], 'npm')
  await dependency('tar', ['--version'], 'tar')
  const project = fileURLToPath(new URL('..', import.meta.url))
  try { await readFile(join(project, 'dist/cli.js')) } catch { throw new ProbeError('DEPENDENCY_UNAVAILABLE: built package', 3) }
  const root = await mkdtemp(join(tmpdir(), 'harness-artifact-'))
  let stage = 'pack'
  try {
    const userConfig = join(root, 'user.npmrc')
    const globalConfig = join(root, 'global.npmrc')
    await Promise.all([writeFile(userConfig, ''), writeFile(globalConfig, '')])
    const env = { PATH: process.env.PATH, HOME: root, npm_config_userconfig: userConfig, npm_config_globalconfig: globalConfig, npm_config_cache: join(root, 'cache'), npm_config_registry: 'https://registry.npmjs.org', npm_config_update_notifier: 'false' }
    const execute = (program, args, cwd = root, timeout = COMMAND_MS) => run(program, args, { cwd, env, timeout, maxBuffer: MAX_BYTES })
    const [packed] = JSON.parse((await execute(npm, ['pack', '--ignore-scripts', '--json', '--pack-destination', root], project)).stdout)
    assert.ok(packed.files.every(file => /^(?:dist\/|docs\/|README\.md$|LICENSE$|package\.json$)/.test(file.path) && !file.path.split('/').includes('..')))
    assert.ok(packed.files.some(file => file.path === 'dist/cli.js'))
    assert.ok(typeof packed.filename === 'string' && !packed.filename.includes('/') && !packed.filename.includes('\\'))
    await execute('tar', ['-xzf', join(root, packed.filename), '-C', root])
    stage = 'contents'
    const unpacked = join(root, 'package')
    for (const file of packed.files) {
      const text = await readFile(join(unpacked, file.path), 'utf8')
      assert.ok(!/\/(?:Users|home)\/[^/\s]+\//.test(text) && !/\/(?:w|c|z)\//.test(text))
    }
    stage = 'standalone-help'
    const cli = join(unpacked, 'dist/cli.js')
    const help = await execute(process.execPath, [cli, '--help'])
    assert.ok(help.stdout.includes('--require-equivalent'))
    assert.equal(help.stderr, '')
    const options = join(root, 'options.json')
    const hooks = join(root, 'hooks.json')
    await writeFile(hooks, JSON.stringify({ hooks: {} }))
    await writeFile(options, JSON.stringify({ sources: [{ id: 'fixture', dialect: 'codex', path: hooks }] }))
    stage = 'missing-dependencies'
    await execute(process.execPath, [cli, 'inspect', '-Hv1', options]).then(() => assert.fail('Expected dependency failure'), error => {
      assert.equal(error.code, 3)
      assert.equal(error.stdout, '')
      assert.equal(error.stderr, 'DEPENDENCY_UNAVAILABLE: package dependencies\n')
    })
    stage = 'install'
    const consumer = join(root, 'consumer')
    await mkdir(consumer)
    await writeFile(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }))
    await execute(npm, ['install', '--ignore-scripts', '--no-audit', '--no-fund', join(root, packed.filename)], consumer, INSTALL_MS)
    stage = 'imports'
    const imported = await execute(process.execPath, ['--input-type=module', '-e', 'import assert from "node:assert/strict"; import * as root from "opencode-harness-hooks"; import {inspectSources, CallApprovals} from "opencode-harness-hooks/core"; assert.deepEqual(Object.keys(root),["default"]); assert.equal(typeof root.default.server,"function"); assert.equal(typeof root.default.setup,"function"); assert.equal(typeof inspectSources,"function"); assert.equal(typeof CallApprovals,"function");'], consumer)
    assert.equal(imported.stderr, '')
    stage = 'installed-cli'
    const bin = join(consumer, 'node_modules/.bin/opencode-harness-hooks')
    const inspected = await execute(bin, ['inspect', '-Hv2', options], consumer)
    assert.equal(inspected.stderr, '')
    const report = JSON.parse(inspected.stdout)
    assert.equal(report.host, 'v2')
    assert.equal(report.equivalent, false)
    await execute(bin, ['inspect', '-Hv1', '--require-equivalent', options], consumer).then(() => assert.fail('Expected unresolved equivalence'), error => {
      assert.equal(error.code, 4)
      assert.equal(error.stderr, '')
      assert.equal(JSON.parse(error.stdout).equivalent, false)
    })
    return { artifact: true, portableContents: true, cliIncluded: true, helpWithoutPackageDependencies: true, missingDependenciesStatus: 3, cleanConsumerInstall: true, defaultAndCoreImports: true, installedBinExecutable: true, nativeSourceInspection: true, requiredEquivalenceStatus: 4, equivalent: false }
  } catch { throw new ProbeError('PACKAGE_CHECK_FAILED: ' + stage) }
  finally { await rm(root, { recursive: true, force: true }) }
}

try {
  let parsed
  try { parsed = parseArgs({ options: { npm: { type: 'string', short: 'p' }, help: { type: 'boolean', short: 'h' } }, strict: true, allowPositionals: false }) } catch { throw new ProbeError('USAGE_INVALID: use --help', 2) }
  if (parsed.values.help) process.stdout.write(HELP)
  else {
    let npm = parsed.values.npm ?? 'npm'
    if (!npm.trim()) throw new ProbeError('USAGE_NPM_EMPTY', 2)
    if (npm.includes('/') || npm.includes('\\')) npm = resolve(npm)
    process.stdout.write(JSON.stringify(await verify(npm)) + '\n')
  }
} catch (error) {
  process.stderr.write((error instanceof ProbeError ? error.message : 'PACKAGE_PROBE_FAILED') + '\n')
  process.exitCode = error instanceof ProbeError ? error.status : 1
}
