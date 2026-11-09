import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { nativeCheckError } from './native-process.mjs'

const MAX_PASSES = 2
const FEEDBACK_PREFIX = 'Stop hook feedback:\n'
const REMINDER_PREFIX = '<system-reminder>\nStop hook '
const ENVELOPE = new Set(['parentUuid', 'isSidechain', 'uuid', 'timestamp', 'cwd', 'sessionId', 'version', 'userType', 'entrypoint', 'gitBranch'])
const texts = message => typeof message.content === 'string' ? [message.content] : message.content.filter(part => part.type === 'text').map(part => part.text)

export async function stopOutputCases() {
  return JSON.parse(await readFile(new URL('../../test/fixtures/claude-stop-output-oracle.json', import.meta.url), 'utf8')).cases
}

export async function createStopOutputFixture(scenario, trace, hook) {
  await writeFile(hook, `const fs=require('node:fs');const input=JSON.parse(fs.readFileSync(0,'utf8'));const path=${JSON.stringify(trace)};const output=${JSON.stringify(scenario.input)};const rows=fs.existsSync(path)?fs.readFileSync(path,'utf8').trim().split('\\n').filter(Boolean).map(JSON.parse):[];const ordinal=rows.filter(row=>row.phase==='start').length;if(ordinal>=${MAX_PASSES})process.exit(9);const transcriptExists=typeof input.transcript_path==='string'&&fs.existsSync(input.transcript_path);const started=Date.now();const log=phase=>fs.appendFileSync(path,JSON.stringify({phase,ordinal,input,transcriptExists,time:phase==='start'?started:Date.now()})+'\\n');log('start');const finish=()=>{const remaining=started+output.delayMs-Date.now();if(remaining>0){setTimeout(finish,remaining);return}log('end');if(ordinal)return;process.stdout.write(output.stdout);process.stderr.write(output.stderr);process.exitCode=output.exitCode};finish()`)
  return [{ type: 'command', command: process.execPath, args: [hook], timeout: scenario.input.timeoutSeconds ?? 10 }]
}

export function validateStopOutput(scenario, trace, rows, requests, execution, command, project) {
  try { return validate(scenario, trace, rows, requests, execution, command, project) } catch (error) { throw nativeCheckError('NATIVE_STOP_OUTPUT_CHECK_FAILED', scenario.name, error, import.meta.url) }
}

function validate(scenario, trace, rows, requests, execution, command, project) {
  const expected = scenario.modelRequests
  const starts = trace.filter(row => row.phase === 'start'), ends = trace.filter(row => row.phase === 'end')
  const timedOut = scenario.input.timeoutSeconds !== undefined
  assert.equal(starts.length, expected)
  assert.equal(ends.length, timedOut ? 0 : expected)
  assert.equal(requests.length, expected)
  assert.ok(starts.every(row => row.transcriptExists && row.input.hook_event_name === 'Stop' && row.input.cwd === project && isAbsolute(row.input.transcript_path)))
  assert.ok(starts.every(row => typeof row.input.session_id === 'string' && row.input.session_id && typeof row.input.prompt_id === 'string' && row.input.prompt_id && Array.isArray(row.input.background_tasks) && Array.isArray(row.input.session_crons)))
  assert.equal(new Set(starts.map(row => row.input.session_id)).size, 1)
  assert.equal(new Set(starts.map(row => row.input.prompt_id)).size, 1)
  assert.equal(new Set(starts.map(row => row.input.transcript_path)).size, 1)
  assert.deepEqual(starts.map(row => row.input.stop_hook_active), expected > 1 ? [false, true] : [false])
  assert.deepEqual(starts.map(row => row.input.last_assistant_message), starts.map((_, index) => 'NATIVE_STOP_ANSWER_' + (index + 1)))
  if (!timedOut) {
    assert.ok(starts.every((row, index) => ends[index].time >= row.time + scenario.input.delayMs))
    assert.ok(execution.completedAt >= ends.at(-1).time)
    if (expected > 1) assert.ok(requests[1].time >= ends[0].time)
  }
  const result = JSON.parse(execution.stdout)
  assert.equal(result.is_error, false)
  assert.equal(result.result, scenario.cliResult)
  const summaries = rows.filter(row => row.type === 'system' && row.subtype === 'stop_hook_summary')
  assert.equal(summaries.length, expected)
  const summary = summaries[0], info = summary.hookInfos.filter(info => info.command === command)
  assert.equal(info.length, 1)
  assert.equal(summary.hookCount, summary.hookInfos.length)
  const normalize = (value, key = '') => {
    if (key === 'durationMs') { assert.ok(typeof value === 'number' && Number.isFinite(value) && value >= 0); return '{duration}' }
    if (key === 'toolUseID') { assert.equal(value, summary.toolUseID); return '{batch}' }
    if (key === 'promptId') { assert.equal(value, starts[0].input.prompt_id); return '{turn}' }
    if (typeof value === 'string') return value.replaceAll(command, '{command}')
    if (Array.isArray(value)) return value.map(item => normalize(item))
    if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, value]) => [key, normalize(value, key)]))
    return value
  }
  const owned = rows.slice(0, rows.indexOf(summary)).filter(row => {
    if (row.type === 'user' && row.isMeta === true) return typeof row.message.content === 'string' && row.message.content.startsWith(FEEDBACK_PREFIX)
    const attachment = row.attachment
    if (attachment?.hookEvent !== 'Stop') return false
    const display = attachment.command ?? attachment.blockingError?.command
    return display === undefined || display === command
  })
  const bodies = [...owned.map(row => Object.fromEntries(Object.entries(row).filter(([key]) => !ENVELOPE.has(key)))), { ...Object.fromEntries(Object.entries(summary).filter(([key]) => !ENVELOPE.has(key))), hookCount: 1, hookInfos: info }]
  assert.deepEqual(normalize(bodies), scenario.records)
  for (const row of [...owned, summary]) {
    assert.equal(row.sessionId, starts[0].input.session_id)
    assert.equal(row.cwd, project)
    assert.equal(row.version, '2.1.318')
    assert.equal(row.isSidechain, false)
    assert.equal(row.userType, 'external')
    assert.equal(row.entrypoint, 'sdk-cli')
    assert.equal(typeof row.gitBranch, 'string')
    assert.match(row.uuid, /^[0-9a-f-]{36}$/)
    assert.ok(Number.isFinite(Date.parse(row.timestamp)))
    const previous = rows.slice(0, rows.indexOf(row)).findLast(row => ['user', 'assistant', 'attachment', 'system'].includes(row.type))
    assert.equal(row.parentUuid, previous.uuid)
    if (row.attachment?.durationMs !== undefined) assert.equal(row.attachment.durationMs, info[0].durationMs)
  }
  for (const later of summaries.slice(1)) {
    assert.deepEqual(later.hookErrors, [])
    assert.deepEqual(later.hookAdditionalContext, [])
    assert.equal(later.hasOutput, false)
    assert.equal(later.preventedContinuation, false)
  }
  const model = expected > 1 ? requests[1].body.messages.flatMap(message => texts(message).filter(text => text.startsWith(FEEDBACK_PREFIX) || text.startsWith(REMINDER_PREFIX)).map(text => ({ role: message.role, text: normalize(text) }))) : []
  assert.deepEqual(model, scenario.model)
  return { mode: scenario.name, awaitedCompletion: true, modelRequests: expected, stopInvocations: starts.length, nativeOutputArtifacts: true, additionalNativeHandlers: summary.hookCount - info.length }
}
