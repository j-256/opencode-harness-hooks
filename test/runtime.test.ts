import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../src/runtime.js'
import { Sessions } from '../src/sessions.js'

async function fixture(t: { after: (cleanup: () => Promise<void>) => void }, hooks: unknown) {
  const directory = await mkdtemp(join(tmpdir(), 'harness-runtime-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'hooks.json')
  const text = JSON.stringify({ hooks })
  await writeFile(path, text)
  return { directory, path, options: { sources: [{ id: 'native', dialect: 'codex' as const, path: 'hooks.json' }], reviewedDigests: { native: createHash('sha256').update(text).digest('hex') }, permissionMode: 'default' as const } }
}

test('runtime publishes Codex artifact identities to payload and environment while retaining host ownership', async t => {
  const f = await fixture(t, { PreToolUse: [{ hooks: [{ type: 'command', command: 'node capture.cjs' }] }] })
  await writeFile(join(f.directory, 'capture.cjs'), 'const fs=require("node:fs");const payload=JSON.parse(fs.readFileSync(0,"utf8"));fs.writeFileSync("captured.json",JSON.stringify({payload,thread:process.env.CODEX_THREAD_ID}))')
  let observed = false, prepared = false, disposed = false
  const view = { sessionID: '11111111-1111-5111-8111-111111111111', turnID: '22222222-2222-5222-8222-222222222222', transcriptPath: '/owned/journal.jsonl' }
  const runtime = await createRuntime('v1', f.directory, f.options, { report: () => {}, dispatchDiagnostic: () => {}, codexTranscripts: {
    observe(event) { assert.equal(event.sessionID, 'session'); observed = true },
    async prepare(event) { assert.equal(event.sessionID, 'session'); prepared = true; return view },
    async dispose() { disposed = true },
  } })
  t.after(() => runtime.dispose())
  runtime.sessions.prompt('session', 'turn', 'model')
  const result = await runtime.tools.dispatch({ host: 'v1', event: 'PreToolUse', sessionID: 'session', callID: 'call', tool: 'bash', toolInput: { command: 'original' }, effectiveInput: { command: 'original' }, signal: new AbortController().signal })
  assert.equal(result.entries[0]?.result.status, 'success')
  const captured = JSON.parse(await readFile(join(f.directory, 'captured.json'), 'utf8'))
  assert.equal(observed, true); assert.equal(prepared, true)
  assert.equal(captured.payload.session_id, view.sessionID)
  assert.equal(captured.payload.turn_id, view.turnID)
  assert.equal(captured.payload.transcript_path, view.transcriptPath)
  assert.equal(captured.thread, view.sessionID)
  assert.equal(runtime.sessions.get('session').turnID, 'turn')
  await runtime.dispose()
  assert.equal(disposed, true)
})

test('sessions isolate metadata, reject stale updates and cancel closed sessions without resurrection', () => {
  const sessions = new Sessions(2)
  sessions.prompt('one', 'turn-one', 'model-one')
  sessions.prompt('two', 'turn-two', 'model-two')
  const old = sessions.get('one')
  sessions.prompt('one', 'turn-new')
  assert.equal(old.turnSignal.aborted, true)
  assert.equal(old.signal.aborted, false)
  assert.equal(sessions.get('one').model, undefined)
  assert.throws(() => sessions.model('one', 'stale', 'turn-one'), { code: 'SESSION_STALE_TURN' })
  sessions.model('one', 'new', 'turn-new')
  assert.equal(old.model, 'model-one')
  assert.equal(sessions.get('two').model, 'model-two')
  sessions.close('one')
  assert.equal(old.signal.aborted, true)
  assert.throws(() => sessions.get('one'), { code: 'SESSION_CLOSED' })
  assert.throws(() => sessions.prompt('three', 'turn'), { code: 'SESSION_LIMIT' })
  sessions.dispose()
  assert.throws(() => sessions.get('two'), { code: 'SESSION_DISPOSED' })
  const closedBeforeUse = new Sessions()
  closedBeforeUse.close('unknown')
  assert.throws(() => closedBeforeUse.get('unknown'), { code: 'SESSION_CLOSED' })
  closedBeforeUse.dispose()
})

test('a newer prompt cancels pending metadata work for the old turn while retaining session lifetime', { timeout: 2000 }, async t => {
  const f = await fixture(t, { PreToolUse: [{ hooks: [{ type: 'command', command: 'exit 0' }] }] })
  let entered!: () => void
  const ready = new Promise<void>(resolve => { entered = resolve })
  let metadataSignal: AbortSignal | undefined
  const runtime = await createRuntime('v1', f.directory, f.options, { report: () => {}, dispatchDiagnostic: () => {}, nativeData: async (_event, _session, signal) => {
    metadataSignal = signal
    entered()
    return new Promise(resolve => { signal.addEventListener('abort', () => resolve({}), { once: true }) })
  } })
  t.after(() => runtime.dispose())
  runtime.sessions.prompt('session', 'first', 'model')
  const snapshot = runtime.sessions.get('session')
  const pending = runtime.tools.dispatch({ host: 'v1', event: 'PreToolUse', sessionID: 'session', callID: 'call', tool: 'bash', toolInput: { command: 'original' }, effectiveInput: { command: 'original' }, signal: new AbortController().signal })
  await ready
  runtime.sessions.prompt('session', 'second', 'model')
  await assert.rejects(pending, { code: 'HOST_TOOL_CANCELLED', outcome: 'cancelled' })
  assert.equal(metadataSignal?.aborted, true)
  assert.equal(snapshot.signal.aborted, false)
})

test('runtime reports before execution, keeps independent registrations and pins the reviewed source snapshot', async t => {
  const command = 'printf \'{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","updatedInput":{"command":"rewritten"}}}\''
  const f = await fixture(t, { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command }, { type: 'command', command }] }] })
  const reports: unknown[] = []
  const runtime = await createRuntime('v2', f.directory, f.options, { report: report => { reports.push(report) } })
  t.after(() => runtime.dispose())
  assert.equal(reports.length, 1)
  assert.equal(runtime.report.equivalent, false)
  assert.deepEqual(runtime.report.sources[0]?.events, ['PreToolUse'])
  assert.ok(!JSON.stringify(runtime.report).includes(command))
  assert.ok(!JSON.stringify(runtime.report).includes(f.directory))
  runtime.sessions.prompt('session', 'turn', 'model')
  await writeFile(f.path, '{"hooks":{}}')
  const result = await runtime.tools.dispatch({ host: 'v2', event: 'PreToolUse', sessionID: 'session', callID: 'call', tool: 'shell', toolInput: { command: 'original' }, effectiveInput: { command: 'original' }, signal: new AbortController().signal })
  assert.equal(result.entries.length, 2)
  assert.ok(result.entries.every(entry => entry.result.status === 'success'))
  assert.equal(result.actions.filter(row => row.action.kind === 'replace-input').length, 2)
  await assert.rejects(createRuntime('v2', f.directory, f.options, { report: () => {} }), { code: 'SOURCE_REVIEW_MISMATCH' })
})

test('runtime rejects unreviewed sources and unwired events before a handler can execute', async t => {
  const f = await fixture(t, { SessionEnd: [{ hooks: [{ type: 'command', command: 'exit 0' }] }] })
  const reports: unknown[] = []
  await assert.rejects(createRuntime('v1', f.directory, { ...f.options, reviewedDigests: {} }, { report: report => { reports.push(report) } }), { code: 'SOURCE_REVIEW_REQUIRED' })
  await assert.rejects(createRuntime('v1', f.directory, f.options, { report: report => { reports.push(report) } }), { code: 'HOST_EVENT_UNAVAILABLE' })
  assert.equal(reports.length, 2)
})

test('missing native metadata blocks execution instead of becoming a nonblocking handler failure', async t => {
  const f = await fixture(t, { PreToolUse: [{ hooks: [{ type: 'command', command: 'touch executed' }] }] })
  const runtime = await createRuntime('v1', f.directory, { ...f.options, permissionMode: undefined }, { report: () => {} })
  t.after(() => runtime.dispose())
  const event = { host: 'v1' as const, event: 'PreToolUse' as const, sessionID: 'session', callID: 'call', tool: 'bash', toolInput: { command: 'original' }, effectiveInput: { command: 'original' }, signal: new AbortController().signal }
  await assert.rejects(runtime.tools.dispatch(event), { code: 'HOST_NATIVE_METADATA_UNAVAILABLE' })
  runtime.sessions.prompt('session', 'turn', 'model')
  await assert.rejects(runtime.tools.dispatch(event), { code: 'HOST_NATIVE_METADATA_UNAVAILABLE' })
  await assert.rejects(readFile(join(f.directory, 'executed')))
})

test('session disposal cancels a running hook and drains runtime work', async t => {
  const f = await fixture(t, { PreToolUse: [{ hooks: [{ type: 'command', command: 'sleep 30' }] }] })
  const runtime = await createRuntime('v1', f.directory, f.options, { report: () => {} })
  runtime.sessions.prompt('session', 'turn', 'model')
  const pending = runtime.tools.dispatch({ host: 'v1', event: 'PreToolUse', sessionID: 'session', callID: 'call', tool: 'bash', toolInput: { command: 'original' }, effectiveInput: { command: 'original' }, signal: new AbortController().signal })
  runtime.sessions.close('session')
  await runtime.dispose()
  assert.equal((await pending).cancelled, true)
})

test('runtime exposes nonblocking native failures through metadata diagnostics and contains observer errors', async t => {
  const f = await fixture(t, { PreToolUse: [{ hooks: [{ type: 'command', command: 'exit 7' }] }] })
  const diagnostics: unknown[] = []
  const runtime = await createRuntime('v1', f.directory, f.options, { report: () => {}, dispatchDiagnostic: diagnostic => { diagnostics.push(diagnostic); throw new Error('Observer private text') } })
  t.after(() => runtime.dispose())
  runtime.sessions.prompt('session', 'turn', 'model')
  const result = await runtime.tools.dispatch({ host: 'v1', event: 'PreToolUse', sessionID: 'session', callID: 'call', tool: 'bash', toolInput: { command: 'original' }, effectiveInput: { command: 'original' }, signal: new AbortController().signal })
  assert.equal(result.entries[0]?.result.status, 'failed')
  assert.equal(diagnostics.length, 1)
  assert.equal(runtime.inspect().observerFailures, 1)
  assert.ok(!JSON.stringify(diagnostics).includes('exit 7'))
  assert.ok(!JSON.stringify(diagnostics).includes('Observer private text'))
})

test('invalid matchers do not prevent other runtime registrations and unmatched post results need no projection', async t => {
  const f = await fixture(t, { PreToolUse: [{ matcher: '[', hooks: [{ type: 'command', command: 'exit 7' }] }, { matcher: 'Bash', hooks: [{ type: 'command', command: 'exit 0' }] }] })
  const runtime = await createRuntime('v2', f.directory, f.options, { report: () => {}, dispatchDiagnostic: () => {} })
  t.after(() => runtime.dispose())
  runtime.sessions.prompt('session', 'turn', 'model')
  const event = { host: 'v2' as const, event: 'PreToolUse' as const, sessionID: 'session', callID: 'call', tool: 'shell', toolInput: { command: 'original' }, effectiveInput: { command: 'original' }, signal: new AbortController().signal }
  const result = await runtime.tools.dispatch(event)
  assert.equal(result.entries[0]?.result.code, 'MATCHER_INVALID')
  assert.equal(result.entries[1]?.result.status, 'success')
  assert.equal((await runtime.tools.dispatch({ ...event, event: 'PostToolUse', result: undefined })).entries.length, 0)
})

test('an explicitly invalid native transcript path is not replaced by an apparently valid projection', async t => {
  const f = await fixture(t, { PreToolUse: [{ hooks: [{ type: 'command', command: 'exit 0' }] }] })
  let prepared = false
  const runtime = await createRuntime('v1', f.directory, { ...f.options, sources: f.options.sources.map(source => ({ ...source, dialect: 'claude-code' })) }, {
    report: () => {}, nativeData: async () => ({ 'claude-code': { transcript_path: null } }), transcripts: { observe: () => {}, prepare: async () => { prepared = true; return '/must-not-be-used' }, dispose: async () => {} },
  })
  t.after(() => runtime.dispose())
  runtime.sessions.prompt('session', 'turn', 'fixture')
  await assert.rejects(runtime.tools.dispatch({ host: 'v1', event: 'PreToolUse', sessionID: 'session', callID: 'call', tool: 'bash', toolInput: { command: 'original' }, effectiveInput: { command: 'original' }, signal: new AbortController().signal }), { code: 'HOST_NATIVE_METADATA_UNAVAILABLE' })
  assert.equal(prepared, false)
})
