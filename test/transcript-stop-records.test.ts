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
const FAST_COMPLETION_MS = 25
const SLOW_COMPLETION_MS = 350
const READY_LIMIT_MS = 5000
const READY_POLL_MS = 10
const oracle = JSON.parse(readFileSync(new URL('./fixtures/claude-stop-aggregation-oracle.json', import.meta.url), 'utf8'))
const outputs = JSON.parse(readFileSync(new URL('./fixtures/claude-stop-output-oracle.json', import.meta.url), 'utf8'))
const parse = (text: string) => text.trim().split('\n').map(line => JSON.parse(line))
const synthetic = () => ({ type: 'synthetic', id: 'synthetic', text: 'Owned transport marker', metadata: { source: 'opencode-harness-hooks', completionID: 'answer', token: 'fixture' }, description: 'Hook continuation', time: { created: CREATED + 2 } })
const secondAnswer = () => ({ type: 'assistant', id: 'answer-2', model: { id: 'fixture' }, finish: 'stop', time: { created: CREATED + 3 }, content: [{ type: 'text', text: 'Second answer' }] })

interface OutputInput { readonly stdout: string; readonly stderr: string; readonly exitCode: number; readonly delayMs: number; readonly timeoutSeconds?: number }
async function fixture(t: TestContext, scenario: { outputs: unknown[]; completionOrder: number[]; startupDelays?: number[] } | { input: OutputInput }, admitRecords = false) {
  const directory = await mkdtemp(join(tmpdir(), 'harness-stop-records-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const script = join(directory, 'hook.cjs')
  const body = 'input' in scenario ? `require('node:fs').readFileSync(0,'utf8');setTimeout(()=>{process.stdout.write(${JSON.stringify(scenario.input.stdout)});process.stderr.write(${JSON.stringify(scenario.input.stderr)});process.exitCode=${scenario.input.exitCode}},${scenario.input.delayMs})` : `const index=Number(process.argv[2]);const outputs=${JSON.stringify(scenario.outputs)};const fs=require('node:fs');const order=${JSON.stringify(scenario.completionOrder)};const startup=${JSON.stringify(scenario.startupDelays ?? [])};const started=Date.now();const ready=()=>{if(outputs.every((_,candidate)=>fs.existsSync(process.argv[1]+'.ready.'+candidate)))setTimeout(()=>console.log(JSON.stringify(outputs[index])),order.indexOf(index)?${SLOW_COMPLETION_MS}:${FAST_COMPLETION_MS});else if(Date.now()-started>${READY_LIMIT_MS})process.exit(9);else setTimeout(ready,${READY_POLL_MS})};setTimeout(()=>{fs.writeFileSync(process.argv[1]+'.ready.'+index,'');ready()},startup[index]??0)`
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

test('delayed subprocess startup cannot change the requested aggregation fixture order', async t => {
  const f = await fixture(t, { outputs: [{ continue: false, stopReason: 'First' }, { continue: false, stopReason: 'Second' }], completionOrder: [0, 1], startupDelays: [600, 0] }, true)
  assert.deepEqual([...f.delivery.dispatch.entries].sort((left, right) => left.completionOrder - right.completionOrder).map(row => row.configuredOrder), [0, 1])
})

test('typed Stop model groups require admitted live ownership and preserve suppressed feedback', async t => {
  const scenario = oracle.cases.find((row: any) => row.name === 'block-then-stop')
  const missing = await fixture(t, scenario, false)
  assert.throws(() => missing.transcripts.stopModelInput(missing.delivery), { code: 'TRANSCRIPT_STOP_MODEL_UNAVAILABLE' })
  const f = await fixture(t, scenario, true)
  const blocks = f.transcripts.stopModelInput(f.delivery)
  assert.ok(Object.isFrozen(blocks) && Object.isFrozen(blocks.reminders) && Object.isFrozen(blocks.feedback))
  assert.ok(blocks.reminders.some(text => text.includes('Stop hook stopped continuation:')))
  assert.deepEqual(blocks.feedback, ['Stop hook feedback:\nNATIVE_STOP_A'])
  assert.throws(() => f.transcripts.stopModelInput({ ...f.delivery, event: { ...f.event, completionID: 'foreign' } }), { code: 'TRANSCRIPT_STOP_MODEL_UNAVAILABLE' })
  f.runtime.sessions.prompt('session', 'replacement')
  assert.throws(() => f.transcripts.stopModelInput(f.delivery), { code: 'TRANSCRIPT_CANCELLED' })
})

test('session-owned reconciliation suppresses only exact late cancelled input without changing real-turn history', async t => {
  const f = await fixture(t, oracle.cases[0], true)
  const row = synthetic()
  const lease = f.transcripts.reserveContinuation(f.delivery, { id: row.id, text: row.text, metadata: row.metadata, description: row.description }, { reconcileCancellation: true })
  assert.throws(() => lease.suppress!(row, 'next'), { code: 'TRANSCRIPT_STOP_RECONCILIATION_UNAVAILABLE' })
  f.runtime.sessions.prompt('session', 'next', 'fixture')
  const next = f.runtime.sessions.get('session')
  f.runtime.observeModel({ host: 'v2', sessionID: 'session', messageID: 'next', signal: next.turnSignal })
  for (const changed of [{ ...row, metadata: { ...row.metadata, token: 'foreign' } }, { ...row, id: 'foreign' }, { ...row, unknown: true }]) assert.throws(() => lease.suppress!(changed, 'next'), { code: 'TRANSCRIPT_STOP_CONTINUATION_CHANGED' })
  for (const previousID of ['', row.id, 'bad\0id', 'x'.repeat(4097)]) assert.throws(() => lease.suppress!(row, previousID), { code: 'TRANSCRIPT_STOP_CONTINUATION_POSITION' })
  lease.suppress!(row, 'next')
  lease.release()
  assert.throws(() => lease.suppress!(row, 'next'), { code: 'TRANSCRIPT_STOP_RESERVATION_UNAVAILABLE' })
  f.records.push({ type: 'user', id: 'next', text: 'Next', time: { created: CREATED + 2 } }, row, secondAnswer())
  const event = { ...f.event, messageID: 'next', completionID: 'answer-2' }
  const path = await f.transcripts.prepare(event, next, next.turnSignal)
  const projected = parse(await readFile(path, 'utf8'))
  assert.ok(!JSON.stringify(projected).includes(row.text))
  assert.equal(projected.filter(value => value.type === 'user' && !value.isMeta).length, 2)
  assert.equal(projected.filter(value => value.subtype === 'stop_hook_summary').length, 1)
  assert.equal(projected.at(-1).message.content[0].text, 'Second answer')
  assert.equal(projected.at(-1).parentUuid, projected.find(value => value.type === 'user' && value.message.content === 'Next').uuid)
  f.runtime.sessions.close('session')
  assert.equal(f.transcripts.inspect().stopBytes, 0)
})

test('reconciled cancellation ownership rejects changed, reordered and pruned raw history', async t => {
  for (const change of ['changed', 'moved', 'position', 'pruned', 'duplicate']) {
    const f = await fixture(t, oracle.cases[0], true), row = synthetic()
    const lease = f.transcripts.reserveContinuation(f.delivery, { id: row.id, text: row.text, metadata: row.metadata, description: row.description }, { reconcileCancellation: true })
    f.runtime.sessions.prompt('session', 'next', 'fixture')
    const next = f.runtime.sessions.get('session')
    f.runtime.observeModel({ host: 'v2', sessionID: 'session', messageID: 'next', signal: next.turnSignal })
    lease.suppress!(row, 'next')
    f.records.push({ type: 'user', id: 'next', text: 'Next', time: { created: CREATED + 2 } }, row, secondAnswer())
    if (change === 'changed') row.metadata.token = 'foreign'
    else if (change === 'moved') f.records.unshift(f.records.splice(3, 1)[0]!)
    else if (change === 'position') f.records.splice(2, 0, f.records.splice(3, 1)[0]!)
    else if (change === 'pruned') f.records.splice(3, 1)
    else f.records.push(structuredClone(row))
    const event = { ...f.event, messageID: 'next', completionID: 'answer-2' }
    const previous = await readFile(f.transcriptPath)
    await assert.rejects(f.transcripts.prepare(event, next, next.turnSignal), { code: change === 'changed' ? 'TRANSCRIPT_STOP_CONTINUATION_CHANGED' : ['moved', 'position'].includes(change) ? 'TRANSCRIPT_STOP_CONTINUATION_POSITION' : change === 'duplicate' ? 'TRANSCRIPT_MESSAGE_ID_INVALID' : 'TRANSCRIPT_STOP_HISTORY_UNAVAILABLE' })
    assert.deepEqual(await readFile(f.transcriptPath), previous)
  }
})

test('reconciliation reserves the serialized anchor before accepting native input', async t => {
  const f = await fixture(t, oracle.cases[0], true), row = synthetic(), previousID = '\u0001'.repeat(4096)
  const lease = f.transcripts.reserveContinuation(f.delivery, { id: row.id, text: row.text, metadata: row.metadata, description: row.description }, { reconcileCancellation: true })
  f.runtime.sessions.prompt('session', previousID, 'fixture')
  const next = f.runtime.sessions.get('session')
  f.runtime.observeModel({ host: 'v2', sessionID: 'session', messageID: previousID, signal: next.turnSignal })
  lease.suppress!(row, previousID)
  f.records.push({ type: 'user', id: previousID, text: 'Next', time: { created: CREATED + 2 } }, row, secondAnswer())
  const path = await f.transcripts.prepare({ ...f.event, messageID: previousID, completionID: 'answer-2' }, next, next.turnSignal)
  assert.ok(!await readFile(path, 'utf8').then(text => text.includes(row.text)))
})

test('reconciliation leases still admit active continuations and cannot later erase committed delivery', async t => {
  const f = await fixture(t, oracle.cases[0], true), row = synthetic()
  const lease = f.transcripts.reserveContinuation(f.delivery, { id: row.id, text: row.text, metadata: row.metadata, description: row.description }, { reconcileCancellation: true })
  lease.admit(row)
  lease.release()
  f.records.push(row, secondAnswer())
  const path = await f.transcripts.prepare({ ...f.event, completionID: 'answer-2' }, f.session, f.session.turnSignal)
  const projected = parse(await readFile(path, 'utf8'))
  assert.equal(projected.filter(value => value.type === 'user' && !value.isMeta).length, 1)
  assert.ok(!JSON.stringify(projected).includes(row.text))
  f.runtime.sessions.prompt('session', 'next')
  assert.throws(() => lease.suppress!(row, 'next'), { code: 'TRANSCRIPT_STOP_RESERVATION_UNAVAILABLE' })
})

for (const admitted of [false, true]) test(`SDK interruption preserves the original Stop owner with admitted output ${admitted}`, async t => {
  const f = await fixture(t, { outputs: [{ decision: 'block', reason: 'CANCEL_STOP_FEEDBACK', hookSpecificOutput: { hookEventName: 'Stop', additionalContext: 'CANCEL_STOP_CONTEXT' } }], completionOrder: [0] }, admitted)
  const receipt = { eventID: 'execution-interruption', created: CREATED + 2, reason: 'user' as const, source: 'sdk-cli' as const }
  assert.throws(() => f.transcripts.admitStopInterruption(f.event, f.session, receipt), { code: 'TRANSCRIPT_STOP_INTERRUPTION_UNAVAILABLE' })
  f.runtime.sessions.prompt('session', 'next', 'fixture')
  const next = f.runtime.sessions.get('session')
  const blocks = f.transcripts.admitStopInterruption(f.event, f.session, receipt)
  assert.ok(Object.isFrozen(blocks) && Object.isFrozen(blocks.reminders) && Object.isFrozen(blocks.feedback))
  assert.deepEqual(blocks, { reminders: admitted ? [
    `<system-reminder>\nStop hook blocking error from command: "${f.commands[0]}": CANCEL_STOP_FEEDBACK\n</system-reminder>`,
    '<system-reminder>\nStop hook additional context: CANCEL_STOP_CONTEXT\n</system-reminder>',
  ] : [], feedback: admitted ? ['Stop hook feedback:\nCANCEL_STOP_FEEDBACK'] : [], interrupted: true })
  receipt.eventID = 'mutated'
  assert.throws(() => f.transcripts.admitStopInterruption(f.event, f.session, receipt), { code: 'TRANSCRIPT_STOP_INTERRUPTION_REUSED' })
  f.runtime.observeModel({ host: 'v2', sessionID: 'session', messageID: 'next', signal: next.turnSignal })
  f.records.push({ type: 'user', id: 'next', text: 'Next', time: { created: CREATED + 3 } }, secondAnswer())
  const event = { ...f.event, messageID: 'next', completionID: 'answer-2' }
  const path = await f.transcripts.prepare(event, next, next.turnSignal)
  const rows = parse(await readFile(path, 'utf8'))
  const interruption = rows.find(row => row.userType === 'external')
  const index = rows.indexOf(interruption)
  assert.deepEqual(interruption.message, { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] })
  assert.equal(interruption.promptId, 'prompt')
  assert.equal(interruption.entrypoint, 'sdk-cli')
  assert.equal(interruption.parentUuid, rows[index - 1].uuid)
  assert.equal(rows[index + 1].parentUuid, interruption.uuid)
  assert.equal(interruption.timestamp, new Date(CREATED + 2).toISOString())
  assert.equal(rows.filter(row => row.subtype === 'stop_hook_summary').length, admitted ? 1 : 0)
  assert.deepEqual(parse(await readFile(await f.transcripts.prepare(event, next, next.turnSignal), 'utf8')), rows)
  f.records.splice(1, 1)
  await assert.rejects(f.transcripts.prepare(event, next, next.turnSignal), { code: 'TRANSCRIPT_STOP_HISTORY_UNAVAILABLE' })
  assert.deepEqual(parse(await readFile(path, 'utf8')), rows)
  f.runtime.sessions.prompt('session', 'third', 'fixture')
  assert.throws(() => f.transcripts.admitStopInterruption(event, next, { ...receipt, eventID: 'execution-interruption' }), { code: 'TRANSCRIPT_STOP_INTERRUPTION_REUSED' })
  f.runtime.sessions.close('session')
  assert.equal(f.transcripts.inspect().stopBytes, 0)
  assert.equal(f.transcripts.inspect().stopRecords, 0)
})

test('SDK interruption refuses foreign owners and malformed receipts without retaining artifacts', async t => {
  const f = await fixture(t, oracle.cases[0], false)
  f.runtime.sessions.prompt('session', 'next', 'fixture')
  const receipt = { eventID: 'execution-interruption', created: CREATED + 2, reason: 'user' as const, source: 'sdk-cli' as const }
  const before = f.transcripts.inspect()
  for (const changed of [{ ...receipt, reason: 'shutdown' }, { ...receipt, source: 'tui' }, { ...receipt, created: 9e15 }, { ...receipt, eventID: '' }, { ...receipt, eventID: 'x'.repeat(4097) }, { ...receipt, extra: true }]) assert.throws(() => f.transcripts.admitStopInterruption(f.event, f.session, changed as any), { code: 'TRANSCRIPT_STOP_INTERRUPTION_INVALID' })
  assert.throws(() => f.transcripts.admitStopInterruption(f.event, f.session, { ...receipt, created: NaN }), { code: 'TRANSCRIPT_SCHEMA_INVALID' })
  for (const event of [{ ...f.event, completionID: 'foreign' }, { ...f.event, messageID: 'foreign' }]) assert.throws(() => f.transcripts.admitStopInterruption(event, f.session, receipt), { code: 'TRANSCRIPT_STOP_INTERRUPTION_UNAVAILABLE' })
  assert.throws(() => f.transcripts.admitStopInterruption(f.event, { ...f.session, turnSignal: new AbortController().signal }, receipt), { code: 'TRANSCRIPT_STOP_INTERRUPTION_UNAVAILABLE' })
  assert.deepEqual(f.transcripts.inspect(), before)
  f.runtime.sessions.close('session')
  assert.throws(() => f.transcripts.admitStopInterruption(f.event, f.session, receipt), { code: 'TRANSCRIPT_CANCELLED' })
})

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

test('an admitted synthetic readback preserves the original turn and native Stop transcript records', async t => {
  const f = await fixture(t, { outputs: [{ decision: 'block', reason: 'Feedback' }], completionOrder: [0] }, true)
  const row = synthetic()
  f.transcripts.admitContinuation(f.delivery, row)
  f.records.push(structuredClone(row), secondAnswer())
  row.text = 'Changed caller-owned copy'
  const path = await f.transcripts.prepare({ ...f.event, completionID: 'answer-2' }, f.session, f.session.turnSignal)
  const entries = parse(await readFile(path, 'utf8'))
  assert.deepEqual(entries.filter(row => row.type === 'user').map(row => row.message.content), ['Original', 'Stop hook feedback:\nFeedback'])
  assert.equal(entries.filter(row => row.subtype === 'stop_hook_summary').length, 1)
  assert.deepEqual(entries.filter(row => row.type === 'assistant').map(row => row.message.id), ['answer', 'answer-2'])
  assert.ok(!JSON.stringify(entries).includes('transport marker'))
  for (let index = 1; index < entries.length; index++) assert.equal(entries[index].parentUuid, entries[index - 1].uuid)
  assert.equal(f.runtime.sessions.get('session').turnID, 'prompt')
  await f.unchanged()
})

test('changed, moved or pruned owned synthetic history cannot overwrite the admitted transcript', async t => {
  const f = await fixture(t, { outputs: [{ decision: 'block', reason: 'Feedback' }], completionOrder: [0] }, true)
  const row = synthetic()
  f.transcripts.admitContinuation(f.delivery, row)
  f.records.push(row, secondAnswer())
  const event = { ...f.event, completionID: 'answer-2' }
  await f.transcripts.prepare(event, f.session, f.session.turnSignal)
  const before = await readFile(f.transcriptPath, 'utf8')
  for (const changed of [{ ...row, text: 'Changed' }, { ...row, metadata: { source: 'foreign' } }, { ...row, time: { created: CREATED + 99 } }, { ...row, description: 'Changed' }]) {
    f.records[2] = changed
    await assert.rejects(f.transcripts.prepare(event, f.session, f.session.turnSignal), { code: 'TRANSCRIPT_STOP_CONTINUATION_CHANGED' })
    assert.equal(await readFile(f.transcriptPath, 'utf8'), before)
  }
  f.records.splice(1, 2, row, f.records[1])
  await assert.rejects(f.transcripts.prepare(event, f.session, f.session.turnSignal), { code: 'TRANSCRIPT_STOP_CONTINUATION_POSITION' })
  f.records.splice(1, 2, f.records[2], row)
  f.records.splice(2, 1)
  await assert.rejects(f.transcripts.prepare(event, f.session, f.session.turnSignal), { code: 'TRANSCRIPT_STOP_HISTORY_UNAVAILABLE' })
  assert.equal(await readFile(f.transcriptPath, 'utf8'), before)
})

test('synthetic admission requires the admitted continuing Stop and rejects conflicting identities atomically', async t => {
  for (const output of [{}, { continue: false, stopReason: 'Stopped' }, { decision: 'block', reason: 'Feedback' }]) {
    const f = await fixture(t, { outputs: [output], completionOrder: [0] }, false)
    assert.throws(() => f.transcripts.admitContinuation(f.delivery, synthetic()), { code: 'TRANSCRIPT_STOP_CONTINUATION_UNAVAILABLE' })
    f.transcripts.admitStop(f.delivery)
    const before = f.transcripts.inspect()
    if (!('decision' in output)) {
      assert.throws(() => f.transcripts.admitContinuation(f.delivery, synthetic()), { code: 'TRANSCRIPT_STOP_CONTINUATION_UNAVAILABLE' })
      assert.deepEqual(f.transcripts.inspect(), before)
      continue
    }
    for (const row of [null, { ...synthetic(), type: 'user' }, { ...synthetic(), id: '' }, { ...synthetic(), id: 'prompt' }, { ...synthetic(), id: 'answer' }, { ...synthetic(), text: 123 }, { ...synthetic(), metadata: [] }, { ...synthetic(), time: { created: NaN } }]) {
      assert.throws(() => f.transcripts.admitContinuation(f.delivery, row))
      assert.deepEqual(f.transcripts.inspect(), before)
    }
    f.transcripts.admitContinuation(f.delivery, synthetic())
    assert.throws(() => f.transcripts.admitContinuation(f.delivery, synthetic()), { code: 'TRANSCRIPT_STOP_ID_REUSED' })
  }
})

test('historical synthetic ownership survives a real prompt without reclaiming its turn', async t => {
  const f = await fixture(t, { outputs: [{ decision: 'block', reason: 'Feedback' }], completionOrder: [0] }, true)
  f.transcripts.admitContinuation(f.delivery, synthetic())
  f.records.push(synthetic(), secondAnswer())
  f.runtime.sessions.prompt('session', 'next', 'fixture')
  const session = f.runtime.sessions.get('session')
  assert.throws(() => f.transcripts.admitContinuation(f.delivery, { ...synthetic(), id: 'stale' }), { code: 'TRANSCRIPT_CANCELLED' })
  f.records.push({ type: 'user', id: 'next', text: 'Next', time: { created: CREATED + 4 } }, { ...secondAnswer(), id: 'next-answer' })
  f.transcripts.observeModel({ host: 'v2', sessionID: 'session', messageID: 'next', signal: session.turnSignal }, session)
  const path = await f.transcripts.prepare({ ...f.event, messageID: 'next', completionID: 'next-answer' }, session, session.turnSignal)
  assert.deepEqual(parse(await readFile(path, 'utf8')).filter(row => row.type === 'user').map(row => row.message.content), ['Original', 'Stop hook feedback:\nFeedback', 'Next'])
  assert.equal(f.runtime.sessions.get('session').turnID, 'next')
})

test('synthetic admission shares retained byte limits and rejects cancelled or foreign owners', async t => {
  const f = await fixture(t, { outputs: [{ decision: 'block', reason: 'Feedback' }], completionOrder: [0] }, true)
  const before = f.transcripts.inspect()
  const foreign = new Sessions()
  t.after(() => foreign.dispose())
  foreign.prompt('session', 'prompt', 'fixture')
  assert.throws(() => f.transcripts.admitContinuation({ ...f.delivery, session: foreign.get('session') }, synthetic()), { code: 'TRANSCRIPT_STOP_CONTINUATION_UNAVAILABLE' })
  const controller = new AbortController()
  controller.abort()
  assert.throws(() => f.transcripts.admitContinuation({ ...f.delivery, signal: controller.signal }, synthetic()), { code: 'TRANSCRIPT_CANCELLED' })
  assert.throws(() => f.transcripts.admitContinuation(f.delivery, { ...synthetic(), text: 'x'.repeat(32 * 1024 * 1024 - 1024) }), { code: 'TRANSCRIPT_STOP_LIMIT' })
  assert.deepEqual(f.transcripts.inspect(), before)
  f.transcripts.admitContinuation(f.delivery, synthetic())
  assert.ok(f.transcripts.inspect().stopBytes > before.stopBytes)
  f.runtime.sessions.close('session')
  assert.equal(f.transcripts.inspect().stopBytes, 0)
})

test('a transcript reservation holds the exact synthetic payload before normalized readback exists', async t => {
  const f = await fixture(t, { outputs: [{ decision: 'block', reason: 'Feedback' }], completionOrder: [0] }, true)
  const row = synthetic()
  const input = { id: row.id, text: row.text, metadata: structuredClone(row.metadata), description: row.description }
  const before = f.transcripts.inspect()
  const reservation = f.transcripts.reserveContinuation(f.delivery, input)
  const reserved = f.transcripts.inspect()
  assert.ok(reserved.stopBytes > before.stopBytes)
  input.text = 'Changed caller marker'; input.metadata.source = 'Changed caller metadata'
  f.records.push(row, secondAnswer())
  const event = { ...f.event, completionID: 'answer-2' }
  await assert.rejects(f.transcripts.prepare(event, f.session, f.session.turnSignal), { code: 'TRANSCRIPT_CONTENT_UNSUPPORTED' })
  assert.throws(() => f.transcripts.admitContinuation(f.delivery, row), { code: 'TRANSCRIPT_STOP_ID_REUSED' })
  reservation.admit(row)
  assert.ok(f.transcripts.inspect().stopBytes <= reserved.stopBytes)
  assert.throws(() => reservation.admit(row), { code: 'TRANSCRIPT_STOP_RESERVATION_UNAVAILABLE' })
  reservation.release()
  const path = await f.transcripts.prepare(event, f.session, f.session.turnSignal)
  assert.deepEqual(parse(await readFile(path, 'utf8')).filter(row => row.type === 'user').map(row => row.message.content), ['Original', 'Stop hook feedback:\nFeedback'])
})

test('a reserved transcript readback cannot change payload or add unreserved native fields', async t => {
  const f = await fixture(t, { outputs: [{ decision: 'block', reason: 'Feedback' }], completionOrder: [0] }, true)
  const row = synthetic()
  const input = { id: row.id, text: row.text, metadata: row.metadata, description: row.description }
  const reservation = f.transcripts.reserveContinuation(f.delivery, input)
  const before = f.transcripts.inspect()
  for (const changed of [{ ...row, id: 'foreign' }, { ...row, text: 'Foreign' }, { ...row, metadata: { source: 'foreign' } }, { ...row, description: 'Foreign' }, { ...row, extra: 'Unreserved' }, { ...row, time: { created: CREATED + 2, extra: 'Unreserved' } }]) {
    assert.throws(() => reservation.admit(changed), { code: 'TRANSCRIPT_STOP_CONTINUATION_CHANGED' })
    assert.deepEqual(f.transcripts.inspect(), before)
  }
  reservation.admit({ ...row, metadata: { token: 'fixture', completionID: 'answer', source: 'opencode-harness-hooks' } })
  f.records.push(row, secondAnswer())
  await f.transcripts.prepare({ ...f.event, completionID: 'answer-2' }, f.session, f.session.turnSignal)
})

test('releasing or cancelling a transcript reservation frees its budget and identity', async t => {
  const f = await fixture(t, { outputs: [{ decision: 'block', reason: 'Feedback' }], completionOrder: [0] }, true)
  const row = synthetic()
  const input = { id: row.id, text: row.text, metadata: row.metadata, description: row.description }
  const before = f.transcripts.inspect()
  const reservation = f.transcripts.reserveContinuation(f.delivery, input)
  assert.throws(() => f.transcripts.reserveContinuation(f.delivery, input), { code: 'TRANSCRIPT_STOP_ID_REUSED' })
  reservation.release(); reservation.release()
  assert.deepEqual(f.transcripts.inspect(), before)
  assert.throws(() => reservation.admit(row), { code: 'TRANSCRIPT_STOP_RESERVATION_UNAVAILABLE' })
  const controller = new AbortController()
  const cancelled = f.transcripts.reserveContinuation({ ...f.delivery, signal: controller.signal }, input)
  controller.abort()
  assert.deepEqual(f.transcripts.inspect(), before)
  assert.throws(() => cancelled.admit(row), { code: 'TRANSCRIPT_CANCELLED' })
  f.transcripts.reserveContinuation(f.delivery, input).admit(row)
  f.runtime.sessions.close('session')
  assert.equal(f.transcripts.inspect().stopBytes, 0)
  reservation.release(); cancelled.release()
  assert.equal(f.transcripts.inspect().stopBytes, 0)
})

test('transcript reservation preflight rejects unknown payloads and excess bytes before claiming ownership', async t => {
  const f = await fixture(t, { outputs: [{ decision: 'block', reason: 'Feedback' }], completionOrder: [0] }, true)
  const row = synthetic()
  const input = { id: row.id, text: row.text, metadata: row.metadata, description: row.description }
  const before = f.transcripts.inspect()
  for (const value of [null, { ...input, id: 'prompt' }, { ...input, id: '' }, { ...input, text: 123 }, { ...input, metadata: [] }, { ...input, extra: 'Unreserved' }]) {
    assert.throws(() => f.transcripts.reserveContinuation(f.delivery, value))
    assert.deepEqual(f.transcripts.inspect(), before)
  }
  assert.throws(() => f.transcripts.reserveContinuation(f.delivery, { ...input, text: 'x'.repeat(32 * 1024 * 1024 - 1024) }), { code: 'TRANSCRIPT_STOP_LIMIT' })
  assert.deepEqual(f.transcripts.inspect(), before)
  const reservation = f.transcripts.reserveContinuation(f.delivery, input)
  await f.transcripts.dispose()
  reservation.release()
  assert.equal(f.transcripts.inspect().stopBytes, 0)
  assert.throws(() => reservation.admit(row), { code: 'TRANSCRIPT_CANCELLED' })
})

test('transcript reservation ownership captures delivery identity before caller mutation', async t => {
  for (const action of ['admit', 'release'] as const) {
    const f = await fixture(t, { outputs: [{ decision: 'block', reason: 'Feedback' }], completionOrder: [0] }, true)
    const row = synthetic()
    const input = { id: row.id, text: row.text, metadata: row.metadata, description: row.description }
    const mutable = { ...f.delivery, event: { ...f.delivery.event }, session: { ...f.delivery.session } }
    const before = f.transcripts.inspect()
    const reservation = f.transcripts.reserveContinuation(mutable, input)
    mutable.event.sessionID = 'foreign'; mutable.event.completionID = 'foreign'; mutable.session.turnID = 'foreign'
    if (action === 'release') {
      reservation.release()
      assert.deepEqual(f.transcripts.inspect(), before)
    } else {
      reservation.admit(row)
      f.records.push(row, secondAnswer())
      await f.transcripts.prepare({ ...f.event, completionID: 'answer-2' }, f.session, f.session.turnSignal)
    }
  }
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
