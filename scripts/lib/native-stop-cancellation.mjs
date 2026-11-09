import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { nativeCheckError, NATIVE_PROCESS_LIMITS } from './native-process.mjs'

export const CANCELLATION_MODES = Object.freeze({ DURING_HOOK: 'during-hook', AFTER_FEEDBACK: 'after-feedback' })
const COMMAND_DELAY_MS = 2000
const POLL_MS = 10
const MAX_STOP_PASSES = 2
const INTERRUPTION = '[Request interrupted by user]'
const FEEDBACK = 'CANCEL_STOP_FEEDBACK'
const CONTEXT = 'CANCEL_STOP_CONTEXT'
const MARKER = /CANCEL_STOP_|LATER_|\[Request interrupted by user\]/
const texts = message => typeof message.content === 'string' ? [message.content] : message.content.filter(part => part.type === 'text').map(part => part.text)

export async function stopCancellationCases() {
  return JSON.parse(await readFile(new URL('../../test/fixtures/claude-stop-cancellation-oracle.json', import.meta.url), 'utf8')).cases
}

export async function createStopCancellationFixture(scenario, trace, hook) {
  await writeFile(hook, `const fs=require('node:fs');const input=JSON.parse(fs.readFileSync(0,'utf8'));const path=${JSON.stringify(trace)};const rows=fs.existsSync(path)?fs.readFileSync(path,'utf8').trim().split('\\n').map(JSON.parse):[];const ordinal=rows.filter(row=>row.phase==='start').length;if(ordinal>=${MAX_STOP_PASSES})process.exit(9);const transcriptExists=typeof input.transcript_path==='string'&&fs.existsSync(input.transcript_path);const log=phase=>fs.appendFileSync(path,JSON.stringify({phase,ordinal,input,transcriptExists,time:Date.now()})+'\\n');log('start');const finish=()=>{log('end');if(!ordinal)console.log(JSON.stringify({decision:'block',reason:${JSON.stringify(FEEDBACK)},hookSpecificOutput:{hookEventName:'Stop',additionalContext:${JSON.stringify(CONTEXT)}}}))};if(!ordinal&&${JSON.stringify(scenario.name)}===${JSON.stringify(CANCELLATION_MODES.DURING_HOOK)})setTimeout(finish,${COMMAND_DELAY_MS});else finish()`)
  return [{ type: 'command', command: process.execPath, args: [hook], timeout: 10 }]
}

export function armStopCancellation(scenario, trace, controller) {
  if (scenario.name !== CANCELLATION_MODES.DURING_HOOK) return () => {}
  const lifetime = new AbortController()
  let reading
  const poll = async () => {
    try {
      const bytes = await readFile(trace, { signal: lifetime.signal })
      if (bytes.length > NATIVE_PROCESS_LIMITS.maxBytes) return
      const rows = bytes.toString('utf8').trim().split('\n').map(JSON.parse)
      if (!lifetime.signal.aborted && rows.some(row => row.phase === 'start' && row.ordinal === 0)) controller.abort()
    } catch {}
  }
  const timer = setInterval(() => {
    if (!reading && !controller.signal.aborted) reading = poll().finally(() => { reading = undefined })
  }, POLL_MS)
  return async () => { clearInterval(timer); lifetime.abort(); await reading }
}

export function validateStopCancellation(scenario, trace, rows, requests, execution, command) {
  try { return validate(scenario, trace, rows, requests, execution, command) } catch (error) { throw nativeCheckError('NATIVE_STOP_CANCELLATION_CHECK_FAILED', scenario.name, error, import.meta.url) }
}

function validate(scenario, trace, rows, requests, execution, command) {
  const starts = trace.filter(row => row.phase === 'start'), ends = trace.filter(row => row.phase === 'end')
  assert.equal(requests.length, scenario.modelRequests)
  assert.equal(starts.length, MAX_STOP_PASSES)
  assert.equal(ends.length, scenario.retainedStopOutput ? MAX_STOP_PASSES : MAX_STOP_PASSES - 1)
  assert.equal(new Set(starts.map(row => row.input.session_id)).size, 1)
  assert.equal(new Set(starts.map(row => row.input.prompt_id)).size, MAX_STOP_PASSES)
  assert.ok(starts.every(row => row.input.hook_event_name === 'Stop' && row.input.stop_hook_active === false && row.transcriptExists))
  assert.deepEqual(starts.map(row => row.input.last_assistant_message), ['NATIVE_STOP_ANSWER_1', 'NATIVE_STOP_ANSWER_' + scenario.modelRequests])
  assert.ok(execution.interrupt.sentAt >= starts[0].time)
  assert.ok(execution.interrupt.acknowledgedAt >= execution.interrupt.sentAt)
  assert.ok(starts[1].time >= execution.interrupt.acknowledgedAt)
  assert.ok(execution.completedAt >= ends.at(-1).time)
  if (!scenario.retainedStopOutput) assert.ok(!ends.some(row => row.ordinal === 0))
  const interrupted = rows.filter(row => row.type === 'user' && Array.isArray(row.message?.content) && row.message.content.some(part => part.text === INTERRUPTION))
  assert.equal(interrupted.length, 1)
  assert.deepEqual(interrupted[0].message, { role: 'user', content: [{ type: 'text', text: INTERRUPTION }] })
  assert.equal(interrupted[0].promptId, starts[0].input.prompt_id)
  assert.equal(interrupted[0].userType, 'external')
  assert.equal(interrupted[0].entrypoint, 'sdk-cli')
  assert.ok(rows.some(row => row.uuid === interrupted[0].parentUuid))
  const summaries = rows.filter(row => row.subtype === 'stop_hook_summary')
  assert.equal(summaries.length, scenario.retainedStopOutput ? MAX_STOP_PASSES : MAX_STOP_PASSES - 1)
  assert.ok(summaries.every(row => row.hookInfos.some(info => info.command === command)))
  const errors = rows.filter(row => row.attachment?.type === 'hook_blocking_error' && row.attachment.blockingError?.command === command)
  assert.equal(errors.length, scenario.retainedStopOutput ? 1 : 0)
  if (scenario.retainedStopOutput) assert.equal(errors[0].attachment.blockingError.blockingError, FEEDBACK)
  const messages = requests.at(-1).body.messages
  assert.deepEqual(messages.map(row => row.role), ['user', 'assistant', 'user'])
  assert.deepEqual(texts(messages[1]), ['NATIVE_STOP_ANSWER_1'])
  assert.deepEqual(texts(messages[2]).filter(text => MARKER.test(text)), scenario.nextUser.map(text => text.replaceAll('FIXTURE_COMMAND', command)))
  assert.ok(!messages.some(row => texts(row).includes('No response requested.')))
  return { mode: scenario.name, interruptionAcknowledged: true, stoppedCommandOutputAbsent: !scenario.retainedStopOutput, admittedStopOutputRetained: scenario.retainedStopOutput, nativeInterruptionRecord: true, distinctRealTurns: true, exactOwnedNextPromptBlocks: true, noResumePlaceholder: true }
}
