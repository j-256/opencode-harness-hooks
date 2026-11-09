import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../src/runtime.js'
import { resolveEffects } from '../src/effects.js'
import type { PromptDiagnostic } from '../src/prompt-types.js'
import type { ArtifactDiagnostic } from '../src/model-types.js'

async function fixture(t: { after: (callback: () => Promise<void>) => void }, dialect = 'codex') {
  const directory = await mkdtemp(join(tmpdir(), 'harness-prompt-runtime-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const command = 'printf \'{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"Prompt context"}}\''
  const source = JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command }, { type: 'command', command }] }] } })
  await writeFile(join(directory, 'hooks.json'), source)
  return { directory, options: { sources: [{ id: 'native', dialect, path: 'hooks.json' }], reviewedDigests: { native: createHash('sha256').update(source).digest('hex') }, permissionMode: 'default' } }
}

test('prompt dispatch uses native metadata and independent registrations through the shared engine', async t => {
  const f = await fixture(t)
  const runtime = await createRuntime('v2', f.directory, f.options, { report: () => {}, dispatchDiagnostic: () => {} })
  t.after(() => runtime.dispose())
  assert.equal(runtime.hasPromptHooks, true)
  assert.deepEqual(runtime.report.sources[0]?.unwiredEvents, [])
  runtime.sessions.prompt('session', 'turn', 'model')
  const result = await runtime.prompt({ host: 'v2', event: 'UserPromptSubmit', sessionID: 'session', messageID: 'turn', prompt: 'Original', signal: new AbortController().signal })
  assert.equal(result.entries.length, 2)
  assert.deepEqual(resolveEffects(result).context.map(row => row.action.text), ['Prompt context', 'Prompt context'])
  assert.equal(runtime.inspect().activeDispatches, 0)
})

test('prompt metadata preflight prevents every hook side effect when required model or mode is missing', async t => {
  const f = await fixture(t)
  const text = JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'touch executed' }] }] } })
  await writeFile(join(f.directory, 'hooks.json'), text)
  const options = { ...f.options, reviewedDigests: { native: createHash('sha256').update(text).digest('hex') } }
  for (const missing of ['model', 'mode']) {
    const runtime = await createRuntime('v1', f.directory, { ...options, ...(missing === 'mode' ? { permissionMode: undefined } : {}) }, { report: () => {}, dispatchDiagnostic: () => {} })
    t.after(() => runtime.dispose())
    runtime.sessions.prompt('session', 'turn', missing === 'model' ? undefined : 'model')
    await assert.rejects(runtime.prompt({ host: 'v1', event: 'UserPromptSubmit', sessionID: 'session', messageID: 'turn', prompt: 'Original', signal: new AbortController().signal }), { code: 'HOST_NATIVE_METADATA_UNAVAILABLE' })
    await assert.rejects(access(join(f.directory, 'executed')))
  }
})

test('a prompt service receives cancellation and late metadata cannot reach native execution', async t => {
  const f = await fixture(t)
  let entered!: () => void
  const ready = new Promise<void>(resolve => { entered = resolve })
  let observed: AbortSignal | undefined
  const runtime = await createRuntime('v1', f.directory, f.options, { report: () => {}, dispatchDiagnostic: () => {}, promptData: async (_event, _session, signal) => {
    observed = signal
    entered()
    await new Promise<void>(resolve => { signal.addEventListener('abort', () => resolve(), { once: true }) })
    return {}
  } })
  t.after(() => runtime.dispose())
  runtime.sessions.prompt('session', 'old', 'model')
  const pending = runtime.prompt({ host: 'v1', event: 'UserPromptSubmit', sessionID: 'session', messageID: 'old', prompt: 'Original', signal: new AbortController().signal })
  await ready
  runtime.sessions.prompt('session', 'new', 'model')
  await assert.rejects(pending, { code: 'HOST_PROMPT_CANCELLED' })
  assert.equal(observed?.aborted, true)
  assert.equal(runtime.inspect().activeDispatches, 0)
})

test('prompt diagnostics retain identity and timing without private exception text or observer effects', async t => {
  const f = await fixture(t)
  const diagnostics: PromptDiagnostic[] = []
  const runtime = await createRuntime('v2', f.directory, f.options, { report: () => {}, promptDiagnostic: async value => { diagnostics.push(value); throw new Error('Private observer detail') } })
  t.after(() => runtime.dispose())
  const error = new Error('Private provider request and prompt')
  await assert.rejects(runtime.promptOperation('request', { sessionID: 'session', messageID: 'turn' }, async () => { throw error }), value => value === error)
  await assert.rejects(runtime.promptOperation('admission', { sessionID: 'session' }, async () => { throw error }), value => value === error)
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(diagnostics.length, 1)
  assert.deepEqual({ ...diagnostics[0], durationMs: 0 }, { host: 'v2', event: 'UserPromptSubmit', phase: 'request', sessionID: 'session', messageID: 'turn', code: 'HOST_PROMPT_FAILED', outcome: 'failed', durationMs: 0 })
  assert.ok(diagnostics[0]!.durationMs >= 0)
  assert.ok(!JSON.stringify(diagnostics).includes('Private'))
  assert.equal(runtime.inspect().observerFailures, 1)
})

test('artifact context failures have distinct private diagnostics and cannot become prompt failures', async t => {
  const f = await fixture(t, 'claude-code')
  const artifacts: ArtifactDiagnostic[] = []
  const prompts: PromptDiagnostic[] = []
  const error = new Error('PRIVATE_MODEL_CONTEXT_ERROR')
  const runtime = await createRuntime('v2', f.directory, f.options, { report: () => {}, transcripts: { observe: () => {}, prepare: async () => '/unused', dispose: async () => {}, observeModel: () => { throw error } }, artifactDiagnostic: async value => { artifacts.push(value); throw new Error('PRIVATE_OBSERVER_ERROR') }, promptDiagnostic: value => { prompts.push(value) } })
  t.after(() => runtime.dispose())
  runtime.sessions.prompt('session', 'turn', 'model')
  assert.equal(runtime.needsModelArtifacts, true)
  assert.throws(() => runtime.observeModel({ host: 'v2', sessionID: 'session', messageID: 'turn', signal: runtime.sessions.get('session').turnSignal }), value => value === error)
  await assert.rejects(runtime.promptOperation('headers', { sessionID: 'session' }, async () => { throw error }), value => value === error)
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.deepEqual(artifacts.map(({ durationMs: _duration, ...value }) => value), [{ host: 'v2', artifact: 'claude-transcript', phase: 'model-request', sessionID: 'session', messageID: 'turn', code: 'HOST_ARTIFACT_CONTEXT_FAILED', outcome: 'failed' }])
  assert.deepEqual(prompts, [])
  assert.ok(!JSON.stringify(artifacts).includes('PRIVATE_'))
  assert.equal(runtime.inspect().observerFailures, 1)
})
