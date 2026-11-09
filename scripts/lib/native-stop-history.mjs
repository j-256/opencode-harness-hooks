import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { nativeCheckError } from './native-process.mjs'

export const STOP_HISTORY_PROMPTS = Object.freeze(['LATER_ORIGINAL_PROMPT', 'LATER_NEXT_PROMPT'])
const MARKER = /LATER_/
const COMMAND_PLACEHOLDER = 'FIXTURE_COMMAND'
const DELAY_MS = 100
const texts = message => typeof message.content === 'string' ? [message.content] : message.content.filter(part => part.type === 'text').map(part => part.text)

export async function stopHistoryCases() {
  const oracle = JSON.parse(await readFile(new URL('../../test/fixtures/claude-stop-history-oracle.json', import.meta.url), 'utf8'))
  return oracle.cases
}

export async function createStopHistoryFixture(scenario, trace, hook) {
  await writeFile(hook, `const fs=require('node:fs');const input=JSON.parse(fs.readFileSync(0,'utf8'));const file=${JSON.stringify(trace)};if(input.hook_event_name==='UserPromptSubmit'){if(input.prompt===${JSON.stringify(STOP_HISTORY_PROMPTS[1])})console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'UserPromptSubmit',additionalContext:${JSON.stringify(scenario.promptContext ?? '')}}}));return}const rows=fs.existsSync(file)?fs.readFileSync(file,'utf8').trim().split('\\n').filter(Boolean).map(JSON.parse):[];const ordinal=rows.filter(row=>row.phase==='start').length;if(ordinal>=${STOP_HISTORY_PROMPTS.length})process.exit(9);const transcriptExists=typeof input.transcript_path==='string'&&fs.existsSync(input.transcript_path);const log=phase=>fs.appendFileSync(file,JSON.stringify({phase,ordinal,input,transcriptExists,time:Date.now()})+'\\n');log('start');setTimeout(()=>{log('end');if(!ordinal)console.log(JSON.stringify(${JSON.stringify(scenario.output)}))},${DELAY_MS})`)
  return [{ type: 'command', command: process.execPath, args: [hook], timeout: 10 }]
}

export function validateStopHistory(scenario, trace, rows, requests, execution, command, project) {
  try { return validate(scenario, trace, rows, requests, execution, command, project) } catch (error) { throw nativeCheckError('NATIVE_STOP_HISTORY_CHECK_FAILED', scenario.name, error, import.meta.url) }
}

function validate(scenario, trace, rows, requests, execution, command, project) {
  const starts = trace.filter(row => row.phase === 'start'), ends = trace.filter(row => row.phase === 'end')
  assert.equal(requests.length, STOP_HISTORY_PROMPTS.length)
  assert.equal(starts.length, STOP_HISTORY_PROMPTS.length)
  assert.equal(ends.length, STOP_HISTORY_PROMPTS.length)
  assert.equal(new Set(starts.map(row => row.input.session_id)).size, 1)
  assert.equal(new Set(starts.map(row => row.input.prompt_id)).size, STOP_HISTORY_PROMPTS.length)
  assert.ok(starts.every(row => row.input.hook_event_name === 'Stop' && typeof row.input.prompt_id === 'string' && row.input.prompt_id && row.input.stop_hook_active === false && row.transcriptExists && isAbsolute(row.input.transcript_path) && row.input.cwd === project))
  assert.deepEqual(starts.map(row => row.input.last_assistant_message), ['NATIVE_STOP_ANSWER_1', 'NATIVE_STOP_ANSWER_2'])
  assert.ok(requests[1].time >= ends[0].time && execution.completedAt >= ends[1].time)
  for (const start of starts) assert.ok(ends.find(row => row.ordinal === start.ordinal).time >= start.time + DELAY_MS)
  const results = execution.stdout.trim().split('\n').map(line => JSON.parse(line)).filter(row => row.type === 'result')
  assert.equal(results.length, STOP_HISTORY_PROMPTS.length)
  assert.ok(results.every(row => row.is_error === false))
  const messages = requests[1].body.messages
  assert.deepEqual(messages.map(message => message.role), ['user', 'assistant', 'user'])
  assert.ok(texts(messages[0]).includes(STOP_HISTORY_PROMPTS[0]))
  assert.deepEqual(texts(messages[1]), ['NATIVE_STOP_ANSWER_1'])
  assert.deepEqual(texts(messages[2]).filter(text => MARKER.test(text)), scenario.nextUser.map(text => text.replaceAll(COMMAND_PLACEHOLDER, command)))
  assert.ok(!messages.some(message => texts(message).some(text => text === 'No response requested.')))
  const summaries = rows.filter(row => row.subtype === 'stop_hook_summary')
  assert.equal(summaries.length, STOP_HISTORY_PROMPTS.length)
  assert.equal(summaries[0].preventedContinuation, true)
  assert.equal(summaries[1].preventedContinuation, false)
  assert.ok(summaries[0].hookInfos.some(row => row.command === command))
  const attachments = rows.filter(row => row.attachment?.toolUseID === summaries[0].toolUseID && row.attachment.hookEvent === 'Stop').map(row => row.attachment)
  assert.ok(attachments.some(row => row.type === 'hook_stopped_continuation' && row.message === scenario.output.stopReason))
  if (scenario.output.decision === 'block') {
    assert.ok(attachments.some(row => row.type === 'hook_blocking_error' && row.blockingError?.command === command && row.blockingError.blockingError === scenario.output.reason))
    assert.ok(rows.some(row => row.type === 'user' && row.isMeta && row.message?.content === 'Stop hook feedback:\nLATER_FEEDBACK'))
  }
  if (scenario.output.hookSpecificOutput) assert.ok(attachments.some(row => row.type === 'hook_additional_context' && row.content.includes(scenario.output.hookSpecificOutput.additionalContext)))
  return { mode: scenario.name, runningProcess: true, distinctRealTurns: true, preventionWithoutModelContinuation: true, retainedStopArtifacts: true, exactOwnedNextPromptBlocks: true, resumedPlaceholderAbsent: true, additionalNativeHandlers: summaries[0].hookCount - 1 }
}
