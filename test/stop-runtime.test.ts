import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { createRuntime } from '../src/runtime.js'
import type { RuntimeServices } from '../src/runtime.js'
import type { StopDelivery, StopDiagnostic, StopEvent } from '../src/stop.js'
import type { Dialect } from '../src/contracts.js'

const quiet = { report: () => {}, dispatchDiagnostic: () => {} }
const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'"
function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
async function fixture(t: TestContext, repeats = 1, dialect: Dialect = 'codex', mode = 'block') {
  const directory = await mkdtemp(join(tmpdir(), 'harness-stop-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const log = join(directory, 'payloads.jsonl')
  const script = join(directory, 'hook.mjs')
  await writeFile(script, `import { appendFileSync } from 'node:fs'
let input = ''
for await (const chunk of process.stdin) input += chunk
const payload = JSON.parse(input)
appendFileSync(${JSON.stringify(log)}, JSON.stringify(payload) + '\\n')
if (${JSON.stringify(mode)} === 'failure') { process.stderr.write('Failure'); process.exitCode = 1 }
else if (${JSON.stringify(mode)} === 'stop') process.stdout.write(JSON.stringify({ continue: false, stopReason: 'Finished' }))
else if (!payload.stop_hook_active) process.stdout.write(JSON.stringify({ decision: 'block', reason: 'Feedback' }))
`)
  const command = quote(process.execPath) + ' ' + quote(script)
  const bytes = JSON.stringify({ hooks: { Stop: [{ hooks: Array.from({ length: repeats }, () => ({ type: 'command', command, onFailure: 'block' })) }] } })
  const path = join(directory, 'hooks.json')
  await writeFile(path, bytes)
  const options = { sources: [{ id: 'native', dialect, path }], reviewedDigests: { native: createHash('sha256').update(bytes).digest('hex') }, permissionMode: 'default' }
  return { directory, options, path, command, event: (completionID = 'answer') => ({ host: 'v2' as const, event: 'Stop' as const, cwd: directory, sessionID: 'session', messageID: 'prompt', completionID, data: { last_assistant_message: 'Answer', ...(dialect === 'claude-code' ? { transcript_path: join(directory, 'transcript.jsonl'), background_tasks: [], session_crons: [] } : {}) } }), payloads: async () => (await readFile(log, 'utf8')).trim().split('\n').map(row => JSON.parse(row)) }
}
async function connect(t: TestContext, f: Awaited<ReturnType<typeof fixture>>, stop: NonNullable<RuntimeServices['stop']>) {
  const runtime = await createRuntime('v2', f.directory, f.options, { ...quiet, host: { environment: { PATH: process.env.PATH, HOME: f.directory, SHELL: '/bin/sh' } }, stop: { diagnostic: () => {}, ...stop } })
  t.after(() => runtime.dispose())
  runtime.sessions.prompt('session', 'prompt', 'model')
  return runtime
}

test('mixed Stop preserves native payload session identities without changing host lifetime or receipt ownership', async t => {
  const f = await fixture(t)
  const capture = join(f.directory, 'native-identities.jsonl'), script = join(f.directory, 'identities.cjs')
  await writeFile(script, `const fs=require('node:fs');const payload=JSON.parse(fs.readFileSync(0,'utf8'));fs.appendFileSync(${JSON.stringify(capture)},JSON.stringify({payload,thread:process.env.CODEX_THREAD_ID??null})+'\\n');console.log(JSON.stringify({decision:'block',reason:'Feedback'}));`)
  const bytes = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: [process.execPath, script].map(quote).join(' ') }] }] } })
  await writeFile(f.path, bytes)
  const sources = (['claude-code', 'codex'] as const).map(dialect => ({ id: dialect, dialect, path: f.path }))
  const digest = createHash('sha256').update(bytes).digest('hex')
  const deliveries: StopDelivery[] = []
  const runtime = await createRuntime('v2', f.directory, { sources, reviewedDigests: { 'claude-code': digest, codex: digest }, permissionMode: 'default' }, { ...quiet, host: { environment: { PATH: process.env.PATH, HOME: f.directory, SHELL: '/bin/sh' } }, stop: { diagnostic: () => {}, admit: async delivery => { deliveries.push(delivery) } } })
  t.after(() => runtime.dispose())
  runtime.sessions.prompt('session', 'prompt', 'model')
  const owner = runtime.sessions.get('session')
  const nativeSessionIDs = { 'claude-code': 'claude-thread', codex: '1982c3ae-f864-4aab-9ae3-22f2c9cef652' }
  const input = { ...f.event(), nativeSessionIDs, data: { transcript_path: join(f.directory, 'claude.jsonl'), last_assistant_message: 'Answer', background_tasks: [], session_crons: [] }, dialectData: { codex: { transcript_path: join(f.directory, 'codex.jsonl') } } }
  const expectedIDs = { ...nativeSessionIDs }
  const pending = runtime.stop(input)
  nativeSessionIDs.codex = 'changed-after-submission'
  const receipt = await pending
  const rows = (await readFile(capture, 'utf8')).trim().split('\n').map(row => JSON.parse(row))
  assert.deepEqual(new Set(rows.map(row => row.payload.session_id)), new Set(Object.values(expectedIDs)))
  assert.equal(rows.find(row => row.payload.session_id === expectedIDs.codex).thread, expectedIDs.codex)
  assert.equal(rows.find(row => row.payload.session_id === expectedIDs['claude-code']).thread, null)
  assert.equal(receipt.sessionID, 'session')
  assert.equal(receipt.messageID, 'prompt')
  assert.equal(receipt.control, 'continue')
  assert.equal(deliveries[0]!.event.sessionID, 'session')
  assert.equal(deliveries[0]!.session.signal, owner.signal)
  assert.equal(deliveries[0]!.dispatch.diagnostic.sessionID, 'session')
  assert.deepEqual(runtime.sessions.get('session'), owner)
  assert.equal((await runtime.stop({ ...input, nativeSessionIDs: expectedIDs })).dispatchID, receipt.dispatchID)
  await assert.rejects(runtime.stop(input), { code: 'HOST_STOP_IDENTITY_CONFLICT' })
  await assert.rejects(runtime.stop({ ...input, completionID: 'invalid-native', nativeSessionIDs: { codex: '' } }), { code: 'HOST_NATIVE_METADATA_UNAVAILABLE' })
  assert.equal((await readFile(capture, 'utf8')).trim().split('\n').length, rows.length)
  runtime.sessions.close('session')
  assert.equal(owner.signal.aborted, true)
})

test('core Stop treats an undefined optional native identity as omission', async t => {
  const f = await fixture(t)
  const runtime = await connect(t, f, { admit: async () => {} })
  const input = { ...f.event(), nativeSessionIDs: { codex: undefined } } as unknown as StopEvent
  const receipt = await runtime.stop(input)
  assert.equal(receipt.sessionID, 'session')
  assert.equal((await f.payloads())[0].session_id, 'session')
})

test('core Stop awaits feedback admission and keeps independent registrations in the same logical turn', async t => {
  const f = await fixture(t, 2)
  const admitted = deferred(), release = deferred()
  t.after(() => release.resolve())
  const deliveries: StopDelivery[] = []
  const runtime = await connect(t, f, { admit: async delivery => { deliveries.push(delivery); admitted.resolve(); await release.promise } })
  const session = runtime.sessions.get('session')
  const first = runtime.stop(f.event())
  assert.equal(runtime.stop(f.event()), first)
  await admitted.promise
  let finished = false
  void first.then(() => { finished = true }, () => { finished = true })
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(finished, false)
  assert.equal(deliveries[0]!.effects.continuations.length, 2)
  assert.deepEqual(deliveries[0]!.effects.continuations.map(row => row.action.mode), ['user', 'user'])
  assert.equal(deliveries[0]!.dispatch.entries.length, 2)
  assert.ok(deliveries[0]!.dispatch.entries.every(entry => 'commandArtifact' in entry.result))
  assert.equal(deliveries[0]!.event.data!.stop_hook_active, false)
  release.resolve()
  const receipt = await first
  assert.equal(receipt.control, 'continue')
  assert.deepEqual(runtime.sessions.get('session'), session)
  assert.equal(runtime.stop(f.event()), first)
  assert.equal((await runtime.stop(f.event('continued-answer'))).control, 'complete')
  const payloads = await f.payloads()
  assert.deepEqual(payloads.map(row => row.stop_hook_active), [false, false, true, true])
  assert.ok(payloads.every(row => row.turn_id === 'prompt' && row.model === 'model'))
  assert.equal(deliveries.length, 2)
  runtime.sessions.prompt('session', 'next', 'next-model')
  await runtime.stop({ ...f.event('next-answer'), messageID: 'next' })
  assert.equal((await f.payloads()).at(-1).stop_hook_active, false)
})

test('Claude Stop continuation channels survive shared dispatch and effect admission', async t => {
  const f = await fixture(t, 2, 'claude-code')
  const deliveries: StopDelivery[] = []
  const runtime = await connect(t, f, { admit: async delivery => { deliveries.push(delivery) } })
  assert.equal((await runtime.stop(f.event())).control, 'continue')
  assert.deepEqual(deliveries[0]!.effects.continuations.map(row => row.action.channel), ['decision', 'decision'])
  assert.deepEqual(deliveries[0]!.dispatch.actions.map(row => row.action.kind === 'continue-turn' ? row.action.channel : undefined), ['decision', 'decision'])
  assert.equal((await f.payloads()).length, 2)
})

test('completion conflicts and overlaps reject without replaying the native hook', async t => {
  const f = await fixture(t)
  const admitted = deferred(), release = deferred()
  t.after(() => release.resolve())
  const runtime = await connect(t, f, { admit: async () => { admitted.resolve(); await release.promise } })
  const pending = runtime.stop(f.event())
  await admitted.promise
  await assert.rejects(runtime.stop({ ...f.event(), data: { last_assistant_message: 'Different' } }), { code: 'HOST_STOP_IDENTITY_CONFLICT' })
  await assert.rejects(runtime.stop(f.event('overlap')), { code: 'HOST_STOP_OVERLAP_UNVERIFIED' })
  release.resolve()
  await pending
  assert.equal((await f.payloads()).length, 1)
})

test('metadata preflight rejects missing native fields before command execution', async t => {
  const f = await fixture(t, 1, 'claude-code')
  let admissions = 0
  const diagnostics: StopDiagnostic[] = []
  const runtime = await connect(t, f, { admit: async () => { admissions++ }, diagnostic: value => { diagnostics.push(value) } })
  await assert.rejects(runtime.stop({ ...f.event(), data: { last_assistant_message: 'Private answer' } }), { code: 'HOST_NATIVE_METADATA_UNAVAILABLE' })
  await assert.rejects(f.payloads(), { code: 'ENOENT' })
  assert.equal(admissions, 0)
  assert.equal(diagnostics.at(-1)!.sourceID, 'native')
  assert.equal(diagnostics.at(-1)!.field, 'transcript_path')
  assert.ok(!JSON.stringify(diagnostics).includes('Private answer'))
  assert.ok(!JSON.stringify(diagnostics).includes(f.command))
  await assert.rejects(runtime.stop({ ...f.event(), data: { last_assistant_message: 'Answer', transcript_path: join(f.directory, 'transcript.jsonl'), session_crons: [] } }), { code: 'HOST_NATIVE_METADATA_UNAVAILABLE' })
  await assert.rejects(f.payloads(), { code: 'ENOENT' })
})

test('Stop failure policy remains nonblocking while continue false prevents continuation without closing the session', async t => {
  for (const mode of ['failure', 'stop']) {
    const f = await fixture(t, 1, 'claude-code', mode)
    const deliveries: StopDelivery[] = []
    const runtime = await connect(t, f, { admit: async delivery => { deliveries.push(delivery) } })
    const receipt = await runtime.stop(f.event())
    assert.equal(receipt.control, mode === 'failure' ? 'complete' : 'stop')
    assert.equal(deliveries[0]!.effects.continuations.length, 0)
    assert.equal(deliveries[0]!.dispatch.diagnostic.failed, mode === 'failure' ? 1 : 0)
    assert.equal(runtime.sessions.get('session').signal.aborted, false)
    runtime.sessions.prompt('session', 'next')
    await runtime.stop({ ...f.event('next-answer'), messageID: 'next' })
  }
})

test('a new prompt cancels pending Stop admission and stale completion cannot set the next turn active', async t => {
  const f = await fixture(t)
  const admitted = deferred(), cancelled = deferred()
  let first = true
  const runtime = await connect(t, f, { admit: async delivery => {
    if (!first) return
    first = false
    admitted.resolve()
    await new Promise<void>(resolve => delivery.signal.addEventListener('abort', () => { cancelled.resolve(); resolve() }, { once: true }))
  } })
  const pending = runtime.stop(f.event())
  await admitted.promise
  runtime.sessions.prompt('session', 'next', 'model')
  await assert.rejects(pending, { code: 'HOST_STOP_CANCELLED' })
  await cancelled.promise
  await assert.rejects(runtime.stop(f.event()), { code: 'SESSION_STALE_TURN' })
  await runtime.stop({ ...f.event('next-answer'), messageID: 'next' })
  assert.equal((await f.payloads()).at(-1).stop_hook_active, false)
})

test('receipt retention limits fail before side effects and session close releases them', async t => {
  const f = await fixture(t)
  const runtime = await connect(t, f, { maxCompletions: 1, admit: async () => {} })
  await runtime.stop(f.event())
  await assert.rejects(runtime.stop(f.event('excess')), { code: 'HOST_STOP_LIMIT' })
  assert.equal((await f.payloads()).length, 1)
  assert.equal(runtime.inspect().stops!.retained, 1)
  runtime.sessions.close('session')
  assert.equal(runtime.inspect().stops!.retained, 0)
  assert.equal(runtime.inspect().stops!.bytes, 0)
})

test('admission timeout aborts the service and reports private correlated diagnostics', async t => {
  const f = await fixture(t)
  const diagnostics: StopDiagnostic[] = []
  let signal: AbortSignal | undefined
  const runtime = await connect(t, f, { serviceTimeoutMs: 20, admit: async delivery => {
    signal = delivery.signal
    await new Promise<void>(resolve => delivery.signal.addEventListener('abort', () => resolve(), { once: true }))
  }, diagnostic: value => { diagnostics.push(value); throw new Error('Private observer failure') } })
  await assert.rejects(runtime.stop(f.event()), { code: 'HOST_STOP_ADMISSION_TIMEOUT' })
  assert.equal(signal!.aborted, true)
  assert.equal(diagnostics.at(-1)!.phase, 'admission')
  assert.equal(diagnostics.at(-1)!.completionID, 'answer')
  assert.match(diagnostics.at(-1)!.dispatchID!, /^[a-f0-9-]+$/)
  assert.ok(diagnostics.at(-1)!.durationMs >= 0)
  assert.equal(runtime.inspect().stops!.observerFailures, 1)
  assert.ok(!JSON.stringify(diagnostics).includes('Feedback'))
  assert.ok(!JSON.stringify(diagnostics).includes(f.directory))
})

test('disposal reports an undrained admission service and permits a later cleanup retry', async t => {
  const f = await fixture(t)
  const admitted = deferred(), release = deferred()
  t.after(() => release.resolve())
  const runtime = await connect(t, f, { serviceTimeoutMs: 20, admit: async () => { admitted.resolve(); await release.promise } })
  const pending = runtime.stop(f.event())
  await admitted.promise
  await assert.rejects(runtime.dispose(), { code: 'HOST_STOP_ADMISSION_DRAIN_FAILED' })
  await assert.rejects(pending, { code: 'HOST_STOP_CANCELLED' })
  assert.equal(runtime.inspect().stops!.admissions, 1)
  release.resolve()
  await runtime.dispose()
  assert.equal(runtime.inspect().stops!.admissions, 0)
})

test('Stop waits for explicit startup coordination before executing a hook', async t => {
  const f = await fixture(t)
  const source = JSON.parse(await readFile(f.path, 'utf8'))
  source.hooks.SessionStart = [{ hooks: [{ type: 'command', command: ':' }] }]
  const bytes = JSON.stringify(source)
  await writeFile(f.path, bytes)
  f.options.reviewedDigests.native = createHash('sha256').update(bytes).digest('hex')
  const runtime = await createRuntime('v2', f.directory, f.options, { ...quiet, sessionStart: { diagnostic: () => {}, admit: async () => {} }, stop: { diagnostic: () => {}, admit: async () => {} } })
  t.after(() => runtime.dispose())
  runtime.sessions.prompt('session', 'prompt', 'model')
  await assert.rejects(runtime.stop(f.event()), { code: 'HOST_SESSION_START_REQUIRED' })
  await assert.rejects(f.payloads(), { code: 'ENOENT' })
  await runtime.start({ host: 'v2', event: 'SessionStart', sessionID: 'session', activationID: 'startup', cwd: f.directory, data: { source: 'startup', model: 'model' } })
  assert.equal((await runtime.stop(f.event('after-start'))).control, 'continue')
})

test('default host factories retain ownership of Stop admission services', async t => {
  const { createHarnessHooks, setupHarnessHooks } = await import('../src/plugin.js')
  const f = await fixture(t)
  const services = { ...quiet, stop: { admit: async () => {} } }
  await assert.rejects(createHarnessHooks({ directory: f.directory }, f.options, services), error => {
    assert.equal((error as { code: string }).code, 'HOST_STOP_UNSUPPORTED')
    assert.ok((error as Error).message.includes(f.path))
    return true
  })
  const hook = async () => ({ dispose: () => {} })
  await assert.rejects(setupHarnessHooks({ location: { directory: f.directory }, options: f.options, session: { hook }, tool: { hook } }, services), { code: 'HOST_STOP_HOST_UNAVAILABLE' })
  await assert.rejects(createRuntime('v2', f.directory, f.options, quiet), { code: 'HOST_EVENT_UNAVAILABLE' })
  await assert.rejects(createRuntime('v1', f.directory, f.options, services), error => {
    assert.equal((error as { code: string }).code, 'HOST_STOP_UNSUPPORTED')
    assert.ok((error as Error).message.includes(f.path))
    assert.ok((error as Error).message.includes('awaited-completion-decision'))
    return true
  })
})

test('a failed admission cannot mark a later completion as a hook continuation', async t => {
  const f = await fixture(t)
  let first = true
  const runtime = await connect(t, f, { admit: async () => {
    if (first) { first = false; throw new Error('Private admission failure') }
  } })
  await assert.rejects(runtime.stop(f.event()), { code: 'HOST_STOP_ADMISSION_FAILED' })
  assert.equal((await runtime.stop(f.event('retry-answer'))).control, 'continue')
  assert.deepEqual((await f.payloads()).map(row => row.stop_hook_active), [false, false])
})

test('invalid Stop identities and conflicting owned metadata execute no command', async t => {
  const f = await fixture(t)
  const runtime = await connect(t, f, { admit: async () => {} })
  const valid = f.event()
  await assert.rejects(runtime.stop(undefined as unknown as StopEvent), { code: 'HOST_STOP_INPUT_INVALID' })
  for (const invalid of [{ ...valid, sessionID: '' }, { ...valid, messageID: '' }, { ...valid, completionID: 'nul\0id' }, { ...valid, completionID: 'x'.repeat(4097) }, { ...valid, event: 'SubagentStop' }, { ...valid, cwd: 'relative' }]) {
    await assert.rejects(runtime.stop(invalid as StopEvent), { code: 'HOST_STOP_INPUT_INVALID' })
  }
  await assert.rejects(runtime.stop({ ...valid, host: 'v1' }), { code: 'HOST_VERSION_MISMATCH' })
  for (const data of [{ stop_hook_active: true }, { turn_id: 'foreign' }, { prompt_id: 'foreign' }]) {
    await assert.rejects(runtime.stop({ ...valid, data: { ...valid.data, ...data } }), { code: 'HOST_STOP_METADATA_CONFLICT' })
    await assert.rejects(runtime.stop({ ...valid, dialectData: { codex: data } }), { code: 'HOST_STOP_METADATA_CONFLICT' })
  }
  await assert.rejects(f.payloads(), { code: 'ENOENT' })
  assert.equal(runtime.inspect().stops!.retained, 0)
  await runtime.stop(valid)
  assert.equal((await f.payloads()).length, 1)
})

test('Stop preserves native skipped handlers and rejects unsupported execution before admission', async t => {
  for (const dialect of ['codex', 'claude-code'] as const) {
    const f = await fixture(t, 1, dialect)
    const bytes = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'prompt', prompt: 'Return success' }] }] } })
    await writeFile(f.path, bytes)
    f.options.reviewedDigests.native = createHash('sha256').update(bytes).digest('hex')
    const deliveries: StopDelivery[] = []
    const runtime = await connect(t, f, { admit: async delivery => { deliveries.push(delivery) } })
    if (dialect === 'codex') {
      assert.equal((await runtime.stop(f.event())).control, 'complete')
      assert.equal(deliveries[0]!.dispatch.entries[0]!.result.status, 'skipped')
    } else {
      await assert.rejects(runtime.stop(f.event()), { code: 'HOST_STOP_HANDLER_UNAVAILABLE' })
      assert.equal(deliveries.length, 0)
    }
    await assert.rejects(f.payloads(), { code: 'ENOENT' })
  }
})

test('invalid Stop resource limits reject construction', async t => {
  const f = await fixture(t)
  for (const limits of [{ maxCompletions: 0 }, { maxCompletions: 10001 }, { maxCompletions: 1.5 }, { serviceTimeoutMs: 0 }, { serviceTimeoutMs: Infinity }]) {
    await assert.rejects(createRuntime('v2', f.directory, f.options, { ...quiet, stop: { ...limits, admit: async () => {} } }), { code: 'HOST_STOP_OPTIONS_INVALID' })
  }
})

test('an undrained timed-out admission retains the session completion lock across prompt replacement', async t => {
  const f = await fixture(t)
  const release = deferred()
  t.after(() => release.resolve())
  let first = true
  const runtime = await connect(t, f, { serviceTimeoutMs: 20, admit: async () => {
    if (!first) return
    first = false
    await release.promise
  } })
  await assert.rejects(runtime.stop(f.event()), { code: 'HOST_STOP_ADMISSION_TIMEOUT' })
  await assert.rejects(runtime.stop(f.event('overlap')), { code: 'HOST_STOP_OVERLAP_UNVERIFIED' })
  runtime.sessions.prompt('session', 'next', 'model')
  await assert.rejects(runtime.stop({ ...f.event('next-answer'), messageID: 'next' }), { code: 'HOST_STOP_OVERLAP_UNVERIFIED' })
  assert.equal((await f.payloads()).length, 1)
  release.resolve()
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal((await runtime.stop({ ...f.event('after-drain'), messageID: 'next' })).control, 'continue')
  assert.deepEqual((await f.payloads()).map(row => row.stop_hook_active), [false, false])
})
