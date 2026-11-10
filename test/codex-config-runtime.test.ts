import assert from 'node:assert/strict'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { loadSources } from '../src/config.js'
import { inspectSources } from '../src/inspection.js'
import { createRuntime } from '../src/runtime.js'

const quiet = { report: () => {}, dispatchDiagnostic: () => {} }
const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'"
async function fixture(t: TestContext, event = 'PreToolUse') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'harness-codex-config-runtime-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'hooks.json'), config = join(root, 'config.toml'), script = join(root, 'hook.cjs'), log = join(root, 'executed.jsonl')
  await writeFile(script, `require('node:fs').appendFileSync(${JSON.stringify(log)},process.argv[2]+'\\n');process.stdout.write('{}')`)
  const bytes = JSON.stringify({ hooks: { [event]: [{ hooks: [0, 1].map(index => ({ type: 'command', command: [process.execPath, script, String(index)].map(quote).join(' ') })) }] } })
  await writeFile(path, bytes)
  const state = (enabled: boolean) => `[hooks.state.${JSON.stringify(path + ':' + event.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase() + ':0:0')}]\nenabled=${enabled}\n`
  await writeFile(config, state(false))
  const spec = { id: 'native', dialect: 'codex' as const, path, codexConfig: { layers: [{ scope: 'user' as const, path: config }] } }
  return { root, path, config, log, bytes, state, spec }
}

test('inspection resolves layer paths against the host directory and redacts context paths', async t => {
  const f = await fixture(t)
  const { report } = await inspectSources('v1', f.root, { sources: [{ ...f.spec, path: 'hooks.json', codexConfig: { layers: [{ scope: 'user', path: 'config.toml' }] } }], reviewedDigests: {} })
  assert.equal(report.sources[0]?.selected.length, 1)
  assert.ok(!report.unresolved.includes('codex-config-layer-state'))
  assert.ok(report.unresolved.includes('codex-config-context-authentication'))
  assert.ok(!JSON.stringify(report).includes(f.root))
})

test('runtime binds settings review and keeps the active immutable registration snapshot', async t => {
  const f = await fixture(t), [source] = await loadSources([f.spec])
  const options = { sources: [f.spec], reviewedDigests: { native: source!.digest }, permissionMode: 'default' }
  const runtime = await createRuntime('v1', f.root, options, { ...quiet, host: { environment: { PATH: process.env.PATH, HOME: f.root, SHELL: '/bin/sh' } } })
  t.after(() => runtime.dispose())
  runtime.sessions.prompt('session', 'prompt', 'fixture')
  await writeFile(f.config, f.state(true))
  await assert.rejects(createRuntime('v1', f.root, options, quiet), { code: 'SOURCE_REVIEW_MISMATCH' })
  await runtime.tools.dispatch({ host: 'v1', event: 'PreToolUse', sessionID: 'session', callID: 'call', tool: 'bash', toolInput: { command: 'true' }, effectiveInput: { command: 'true' }, signal: new AbortController().signal })
  assert.equal(await readFile(f.log, 'utf8'), '1\n')
  assert.equal(await readFile(f.path, 'utf8'), f.bytes)
})

test('V1 rejects every Stop registration that remains enabled after native context projection', async t => {
  const f = await fixture(t, 'Stop')
  const stopKey = f.path + ':stop:0:'
  await writeFile(f.config, `[hooks.state.${JSON.stringify(stopKey + '0')}]\nenabled=false\n[hooks.state.${JSON.stringify(stopKey + '1')}]\nenabled=false\n`)
  const [source] = await loadSources([f.spec])
  const runtime = await createRuntime('v1', f.root, { sources: [f.spec], reviewedDigests: { native: source!.digest } }, quiet)
  await runtime.dispose()
  const ignored = { ...f.spec, codexConfig: { layers: [{ scope: 'other' as const, path: f.config }] } }
  await assert.rejects(createRuntime('v1', f.root, { sources: [ignored], reviewedDigests: {} }, quiet), (error: unknown) => {
    assert.ok(error instanceof Error)
    assert.match(error.message, /HOST_STOP_UNSUPPORTED/)
    assert.ok(error.message.includes(f.path) && error.message.includes('Stop') && error.message.includes('awaited-completion-decision'))
    return true
  })
})
