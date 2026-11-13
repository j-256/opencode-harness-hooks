import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { createRuntime } from '../src/runtime.js'
import type { RuntimeServices } from '../src/runtime.js'
import type { Dialect, HostVersion } from '../src/contracts.js'
import type { SessionStartDiagnostic, SessionStartEvent } from '../src/session-start.js'

const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'"
const quiet = { report: () => {}, dispatchDiagnostic: () => {}, host: { environment: { PATH: process.env.PATH, SHELL: '/bin/sh' } } }
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'harness-start-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const sources: { id: string; dialect: Dialect; path: string }[] = []
  const reviewedDigests: Record<string, string> = {}
  return { directory, options: { sources, reviewedDigests, permissionMode: 'default' }, async add(dialect: Dialect, hooks: Record<string, unknown>) {
    const id = 'source-' + sources.length
    const path = join(directory, id + '.json')
    const bytes = JSON.stringify({ hooks })
    await writeFile(path, bytes)
    sources.push({ id, dialect, path })
    reviewedDigests[id] = createHash('sha256').update(bytes).digest('hex')
  } }
}

async function connect(t: TestContext, f: Awaited<ReturnType<typeof fixture>>, services: RuntimeServices, host: HostVersion = 'v1') {
  const nativeHost = services.host ?? { environment: { ...quiet.host.environment, HOME: f.directory } }
  const runtime = await createRuntime(host, f.directory, f.options, { ...quiet, ...services, host: nativeHost })
  t.after(() => runtime.dispose())
  return runtime
}

function event(directory: string, sessionID = 'session', activationID = 'startup'): SessionStartEvent {
  return { host: 'v1', event: 'SessionStart', cwd: directory, sessionID, activationID, data: { source: 'startup', model: 'fixture', transcript_path: join(directory, 'native.jsonl') } }
}

async function waitFor(path: string, signal?: AbortSignal) {
  for (let attempt = 0; attempt < 500; attempt++) {
    signal?.throwIfAborted()
    try { return await readFile(path, 'utf8') } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error }
    await delay(10, undefined, signal ? { signal } : undefined)
  }
  assert.fail('Fixture side effect did not arrive')
}

for (const host of ['v1', 'v2'] as const) test(`mixed startup runs unchanged duplicate hooks independently and admits one activation once (${host})`, async t => {
  const f = await fixture(t)
  const capture = join(f.directory, 'calls.jsonl'), projected = join(f.directory, 'projected.json'), rejected = join(f.directory, 'rejected.json')
  const script = join(f.directory, 'hook.cjs')
  await writeFile(script, `const fs=require('node:fs');const p=JSON.parse(fs.readFileSync(0,'utf8'));const mode=process.argv[3];const path=process.env.CLAUDE_ENV_FILE;if(path)fs.appendFileSync(path,'export SESSION_VALUE=value\\n');fs.appendFileSync(process.argv[2],JSON.stringify({mode,p,envFile:path})+'\\n');const text=mode==='claude'?'claude:'+require('node:path').basename(path):'codex';console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'SessionStart',additionalContext:text}}));`)
  const command = { type: 'command', command: process.execPath, args: [script, capture, 'claude'] }
  await f.add('claude-code', { SessionStart: [{ hooks: [{ type: 'http', url: 'http://127.0.0.1:1' }, { type: 'prompt', prompt: 'Skipped' }, { type: 'mcp_tool', server: 'missing', tool: 'missing' }, { type: 'command', command: 'exit 99', if: 'Bash(*)' }, command, command] }] })
  await f.add('codex', { SessionStart: [{ hooks: [{ type: 'command', command: [process.execPath, script, capture, 'codex'].map(quote).join(' ') }] }] })
  let admissions = 0
  const diagnostics: unknown[] = []
  const runtime = await connect(t, f, { sessionStart: { environmentDirectory: join(f.directory, 'environment'), diagnostic: value => { diagnostics.push(value) }, admit: async delivery => {
    admissions++
    assert.equal(delivery.signal.aborted, false)
    assert.equal(delivery.event.activationID, 'startup')
    await writeFile(projected, JSON.stringify(delivery.dispatch.actions.flatMap(row => row.action.kind === 'context' ? [row.action.text] : [])))
    await writeFile(rejected, JSON.stringify(delivery.dispatch.entries.flatMap(row => row.result.status === 'failed' && row.result.nativeFailureArtifact ? [row.result.nativeFailureArtifact] : [])))
  } } }, host)
  const input = { ...event(f.directory), host }
  const [first, repeated] = await Promise.all([runtime.start(input), runtime.start(structuredClone(input))])
  assert.equal(first.dispatchID, repeated.dispatchID)
  assert.equal(first.handlers, 7)
  assert.equal(first.failed, 2)
  assert.equal(admissions, 1)
  assert.deepEqual(JSON.parse(await readFile(projected, 'utf8')), ['claude:sessionstart-hook-0.sh', 'claude:sessionstart-hook-1.sh', 'codex'])
  const failures = JSON.parse(await readFile(rejected, 'utf8'))
  assert.ok(Number.isSafeInteger(failures[0].durationMs) && failures[0].durationMs >= 0)
  assert.equal(Object.hasOwn(failures[1], 'durationMs'), false)
  assert.deepEqual(failures.map((failure: Record<string, unknown>) => Object.fromEntries(Object.entries(failure).filter(([key]) => !['completedAt', 'durationMs'].includes(key)))), [
    { type: 'hook_non_blocking_error', command: 'Skipped', stdout: '', stderr: 'Failed to run: prompt-type hooks are not supported for SessionStart events (no conversation context is available). Use a command-type hook instead.', exitCode: 1 },
    { type: 'hook_non_blocking_error', stdout: '', stderr: "mcp_tool hooks are not available for the 'SessionStart' hook event (no MCP client context)", exitCode: 1 },
  ])
  const calls = (await readFile(capture, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(calls.map(row => row.mode).sort(), ['claude', 'claude', 'codex'])
  const claude = calls.filter(row => row.mode === 'claude')
  assert.equal(new Set(claude.map(row => row.envFile)).size, 2)
  for (const row of claude) assert.equal(await readFile(row.envFile, 'utf8'), 'export SESSION_VALUE=value\n')
  for (const row of calls) {
    assert.equal(row.p.session_id, 'session')
    assert.equal(row.p.source, 'startup')
    assert.equal(row.p.activationID, undefined)
  }
  assert.equal(calls.find(row => row.mode === 'codex').p.permission_mode, 'default')
  assert.ok(runtime.report.sources.every(source => source.unwiredEvents.length === 0))
  assert.equal(runtime.report.equivalent, false)
  assert.equal(diagnostics.length, 1)
  for (const forbidden of [f.directory, script, 'SESSION_VALUE', 'native.jsonl', 'additionalContext']) assert.equal(JSON.stringify(diagnostics).includes(forbidden), false)
})

test('all matching dialect metadata is preflighted before files, state or any command side effects', async t => {
  const f = await fixture(t)
  const capture = join(f.directory, 'unwanted')
  await f.add('claude-code', { SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'printf ran >> ' + quote(capture) }] }] })
  await f.add('codex', { SessionStart: [{ hooks: [{ type: 'command', command: 'printf ran >> ' + quote(capture) }] }] })
  const diagnostics: SessionStartDiagnostic[] = []
  const runtime = await connect(t, f, { sessionStart: { environmentDirectory: join(f.directory, 'environment'), diagnostic: value => { diagnostics.push(value) }, admit: async () => { assert.fail('Incomplete startup reached admission') } } })
  const before = await readdir(f.directory)
  await assert.rejects(runtime.start({ ...event(f.directory), data: { source: 'startup', transcript_path: join(f.directory, 'native.jsonl') } }), { code: 'HOST_NATIVE_METADATA_UNAVAILABLE' })
  await assert.rejects(runtime.start({ ...event(f.directory), data: { model: 'fixture', transcript_path: join(f.directory, 'native.jsonl') } }), { code: 'HOST_SESSION_START_SOURCE_UNAVAILABLE' })
  assert.deepEqual(await readdir(f.directory), before)
  assert.equal(runtime.sessions.inspect().retained, 0)
  assert.equal(diagnostics[0]?.sourceID, 'source-1')
  assert.equal(diagnostics[0]?.registrationID, 'source-1:SessionStart:0:0')
  assert.equal(diagnostics[0]?.dialect, 'codex')
  assert.equal(diagnostics[0]?.field, 'model')
  assert.equal(diagnostics[1]?.sourceID, 'source-0')
  assert.equal(diagnostics[1]?.field, 'source')
})

test('activation services and command environment are captured before asynchronous source inspection', async t => {
  const f = await fixture(t)
  const projected = join(f.directory, 'projected'), capture = join(f.directory, 'captured')
  await f.add('claude-code', { SessionStart: [{ hooks: [{ type: 'command', command: 'printf "%s" "$SNAPSHOT" > ' + quote(capture) }] }] })
  const startup = { environmentDirectory: join(f.directory, 'original-state'), admit: async () => { await writeFile(projected, 'original') } }
  const environment = { ...quiet.host.environment, HOME: f.directory, SNAPSHOT: 'original' }
  const runtime = await connect(t, f, { host: { environment }, sessionStart: startup, report: () => {
    environment.SNAPSHOT = 'changed'
    startup.environmentDirectory = join(f.directory, 'changed-state')
    startup.admit = async () => { await writeFile(projected, 'changed') }
  } })
  await runtime.start(event(f.directory))
  assert.equal(await readFile(projected, 'utf8'), 'original')
  assert.equal(await readFile(capture, 'utf8'), 'original')
  assert.ok((await readdir(f.directory)).includes('original-state'))
  assert.equal((await readdir(f.directory)).includes('changed-state'), false)
})

test('prompt and tool preparation wait for admission while model observation enforces readiness', async t => {
  const f = await fixture(t)
  const entered = join(f.directory, 'entered'), release = join(f.directory, 'release'), metadata = join(f.directory, 'metadata.json')
  const prompt = join(f.directory, 'prompt'), tool = join(f.directory, 'tool')
  await f.add('codex', {
    SessionStart: [{ hooks: [{ type: 'command', command: ':' }] }],
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'printf prompt > ' + quote(prompt) }] }],
    PreToolUse: [{ hooks: [{ type: 'command', command: 'printf tool > ' + quote(tool) }] }],
  })
  const runtime = await connect(t, f, {
    promptData: async () => JSON.parse(await readFile(metadata, 'utf8')),
    nativeData: async () => JSON.parse(await readFile(metadata, 'utf8')),
    sessionStart: { admit: async delivery => { await writeFile(entered, 'entered'); await waitFor(release, delivery.signal); delivery.signal.throwIfAborted(); await writeFile(metadata, '{}') } },
  })
  runtime.sessions.prompt('session', 'turn', 'fixture')
  const input = event(f.directory)
  const starting = runtime.start(input)
  await waitFor(entered)
  assert.throws(() => runtime.observeModel({ host: 'v1', sessionID: 'session', messageID: 'turn', signal: runtime.sessions.get('session').turnSignal }), { code: 'HOST_SESSION_START_NOT_READY' })
  const submitted = runtime.prompt({ host: 'v1', event: 'UserPromptSubmit', sessionID: 'session', messageID: 'turn', prompt: 'Prompt', signal: runtime.sessions.get('session').turnSignal })
  const preparing = runtime.tools.dispatch({ host: 'v1', event: 'PreToolUse', sessionID: 'session', callID: 'call', tool: 'bash', toolInput: { command: 'original' }, effectiveInput: { command: 'original' }, signal: runtime.sessions.get('session').turnSignal })
  void submitted.catch(() => {}); void preparing.catch(() => {})
  await writeFile(release, 'go')
  await Promise.all([starting, submitted, preparing])
  assert.equal(await readFile(prompt, 'utf8'), 'prompt')
  assert.equal(await readFile(tool, 'utf8'), 'tool')
  assert.equal((await runtime.waitForStart('session'))?.dispatchID, (await starting).dispatchID)
  runtime.observeModel({ host: 'v1', sessionID: 'session', messageID: 'turn', signal: runtime.sessions.get('session').turnSignal })
})

test('failed admission is retained without replaying commands and stale activations cannot replace a newer one', async t => {
  const f = await fixture(t)
  const calls = join(f.directory, 'calls')
  await f.add('codex', { SessionStart: [{ hooks: [{ type: 'command', command: "printf 'called\\n' >> " + quote(calls) }] }] })
  const diagnostics: unknown[] = []
  const runtime = await connect(t, f, { sessionStart: { maxActivations: 2, diagnostic: value => { diagnostics.push(value) }, admit: async delivery => { if (delivery.event.activationID === 'first') throw new Error('PRIVATE_ADMISSION_BODY') } } })
  const first = event(f.directory, 'session', 'first')
  await assert.rejects(runtime.start(first), { code: 'HOST_SESSION_START_ADMISSION_FAILED' })
  await assert.rejects(runtime.start(first), { code: 'HOST_SESSION_START_ADMISSION_FAILED' })
  await assert.rejects(runtime.waitForStart('session'), { code: 'HOST_SESSION_START_ADMISSION_FAILED' })
  assert.equal(await readFile(calls, 'utf8'), 'called\n')
  await assert.rejects(runtime.start({ ...first, data: { ...first.data, model: 'changed' } }), { code: 'HOST_SESSION_START_IDENTITY_CONFLICT' })
  const second = { ...event(f.directory, 'session', 'second'), data: { ...first.data, source: 'resume' } }
  await runtime.start(second)
  await assert.rejects(runtime.start(first), { code: 'HOST_SESSION_START_STALE', outcome: 'cancelled' })
  await assert.rejects(runtime.start(event(f.directory, 'session', 'third')), { code: 'HOST_SESSION_START_LIMIT' })
  assert.equal(await readFile(calls, 'utf8'), 'called\ncalled\n')
  assert.equal(runtime.inspect().sessionStarts?.retained, 2)
  assert.equal(JSON.stringify(diagnostics).includes('PRIVATE_ADMISSION_BODY'), false)
  assert.equal(JSON.stringify(diagnostics).includes(calls), false)
})

test('equivalent metadata from separate routes shares work without changing input or array semantics', async t => {
  const f = await fixture(t)
  const calls = join(f.directory, 'calls.jsonl'), script = join(f.directory, 'capture.cjs')
  await writeFile(script, `const fs=require('node:fs');fs.appendFileSync(process.argv[2],JSON.stringify(JSON.parse(fs.readFileSync(0,'utf8')))+'\\n')`)
  await f.add('codex', { SessionStart: [{ hooks: [{ type: 'command', command: [process.execPath, script, calls].map(quote).join(' ') }] }] })
  const runtime = await connect(t, f, { sessionStart: { admit: async () => {} } })
  const data = { source: 'startup', model: 'fixture', nested: { first: 1, second: 2 }, order: ['a', 'b'] }
  const first = runtime.start({ ...event(f.directory), data })
  data.model = 'changed-after-submission'
  const second = runtime.start({ activationID: 'startup', sessionID: 'session', cwd: f.directory, event: 'SessionStart', host: 'v1', data: { order: ['a', 'b'], nested: { second: 2, first: 1 }, model: 'fixture', source: 'startup' } })
  const receipts = await Promise.all([first, second])
  assert.equal(receipts[0].dispatchID, receipts[1].dispatchID)
  const rows = (await readFile(calls, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.equal(rows.length, 1)
  assert.equal(rows[0].model, 'fixture')
  await assert.rejects(runtime.start({ ...event(f.directory), data: { ...data, model: 'fixture', order: ['b', 'a'] } }), { code: 'HOST_SESSION_START_IDENTITY_CONFLICT' })
})

test('distinct sessions start concurrently while overlapping activations of one session stay explicit', async t => {
  const f = await fixture(t)
  const release = join(f.directory, 'release'), calls = join(f.directory, 'calls'), script = join(f.directory, 'wait.cjs')
  await writeFile(script, `const fs=require('node:fs');const p=JSON.parse(fs.readFileSync(0,'utf8'));fs.appendFileSync(${JSON.stringify(calls)},p.session_id+':'+p.source+'\\n');fs.writeFileSync(${JSON.stringify(f.directory)}+'/started-'+p.session_id,'started');const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)}))clearInterval(timer)},10)`)
  await f.add('codex', { SessionStart: [{ hooks: [{ type: 'command', command: [process.execPath, script].map(quote).join(' '), timeout: 5 }] }] })
  const runtime = await connect(t, f, { sessionStart: { admit: async () => {} } })
  const first = runtime.start(event(f.directory))
  await waitFor(join(f.directory, 'started-session'))
  const resumed = { ...event(f.directory, 'session', 'resume'), data: { ...event(f.directory).data, source: 'resume' } }
  await assert.rejects(runtime.start(resumed), { code: 'HOST_SESSION_START_OVERLAP_UNVERIFIED' })
  const other = runtime.start(event(f.directory, 'other'))
  await waitFor(join(f.directory, 'started-other'))
  assert.deepEqual((await readFile(calls, 'utf8')).trim().split('\n').sort(), ['other:startup', 'session:startup'])
  await writeFile(release, 'go')
  await Promise.all([first, other])
  await runtime.start(resumed)
  assert.equal((await readFile(calls, 'utf8')).trim().split('\n').at(-1), 'session:resume')
})

test('nonexecuting native handlers preserve their dispositions without unrelated payloads or services', async t => {
  const f = await fixture(t)
  const calls = join(f.directory, 'calls')
  await f.add('claude-code', { SessionStart: [{ hooks: [{ type: 'http', url: 'http://127.0.0.1:1' }, { type: 'prompt', prompt: 'Skipped' }, { type: 'mcp_tool', server: 'unused', tool: 'unused' }, { type: 'command', command: 'exit 99', if: 'Bash(*)' }] }] })
  await f.add('codex', { SessionStart: [{ hooks: [{ type: 'agent' }, { type: 'command', command: 'printf ran > ' + quote(calls) }] }] })
  const runtime = await connect(t, f, { sessionStart: { admit: async delivery => { assert.deepEqual(delivery.dispatch.entries.map(entry => entry.result.status), ['skipped', 'failed', 'failed', 'skipped', 'skipped', 'success']); assert.equal(delivery.dispatch.entries[3]?.result.code, 'NATIVE_CONDITION_EVENT') } } })
  const receipt = await runtime.start({ ...event(f.directory), data: { source: 'startup', model: 'fixture' } })
  assert.equal(receipt.handlers, 6)
  assert.equal(await readFile(calls, 'utf8'), 'ran')
})

test('a source without startup registrations needs no lifecycle barrier from an unused service', async t => {
  const f = await fixture(t)
  const calls = join(f.directory, 'calls')
  await f.add('codex', { PreToolUse: [{ hooks: [{ type: 'command', command: 'printf ran > ' + quote(calls) }] }] })
  const runtime = await connect(t, f, { sessionStart: { admit: async () => { assert.fail('Unused service was activated') } } })
  runtime.sessions.prompt('session', 'turn', 'fixture')
  await runtime.tools.dispatch({ host: 'v1', event: 'PreToolUse', sessionID: 'session', callID: 'call', tool: 'bash', toolInput: { command: 'original' }, effectiveInput: { command: 'original' }, signal: runtime.sessions.get('session').turnSignal })
  assert.equal(await readFile(calls, 'utf8'), 'ran')
  assert.equal(await runtime.waitForStart('session'), undefined)
  assert.equal(runtime.inspect().sessionStarts, undefined)
})

test('missing environment and handler capabilities cannot admit a partial startup', async t => {
  const f = await fixture(t)
  const calls = join(f.directory, 'unwanted')
  await f.add('claude-code', { SessionStart: [{ hooks: [{ type: 'command', command: 'printf ran > ' + quote(calls) }] }] })
  const runtime = await connect(t, f, { sessionStart: { admit: async () => { assert.fail('Missing environment interface reached admission') } } })
  await assert.rejects(runtime.start(event(f.directory)), { code: 'HOST_ENVIRONMENT_FILE_UNAVAILABLE' })
  await assert.rejects(readFile(calls), { code: 'ENOENT' })
  const unsupported = await fixture(t)
  await unsupported.add('claude-code', { SessionStart: [{ hooks: [{ type: 'mcp_tool', server: 'missing', tool: 'missing' }] }] })
  const diagnostics: { dispatchID?: string }[] = [], dispatches: { dispatchID: string }[] = []
  const second = await connect(t, unsupported, { dispatchDiagnostic: value => { dispatches.push(value) }, sessionStart: { diagnostic: value => { diagnostics.push(value) }, admit: async () => { assert.fail('Unsupported handler reached admission') } } })
  await assert.rejects(second.start({ ...event(unsupported.directory), data: { ...event(unsupported.directory).data, source: 'compact' } }), { code: 'HOST_SESSION_START_HANDLER_UNAVAILABLE' })
  assert.equal(diagnostics[0]?.dispatchID, dispatches[0]?.dispatchID)
})

test('missing startup barriers produce correlated diagnostics without allocating session state', async t => {
  const f = await fixture(t)
  await f.add('codex', { SessionStart: [{ hooks: [{ type: 'command', command: ':' }] }] })
  const diagnostics: { phase: string; code: string; sessionID?: string }[] = []
  const runtime = await connect(t, f, { sessionStart: { diagnostic: value => { diagnostics.push(value) }, admit: async () => {} } })
  await assert.rejects(runtime.waitForStart('missing'), { code: 'HOST_SESSION_START_REQUIRED' })
  assert.throws(() => runtime.observeModel({ host: 'v1', sessionID: 'missing', messageID: 'turn', signal: new AbortController().signal }), { code: 'HOST_SESSION_START_REQUIRED' })
  assert.deepEqual(diagnostics.map(value => [value.phase, value.code, value.sessionID]), [['barrier', 'HOST_SESSION_START_REQUIRED', 'missing'], ['barrier', 'HOST_SESSION_START_REQUIRED', 'missing']])
  assert.equal(runtime.sessions.inspect().retained, 0)
})

test('invalid frames execute nothing and metadata preflight failures can be retried safely', async t => {
  const f = await fixture(t)
  const calls = join(f.directory, 'calls')
  await f.add('codex', { SessionStart: [{ hooks: [{ type: 'command', command: 'printf called > ' + quote(calls) }] }] })
  const runtime = await connect(t, f, { sessionStart: { diagnostic: () => {}, admit: async () => {} } })
  const valid = event(f.directory)
  for (const invalid of [{ ...valid, sessionID: '' }, { ...valid, activationID: '' }, { ...valid, cwd: 'relative' }, { ...valid, event: 'Stop' }]) {
    await assert.rejects(runtime.start(invalid as SessionStartEvent), { code: 'HOST_SESSION_START_INPUT_INVALID' })
  }
  await assert.rejects(runtime.start({ ...valid, host: 'v2' }), { code: 'HOST_VERSION_MISMATCH' })
  await assert.rejects(runtime.start({ ...valid, data: { source: 'startup', model: NaN } }), { code: 'HOST_SESSION_START_INPUT_INVALID' })
  await assert.rejects(runtime.start({ ...valid, data: { ...valid.data, extra: 'x'.repeat(9 * 1024 * 1024) } }), { code: 'HOST_SESSION_START_INPUT_LIMIT' })
  await assert.rejects(runtime.start({ ...valid, data: { source: 'startup' } }), { code: 'HOST_NATIVE_METADATA_UNAVAILABLE' })
  assert.equal(runtime.inspect().sessionStarts?.retained, 0)
  assert.equal(runtime.sessions.inspect().retained, 0)
  await assert.rejects(readFile(calls), { code: 'ENOENT' })
  await runtime.start(valid)
  assert.equal(await readFile(calls, 'utf8'), 'called')
  await runtime.dispose()
  await assert.rejects(runtime.start(valid), { code: 'HOST_SESSION_START_DISPOSED', outcome: 'cancelled' })
})

test('invalid startup service limits are rejected before activation', async t => {
  const f = await fixture(t)
  await f.add('codex', { SessionStart: [{ hooks: [{ type: 'command', command: ':' }] }] })
  for (const limits of [{ maxActivations: 0 }, { maxActivations: Infinity }, { serviceTimeoutMs: 0 }, { serviceTimeoutMs: NaN }]) {
    await assert.rejects(createRuntime('v1', f.directory, f.options, { ...quiet, sessionStart: { ...limits, admit: async () => {} } }), { code: 'HOST_SESSION_START_OPTIONS_INVALID' })
  }
})

test('admission deadlines are bounded and observer failures cannot change completed native execution', async t => {
  const f = await fixture(t)
  const calls = join(f.directory, 'calls')
  await f.add('codex', { SessionStart: [{ hooks: [{ type: 'command', command: "printf 'called\\n' >> " + quote(calls) }] }] })
  const runtime = await connect(t, f, { sessionStart: { serviceTimeoutMs: 20, admit: async delivery => new Promise<void>(resolve => delivery.signal.addEventListener('abort', () => resolve(), { once: true })) } })
  await assert.rejects(runtime.start(event(f.directory)), { code: 'HOST_SESSION_START_ADMISSION_TIMEOUT' })
  await assert.rejects(runtime.start(event(f.directory)), { code: 'HOST_SESSION_START_ADMISSION_TIMEOUT' })
  assert.equal(await readFile(calls, 'utf8'), 'called\n')
  const reporting = await connect(t, f, { dispatchDiagnostic: () => { throw new Error('PRIVATE_OBSERVER') }, sessionStart: { diagnostic: async () => { throw new Error('PRIVATE_OBSERVER') }, admit: async () => {} } })
  await reporting.start(event(f.directory))
  assert.equal(reporting.inspect().observerFailures, 1)
  assert.equal(reporting.inspect().sessionStarts?.observerFailures, 1)
  assert.equal(await readFile(calls, 'utf8'), 'called\ncalled\n')
})

test('startup outlives a replaced user turn while prompt waiters cancel independently', async t => {
  const f = await fixture(t)
  const started = join(f.directory, 'started'), release = join(f.directory, 'release'), finished = join(f.directory, 'finished'), prompt = join(f.directory, 'prompt')
  const script = join(f.directory, 'wait.cjs')
  await writeFile(script, `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(started)},'started');const timer=setInterval(()=>{if(!fs.existsSync(${JSON.stringify(release)}))return;clearInterval(timer);fs.writeFileSync(${JSON.stringify(finished)},'finished')},10)`)
  await f.add('codex', { SessionStart: [{ hooks: [{ type: 'command', command: [process.execPath, script].map(quote).join(' '), timeout: 5 }] }], UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'printf prompted >> ' + quote(prompt) }] }] })
  const runtime = await connect(t, f, { sessionStart: { admit: async () => {} } })
  runtime.sessions.prompt('session', 'first', 'fixture')
  const original = runtime.sessions.get('session')
  const starting = runtime.start(event(f.directory))
  await waitFor(started)
  const waiting = runtime.prompt({ host: 'v1', event: 'UserPromptSubmit', sessionID: 'session', messageID: 'first', prompt: 'First', signal: original.turnSignal })
  await assert.rejects(readFile(prompt), { code: 'ENOENT' })
  runtime.sessions.prompt('session', 'second', 'fixture')
  await assert.rejects(waiting, { code: 'HOST_PROMPT_CANCELLED', outcome: 'cancelled' })
  assert.equal(original.turnSignal.aborted, true)
  assert.equal(original.signal.aborted, false)
  await writeFile(release, 'go')
  await starting
  assert.equal(await readFile(finished, 'utf8'), 'finished')
  await runtime.prompt({ host: 'v1', event: 'UserPromptSubmit', sessionID: 'session', messageID: 'second', prompt: 'Second', signal: runtime.sessions.get('session').turnSignal })
  assert.equal(await readFile(prompt, 'utf8'), 'prompted')
})

test('session closure cancels a running startup and prevents late admission', async t => {
  const f = await fixture(t)
  const started = join(f.directory, 'started'), admitted = join(f.directory, 'admitted')
  const script = join(f.directory, 'wait.cjs')
  await writeFile(script, `require('node:fs').writeFileSync(${JSON.stringify(started)},'started');setInterval(()=>{},1000)`)
  await f.add('codex', { SessionStart: [{ hooks: [{ type: 'command', command: [process.execPath, script].map(quote).join(' '), timeout: 5 }] }] })
  const runtime = await connect(t, f, { sessionStart: { admit: async () => { await writeFile(admitted, 'unwanted') } } })
  const starting = runtime.start(event(f.directory))
  await waitFor(started)
  runtime.sessions.close('session')
  await assert.rejects(starting, { code: 'HOST_SESSION_START_CANCELLED', outcome: 'cancelled' })
  await assert.rejects(readFile(admitted), { code: 'ENOENT' })
  assert.equal(runtime.inspect().sessionStarts?.active, 0)
})

test('a cooperative startup admission is cancelled and drained when the runtime is disposed', async t => {
  const f = await fixture(t)
  const entered = join(f.directory, 'entered')
  await f.add('codex', { SessionStart: [{ hooks: [{ type: 'command', command: ':' }] }] })
  let signal: AbortSignal | undefined
  const runtime = await connect(t, f, { sessionStart: { admit: async delivery => {
    signal = delivery.signal
    await writeFile(entered, 'entered')
    await new Promise<void>(resolve => {
      if (delivery.signal.aborted) resolve()
      else delivery.signal.addEventListener('abort', () => resolve(), { once: true })
    })
  } } })
  const starting = runtime.start(event(f.directory))
  void starting.catch(() => {})
  await waitFor(entered)
  await runtime.dispose()
  await assert.rejects(starting, { code: 'HOST_SESSION_START_CANCELLED' })
  assert.equal(signal?.aborted, true)
  assert.equal(runtime.inspect().sessionStarts?.active, 0)
  assert.equal(runtime.inspect().sessionStarts?.retained, 0)
})

test('an uncooperative startup admission reports failed drain and permits cleanup retry', async t => {
  const f = await fixture(t)
  await f.add('codex', { SessionStart: [{ hooks: [{ type: 'command', command: ':' }] }] })
  const entered = deferred(), release = deferred()
  t.after(() => release.resolve())
  const diagnostics: SessionStartDiagnostic[] = []
  let signal: AbortSignal | undefined
  const runtime = await connect(t, f, { sessionStart: { serviceTimeoutMs: 100, diagnostic: value => { diagnostics.push(value) }, admit: async delivery => {
    signal = delivery.signal
    entered.resolve()
    await release.promise
  } } })
  const starting = runtime.start(event(f.directory))
  void starting.catch(() => {})
  await entered.promise
  await assert.rejects(runtime.dispose(), { code: 'HOST_SESSION_START_ADMISSION_DRAIN_FAILED' })
  await assert.rejects(starting, { code: 'HOST_SESSION_START_CANCELLED' })
  assert.equal(signal!.aborted, true)
  assert.equal(runtime.inspect().sessionStarts!.admissions, 1)
  assert.equal(diagnostics.at(-1)!.phase, 'drain')
  release.resolve()
  await runtime.dispose()
  assert.equal(runtime.inspect().sessionStarts!.admissions, 0)
  assert.equal(runtime.inspect().sessionStarts!.retained, 0)
})

test('an undrained startup admission retains overlap protection after timeout', async t => {
  const f = await fixture(t)
  const calls = join(f.directory, 'calls')
  await f.add('codex', { SessionStart: [{ hooks: [{ type: 'command', command: "printf 'called\\n' >> " + quote(calls) }] }] })
  const release = deferred()
  t.after(() => release.resolve())
  let first = true
  const runtime = await connect(t, f, { sessionStart: { serviceTimeoutMs: 20, admit: async () => {
    if (!first) return
    first = false
    await release.promise
  } } })
  await assert.rejects(runtime.start(event(f.directory)), { code: 'HOST_SESSION_START_ADMISSION_TIMEOUT' })
  const resume = { ...event(f.directory, 'session', 'resume'), data: { ...event(f.directory).data, source: 'resume' } }
  await assert.rejects(runtime.start(resume), { code: 'HOST_SESSION_START_OVERLAP_UNVERIFIED' })
  assert.equal(await readFile(calls, 'utf8'), 'called\n')
  release.resolve()
  await new Promise<void>(resolve => setImmediate(resolve))
  await runtime.start(resume)
  assert.equal(await readFile(calls, 'utf8'), 'called\ncalled\n')
})

for (const host of ['v1', 'v2'] as const) test(`default host factory ${host === 'v1' ? 'accepts explicit' : 'rejects unwired'} startup services (${host})`, async t => {
  const { createHarnessHooks, setupHarnessHooks } = await import('../src/plugin.js')
  const f = await fixture(t)
  await f.add('codex', { SessionStart: [{ hooks: [{ type: 'command', command: ':' }] }] })
  const services: RuntimeServices = { ...quiet, sessionStart: { admit: async () => {} } }
  if (host === 'v1') {
    const hooks = await createHarnessHooks({ directory: f.directory }, f.options, services)
    assert.equal(hooks.inspect().runtime.sessionStarts?.retained, 0)
    await hooks.dispose()
  } else {
    const hook = async () => ({ dispose: () => {} })
    await assert.rejects(async () => { const dispose = await setupHarnessHooks({ location: { directory: f.directory }, options: f.options, session: { hook }, tool: { hook } }, services); await dispose() }, { code: 'HOST_SESSION_START_HOST_UNAVAILABLE' })
  }
})
