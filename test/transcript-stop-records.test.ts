import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { ClaudeTranscript } from '../src/transcript.js'
import { createRuntime } from '../src/runtime.js'
import type { StopDelivery, StopEvent } from '../src/stop.js'
import { StopRecords } from '../src/stop-records.js'
import { Sessions } from '../src/sessions.js'

const CREATED = Date.parse('2026-01-01T00:00:00Z')
const oracle = JSON.parse(readFileSync(new URL('./fixtures/claude-stop-aggregation-oracle.json', import.meta.url), 'utf8'))
const outputs = JSON.parse(readFileSync(new URL('./fixtures/claude-stop-output-oracle.json', import.meta.url), 'utf8'))
const parse = (text: string) => text.trim().split('\n').map(line => JSON.parse(line))

interface OutputInput { readonly stdout: string; readonly stderr: string; readonly exitCode: number; readonly delayMs: number; readonly timeoutSeconds?: number }
async function fixture(t: TestContext, scenario: { outputs: unknown[]; completionOrder: number[] } | { input: OutputInput }, admitRecords = false) {
  const directory = await mkdtemp(join(tmpdir(), 'harness-stop-records-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const script = join(directory, 'hook.cjs')
  const body = 'input' in scenario ? `require('node:fs').readFileSync(0,'utf8');setTimeout(()=>{process.stdout.write(${JSON.stringify(scenario.input.stdout)});process.stderr.write(${JSON.stringify(scenario.input.stderr)});process.exitCode=${scenario.input.exitCode}},${scenario.input.delayMs})` : `const index=Number(process.argv[2]);const outputs=${JSON.stringify(scenario.outputs)};const order=${JSON.stringify(scenario.completionOrder)};setTimeout(()=>console.log(JSON.stringify(outputs[index])),order.indexOf(index)?350:25)`
  await writeFile(script, body)
  const indices = 'input' in scenario ? [0] : scenario.outputs.map((_, index) => index)
  const commands = indices.map(index => [process.execPath, script, String(index)].join(' '))
  const path = join(directory, 'hooks.json')
  const source = JSON.stringify({ hooks: { Stop: [{ hooks: indices.map(index => ({ type: 'command', command: process.execPath, args: [script, String(index)], ...('input' in scenario && scenario.input.timeoutSeconds !== undefined ? { timeout: scenario.input.timeoutSeconds } : {}) })) }] } })
  await writeFile(path, source)
  const records: unknown[] = [
    { type: 'user', id: 'prompt', text: 'Original', time: { created: CREATED } },
    { type: 'assistant', id: 'answer', model: { id: 'fixture' }, finish: 'stop', time: { created: CREATED + 1 }, content: [{ type: 'text', text: 'Answer' }] },
  ]
  const transcripts = new ClaudeTranscript({ host: 'v2', directory, history: async () => ({ id: 'session', messages: records }) })
  let delivery!: StopDelivery
  let modelProjection: readonly string[] | undefined
  const runtime = await createRuntime('v2', directory, { sources: [{ id: 'claude', dialect: 'claude-code', path }], reviewedDigests: { claude: createHash('sha256').update(source).digest('hex') }, permissionMode: 'default' }, {
    transcripts, report: () => {}, dispatchDiagnostic: () => {}, host: { environment: { PATH: process.env.PATH, HOME: directory, SHELL: '/bin/sh' } },
    stop: { diagnostic: () => {}, admit: async value => { delivery = value; if (admitRecords) modelProjection = transcripts.admitStop(value) } },
  })
  t.after(() => runtime.dispose())
  runtime.sessions.prompt('session', 'prompt', 'fixture')
  const session = runtime.sessions.get('session')
  runtime.observeModel({ host: 'v2', sessionID: 'session', messageID: 'prompt', signal: session.turnSignal })
  const event: StopEvent = { host: 'v2', event: 'Stop', cwd: directory, sessionID: 'session', messageID: 'prompt', completionID: 'answer' }
  const transcriptPath = await transcripts.prepare(event, session, session.turnSignal)
  const receipt = await runtime.stop({ ...event, data: { transcript_path: transcriptPath, last_assistant_message: 'Answer', background_tasks: [], session_crons: [] } })
  return { directory, transcripts, runtime, session, event, delivery, receipt, records, transcriptPath, commands, modelProjection, unchanged: async () => { assert.equal(await readFile(script, 'utf8'), body); assert.equal(await readFile(path, 'utf8'), source) } }
}

for (const scenario of oracle.cases) test(`Claude Stop transcript retains native ${scenario.name} records`, async t => {
  const f = await fixture(t, scenario, true)
  assert.equal(f.receipt.control, scenario.preventedContinuation ? 'stop' : 'continue')
  await f.transcripts.prepare(f.event, f.session, f.session.turnSignal)
  const rows = parse(await readFile(f.transcriptPath, 'utf8'))
  const answer = rows.findIndex(row => row.type === 'assistant')
  const stopRows = rows.slice(answer + 1)
  const summary = stopRows.at(-1)
  const order = stopRows.slice(0, -1).map(row => {
    const attachment = row.attachment
    if (row.type === 'user') {
      assert.equal(row.isMeta, true)
      assert.equal(row.promptId, 'prompt')
      return ['feedback', ['Stop hook feedback:\nNATIVE_STOP_A', 'Stop hook feedback:\nNATIVE_STOP_B'].indexOf(row.message.content)]
    }
    assert.equal(row.type, 'attachment')
    const command = attachment.command ?? attachment.blockingError?.command
    const handler = command !== undefined ? f.commands.indexOf(command) : attachment.type === 'hook_stopped_continuation' ? ['NATIVE_STOP_A', 'NATIVE_STOP_B'].indexOf(attachment.message) : ['NATIVE_STOP_A', 'NATIVE_STOP_B'].indexOf(attachment.content[0])
    assert.equal(attachment.toolUseID, summary.toolUseID)
    assert.equal(attachment.hookEvent, 'Stop')
    assert.equal(attachment.hookName, 'Stop')
    if (attachment.type === 'hook_success') {
      assert.equal(attachment.stdout, JSON.stringify(scenario.outputs[handler]) + '\n')
      assert.equal(attachment.stderr, '')
      assert.equal(attachment.exitCode, 0)
      assert.equal(attachment.content, '')
      assert.ok(attachment.durationMs >= 0)
      assert.equal(Object.hasOwn(row, 'rendered'), false)
    } else {
      const reason = ['NATIVE_STOP_A', 'NATIVE_STOP_B'][handler]
      const rendered = attachment.type === 'hook_blocking_error' ? `Stop hook blocking error from command: "${f.commands[handler]}": ${reason}` : attachment.type === 'hook_stopped_continuation' ? `Stop hook stopped continuation: ${reason}` : `Stop hook additional context: ${reason}`
      assert.deepEqual(row.rendered, [{ content: `<system-reminder>\n${rendered}\n</system-reminder>` }])
      assert.equal(row.renderedRole, 'system')
      if (attachment.type === 'hook_blocking_error') assert.deepEqual(attachment.blockingError, { blockingError: reason, command: f.commands[handler] })
      if (attachment.type === 'hook_additional_context') assert.deepEqual(attachment.content, [reason])
    }
    return [attachment.type, handler]
  })
  assert.deepEqual(order, scenario.recordOrder)
  assert.equal(summary.type, 'system')
  assert.equal(summary.subtype, 'stop_hook_summary')
  assert.equal(summary.hookCount, 2)
  assert.equal(summary.level, 'suggestion')
  assert.deepEqual(summary.hookInfos.map((row: { command: string }) => row.command), f.commands)
  assert.deepEqual(summary.hookInfos.map((row: object) => Object.hasOwn(row, 'durationMs')), scenario.hookInfoDuration)
  assert.deepEqual(summary.hookErrors, scenario.hookErrors)
  assert.deepEqual(summary.hookAdditionalContext, scenario.hookAdditionalContext)
  assert.equal(summary.preventedContinuation, scenario.preventedContinuation)
  assert.equal(summary.stopReason, scenario.stopReason)
  assert.equal(summary.hasOutput, true)
  for (let index = 1; index < rows.length; index++) assert.equal(rows[index].parentUuid, rows[index - 1].uuid)
  const bytes = await readFile(f.transcriptPath, 'utf8')
  await f.transcripts.prepare(f.event, f.session, f.session.turnSignal)
  assert.equal(await readFile(f.transcriptPath, 'utf8'), bytes)
  await f.unchanged()
})

test('Stop record admission rejects unavailable snapshots and incomplete artifacts without a partial commit', async t => {
  const f = await fixture(t, oracle.cases[0])
  const foreign = new ClaudeTranscript({ host: 'v2', directory: f.directory, history: async () => ({ id: 'session', messages: f.records }) })
  t.after(() => foreign.dispose())
  assert.throws(() => foreign.admitStop(f.delivery), { code: 'TRANSCRIPT_STOP_SNAPSHOT_UNAVAILABLE' })
  assert.equal(foreign.inspect().stopRecords, 0)
  const v1 = new ClaudeTranscript({ host: 'v1', directory: f.directory, history: async () => { assert.fail('V1 Stop read history') } })
  t.after(() => v1.dispose())
  assert.throws(() => v1.admitStop({ ...f.delivery, event: { ...f.delivery.event, host: 'v1' } }), { code: 'TRANSCRIPT_STOP_HOST_UNSUPPORTED' })
  assert.throws(() => f.transcripts.admitStop({ ...f.delivery, event: { ...f.delivery.event, cwd: '/foreign' } }), { code: 'TRANSCRIPT_STOP_CWD_UNAVAILABLE' })
  await assert.rejects(f.transcripts.prepare(f.event, { ...f.session, signal: new AbortController().signal }, f.session.turnSignal), { code: 'TRANSCRIPT_SESSION_MISMATCH' })
  const before = f.transcripts.inspect()
  const missing = { ...f.delivery, dispatch: { ...f.delivery.dispatch, entries: f.delivery.dispatch.entries.map((entry, index) => index ? { ...entry, result: { status: 'success' as const, code: 'OK', actions: entry.result.actions, diagnostic: { ...entry.result.diagnostic, outcome: 'success' as const } } } : entry) } }
  assert.throws(() => f.transcripts.admitStop(missing), { code: 'TRANSCRIPT_HOOK_EXECUTION_UNAVAILABLE' })
  assert.equal(f.transcripts.inspect().stopRecords, 0)
  assert.equal(f.transcripts.inspect().stopBytes, before.stopBytes)
  assert.throws(() => f.transcripts.admitStop({ ...f.delivery, dispatch: { ...f.delivery.dispatch, diagnostic: { ...f.delivery.dispatch.diagnostic, event: 'PreToolUse' } } }), { code: 'TRANSCRIPT_DISPATCH_MISMATCH' })
  const cancelled = new AbortController()
  cancelled.abort()
  assert.throws(() => f.transcripts.admitStop({ ...f.delivery, signal: cancelled.signal }), { code: 'TRANSCRIPT_CANCELLED', outcome: 'cancelled' })
  f.transcripts.admitStop(f.delivery)
  assert.throws(() => f.transcripts.admitStop(f.delivery), { code: 'TRANSCRIPT_STOP_ID_REUSED' })
  assert.ok(f.transcripts.inspect().stopRecords > 0)
  assert.ok(!JSON.stringify(f.transcripts.inspect()).includes('NATIVE_STOP_A'))
  f.runtime.sessions.close('session')
  assert.equal(f.transcripts.inspect().stopSessions, 0)
  assert.equal(f.transcripts.inspect().stopCompletions, 0)
  assert.equal(f.transcripts.inspect().stopRecords, 0)
  assert.equal(f.transcripts.inspect().stopBytes, 0)
})

test('admitted Stop records survive a real next turn and changed or pruned history cannot erase them', async t => {
  const f = await fixture(t, oracle.cases[1])
  f.transcripts.admitStop(f.delivery)
  f.runtime.sessions.prompt('session', 'next', 'fixture')
  assert.throws(() => f.transcripts.admitStop(f.delivery), { code: 'TRANSCRIPT_CANCELLED' })
  const session = f.runtime.sessions.get('session')
  f.runtime.observeModel({ host: 'v2', sessionID: 'session', messageID: 'next', signal: session.turnSignal })
  f.records.push({ type: 'user', id: 'next', text: 'Next', time: { created: CREATED + 2 } }, { type: 'assistant', id: 'next-answer', model: { id: 'fixture' }, finish: 'stop', time: { created: CREATED + 3 }, content: [{ type: 'text', text: 'Next answer' }] })
  const event = { ...f.event, messageID: 'next', completionID: 'next-answer' }
  await f.transcripts.prepare(event, session, session.turnSignal)
  const before = await readFile(f.transcriptPath, 'utf8')
  const rows = parse(before)
  const summary = rows.findIndex(row => row.subtype === 'stop_hook_summary')
  assert.ok(summary > rows.findIndex(row => row.message?.id === 'answer'))
  assert.ok(summary < rows.findIndex(row => row.type === 'user' && row.message.content === 'Next'))
  const answer = f.records[1] as { content: unknown[] }
  answer.content = [{ type: 'text', text: 'Changed answer' }]
  await assert.rejects(f.transcripts.prepare(event, session, session.turnSignal), { code: 'TRANSCRIPT_STOP_HISTORY_CHANGED' })
  assert.equal(await readFile(f.transcriptPath, 'utf8'), before)
  f.records.splice(1, 1)
  await assert.rejects(f.transcripts.prepare(event, session, session.turnSignal), { code: 'TRANSCRIPT_STOP_HISTORY_UNAVAILABLE' })
  assert.equal(await readFile(f.transcriptPath, 'utf8'), before)
})

test('unverified Stop output artifacts reject explicitly without erasing a prepared snapshot', async t => {
  const f = await fixture(t, { outputs: [{ terminalSequence: '\x07' }], completionOrder: [0] })
  const before = await readFile(f.transcriptPath, 'utf8')
  assert.throws(() => f.transcripts.admitStop(f.delivery), { code: 'TRANSCRIPT_STOP_EFFECT_UNSUPPORTED' })
  assert.equal(f.transcripts.inspect().stopRecords, 0)
  assert.equal(f.transcripts.inspect().stopCompletions, 1)
  assert.equal(await readFile(f.transcriptPath, 'utf8'), before)
  await f.runtime.dispose()
  assert.equal(f.transcripts.inspect().stopBytes, 0)
})

for (const scenario of outputs.cases) test(`Claude Stop output records agree with native ${scenario.name}`, async t => {
  const f = await fixture(t, scenario, true)
  assert.equal(f.receipt.control, scenario.records.at(-1).preventedContinuation ? 'stop' : scenario.modelRequests > 1 ? 'continue' : 'complete')
  await f.transcripts.prepare(f.event, f.session, f.session.turnSignal)
  const rows = parse(await readFile(f.transcriptPath, 'utf8'))
  const owned = rows.slice(rows.findIndex(row => row.type === 'assistant') + 1)
  const batch = owned.at(-1).toolUseID
  const normalize = (value: unknown, key = ''): unknown => {
    if (key === 'durationMs') { assert.ok(typeof value === 'number' && Number.isFinite(value) && value >= 0); return '{duration}' }
    if (key === 'toolUseID') { assert.equal(value, batch); return '{batch}' }
    if (key === 'promptId') { assert.equal(value, 'prompt'); return '{turn}' }
    if (typeof value === 'string') return value.replaceAll(f.commands[0]!, '{command}')
    if (Array.isArray(value)) return value.map(item => normalize(item))
    if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, value]) => [key, normalize(value, key)]))
    return value
  }
  const bodies = owned.map(row => Object.fromEntries(Object.entries(row).filter(([key]) => !['parentUuid', 'isSidechain', 'uuid', 'timestamp', 'cwd', 'sessionId', 'version'].includes(key))))
  assert.deepEqual(normalize(bodies), scenario.records)
  if (scenario.modelRequests > 1) assert.deepEqual(f.modelProjection?.map(text => ({ role: 'user', text: normalize(text) })), scenario.model)
  assert.ok(rows.every(row => row.sessionId === 'session' && row.cwd === f.directory && row.version === '2.1.318' && row.isSidechain === false && Number.isFinite(Date.parse(row.timestamp))))
  for (let index = 1; index < rows.length; index++) assert.equal(rows[index].parentUuid, rows[index - 1].uuid)
  await f.unchanged()
})

test('admitted Stop model input keeps suppressed reminders and feedback for later history', async t => {
  const f = await fixture(t, { outputs: [{ continue: false, stopReason: 'Stopped', decision: 'block', reason: 'Feedback', hookSpecificOutput: { hookEventName: 'Stop', additionalContext: 'Context' } }], completionOrder: [0] }, true)
  assert.equal(f.receipt.control, 'stop')
  assert.deepEqual(f.modelProjection, [
    '<system-reminder>\nStop hook stopped continuation: Stopped\n</system-reminder>',
    `<system-reminder>\nStop hook blocking error from command: "${f.commands[0]}": Feedback\n</system-reminder>`,
    '<system-reminder>\nStop hook additional context: Context\n</system-reminder>\n',
    'Stop hook feedback:\nFeedback',
  ])
  assert.ok(Object.isFrozen(f.modelProjection))
})

test('competing Stop model input follows native reminder and feedback group order', async t => {
  const f = await fixture(t, oracle.cases.find((row: { name: string }) => row.name === 'two-blocks'), true)
  assert.deepEqual(f.modelProjection, [
    `<system-reminder>\nStop hook blocking error from command: "${f.commands[1]}": NATIVE_STOP_B\n</system-reminder>`,
    `<system-reminder>\nStop hook blocking error from command: "${f.commands[0]}": NATIVE_STOP_A\n</system-reminder>\n`,
    'Stop hook feedback:\nNATIVE_STOP_B\n',
    'Stop hook feedback:\nNATIVE_STOP_A',
  ])
})

test('identical decision and additional-context text retains both native record forms', async t => {
  const f = await fixture(t, { outputs: [{ decision: 'block', reason: 'Same', hookSpecificOutput: { hookEventName: 'Stop', additionalContext: 'Same' } }], completionOrder: [0] }, true)
  await f.transcripts.prepare(f.event, f.session, f.session.turnSignal)
  const rows = parse(await readFile(f.transcriptPath, 'utf8'))
  const owned = rows.slice(rows.findIndex(row => row.type === 'assistant') + 1)
  assert.deepEqual(owned.map(row => row.attachment?.type ?? row.subtype ?? row.type), ['user', 'hook_blocking_error', 'hook_additional_context', 'stop_hook_summary'])
  assert.equal(owned[0].message.content, 'Stop hook feedback:\nSame')
  assert.equal(owned[1].attachment.blockingError.blockingError, 'Same')
  assert.deepEqual(owned[2].attachment.content, ['Same'])
  assert.deepEqual(owned[3].hookErrors, ['Same'])
  assert.deepEqual(owned[3].hookAdditionalContext, ['Same'])
})

test('unimplemented asynchronous and malformed-syntax artifacts cannot become successful Stop receipts', async t => {
  for (const stdout of ['{"async":true,"decision":"block","reason":"Ignored"}\n', '{bad}\n']) {
    await assert.rejects(fixture(t, { input: { stdout, stderr: '', exitCode: 0, delayMs: 0 } }, true), { code: 'TRANSCRIPT_STOP_OUTPUT_UNSUPPORTED' })
  }
})

test('unadmitted completion snapshots have a finite shared budget and session closure releases it', () => {
  const sessions = new Sessions()
  sessions.prompt('session', 'prompt')
  const records = new StopRecords()
  const session = sessions.get('session')
  let limited = false
  for (let index = 0; index < 20000; index++) {
    try { records.prepare({ host: 'v2', event: 'Stop', sessionID: 'session', messageID: 'prompt', completionID: 'answer-' + index, cwd: '/project' }, session, 'fingerprint') } catch (error) {
      assert.equal((error as { code: string }).code, 'TRANSCRIPT_STOP_LIMIT')
      limited = true
      break
    }
  }
  assert.equal(limited, true)
  assert.ok(records.inspect().stopBytes > 0)
  sessions.close('session')
  assert.equal(records.inspect().stopCompletions, 0)
  assert.equal(records.inspect().stopBytes, 0)
  records.dispose()
})
