import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const project = fileURLToPath(new URL('..', import.meta.url))
const compiler = join(project, 'node_modules/.bin/tsc')

async function artifact(t: TestContext, target: 'engine' | 'v1' | 'v2'): Promise<string> {
  const directory = await mkdtemp(join(project, 'node_modules/.harness-extraction-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const result = spawnSync(compiler, ['-p', `tsconfig.${target}.json`, '--outDir', directory], { cwd: project, encoding: 'utf8', timeout: 30000 })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  await writeFile(join(directory, 'package.json'), JSON.stringify({ type: 'module' }))
  return directory
}

test('the engine builds and dispatches mixed native sources with all adapter modules absent', { timeout: 40000 }, async t => {
  const directory = await artifact(t, 'engine')
  const files = await readdir(directory, { recursive: true })
  assert.equal(files.some(file => file === 'hosts' || /^(?:plugin|index|opencode|v1|v2)\./.test(file)), false, 'Engine compilation reached a binding module')
  for (const name of files.filter(file => /\.(?:js|ts)$/.test(file))) {
    assert.doesNotMatch(await readFile(join(directory, name), 'utf8'), /(?:from\s*|import\s*\()['"](?:@opencode\/|[^'"]*\/hosts\/)/)
  }
  const engine = await import(pathToFileURL(join(directory, 'core.js')).href)
  const capture = join(directory, 'calls.jsonl')
  const hook = join(directory, 'hook.cjs')
  await writeFile(hook, `const fs = require('node:fs'); const input = JSON.parse(fs.readFileSync(0, 'utf8')); fs.appendFileSync(${JSON.stringify(capture)}, JSON.stringify(input) + '\\n'); console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Independent engine denial' } }))`)
  const command = [process.execPath, hook].map(value => "'" + value.replaceAll("'", "'\"'\"'") + "'").join(' ')
  const specs = [{ id: 'claude', dialect: 'claude-code' }, { id: 'codex', dialect: 'codex' }].map(source => ({ ...source, path: join(directory, source.id + '.json') }))
  for (const source of specs) await writeFile(source.path, JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command }] }] } }))
  const sources = await engine.loadSources(specs)
  const result = await engine.dispatchEvent(sources, { event: 'PreToolUse', sessionID: 'extracted', cwd: directory, tool: 'bash', toolInput: { command: 'original' }, data: { transcript_path: '/fixtures/transcript.jsonl', permission_mode: 'default', model: 'fixture', turn_id: 'turn', tool_use_id: 'call' } }, { environment: { SHELL: '/bin/sh' }, projectRoot: directory })
  assert.deepEqual(result.entries.map((entry: { sourceID: string; result: { status: string } }) => [entry.sourceID, entry.result.status]), [['claude', 'success'], ['codex', 'success']])
  assert.equal(engine.resolveEffects(result).permission.action.decision, 'deny')
  const payloads = (await readFile(capture, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.equal(payloads.length, 2)
  assert.ok(payloads.every(payload => payload.tool_input.command === 'original'))
})

for (const target of ['v1', 'v2'] as const) {
  test(`${target} builds and imports without the sibling binding or compatibility root`, { timeout: 40000 }, async t => {
    const directory = await artifact(t, target)
    const files = await readdir(directory, { recursive: true })
    const sibling = target === 'v1' ? 'v2' : 'v1'
    assert.equal(files.some(file => file === 'index.js' || file === 'plugin.js' || file === `${sibling}.js` || file.startsWith(`hosts/plugin-${sibling}.`) || file.startsWith(`hosts/${sibling}.`)), false, 'Version build reached a sibling binding or the compatibility barrel')
    const module = await import(pathToFileURL(join(directory, `${target}.js`)).href)
    assert.equal(typeof module.default.setup, 'function')
    await assert.rejects(module.default.setup({}), { code: 'HOST_CONTEXT_UNSUPPORTED' })
    const unexpected = () => { throw new Error('Passive setup mutated a host domain') }
    const domain = { transform: unexpected, reload: unexpected }
    const v1Context = { options: {}, agent: domain, catalog: domain, command: domain, integration: domain, reference: domain, skill: domain, aisdk: { sdk: unexpected, language: unexpected }, plugin: { add: unexpected, remove: unexpected } }
    const v2Context = { location: { directory }, session: { hook: unexpected }, tool: { hook: unexpected } }
    if (target === 'v1') {
      assert.equal(typeof module.default.server, 'function')
      assert.equal(typeof module.composeV1Provider, 'function')
      assert.equal(await module.default.setup(v1Context), undefined)
    }
    await assert.rejects(module.default.setup(target === 'v1' ? v2Context : v1Context), { code: 'HOST_CONTEXT_UNSUPPORTED' })
  })
}
