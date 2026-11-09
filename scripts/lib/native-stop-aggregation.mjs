import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { nativeCheckError } from './native-process.mjs'

const FAST_MS = 25
const SLOW_MS = 350
const MAX_PASSES = 2
const FEEDBACK_PREFIX = 'Stop hook feedback:\n'
const FEEDBACK_MARKER = /NATIVE_STOP_[AB]\b/
const quote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'"
const texts = message => typeof message.content === 'string' ? [message.content] : message.content.filter(part => ['text', 'input_text', 'output_text'].includes(part.type)).map(part => part.text)

export async function stopAggregationCases(dialect) {
  const oracle = JSON.parse(await readFile(new URL('../../test/fixtures/claude-stop-aggregation-oracle.json', import.meta.url), 'utf8'))
  return oracle.cases.filter(row => dialect === 'claude-code' || row.name !== 'context-then-block')
}

export async function createStopAggregationFixture(scenario, trace, hook, dialect) {
  await writeFile(hook, `const fs=require('node:fs');const input=JSON.parse(fs.readFileSync(0,'utf8'));const path=${JSON.stringify(trace)};const handler=Number(process.argv[2]);const outputs=${JSON.stringify(scenario.outputs)};const order=${JSON.stringify(scenario.completionOrder)};const rows=fs.existsSync(path)?fs.readFileSync(path,'utf8').trim().split('\\n').filter(Boolean).map(JSON.parse):[];const ordinal=rows.filter(row=>row.phase==='start'&&row.handler===handler).length;if(ordinal>=${MAX_PASSES})process.exit(9);const transcriptExists=typeof input.transcript_path==='string'&&fs.existsSync(input.transcript_path);const log=phase=>fs.appendFileSync(path,JSON.stringify({phase,handler,ordinal,input,transcriptExists,time:Date.now()})+'\\n');log('start');setTimeout(()=>{log('end');if(!ordinal)console.log(JSON.stringify(outputs[handler]))},order.indexOf(handler)?${SLOW_MS}:${FAST_MS})`)
  return scenario.outputs.map((_, index) => ({ type: 'command', command: dialect === 'claude-code' ? process.execPath : [process.execPath, hook, String(index)].map(quote).join(' '), ...(dialect === 'claude-code' ? { args: [hook, String(index)] } : {}), timeout: 10 }))
}

export function validateStopAggregation(dialect, scenario, trace, rows, requests, execution, commands, sourcePath, project) {
  try { return validate(dialect, scenario, trace, rows, requests, execution, commands, sourcePath, project) } catch (error) { throw nativeCheckError('NATIVE_STOP_AGGREGATION_CHECK_FAILED', scenario.name, error, import.meta.url) }
}

function validate(dialect, scenario, trace, rows, requests, execution, commands, sourcePath, project) {
  const starts = trace.filter(row => row.phase === 'start'), ends = trace.filter(row => row.phase === 'end')
  const expected = scenario.modelRequests
  assert.equal(requests.length, expected)
  assert.equal(starts.length, expected * commands.length)
  assert.equal(ends.length, starts.length)
  assert.deepEqual(ends.filter(row => !row.ordinal).map(row => row.handler), scenario.completionOrder)
  assert.ok(starts.every(row => row.input.hook_event_name === 'Stop' && row.input.cwd === project && row.transcriptExists && isAbsolute(row.input.transcript_path)))
  assert.equal(new Set(starts.map(row => row.input.session_id)).size, 1)
  assert.equal(new Set(starts.map(row => row.input.turn_id ?? row.input.prompt_id)).size, 1)
  assert.equal(new Set(starts.map(row => row.input.transcript_path)).size, 1)
  assert.ok(starts.every(row => typeof row.input.session_id === 'string' && row.input.session_id && typeof (row.input.turn_id ?? row.input.prompt_id) === 'string' && (row.input.turn_id ?? row.input.prompt_id)))
  for (const start of starts) {
    const end = ends.find(row => row.handler === start.handler && row.ordinal === start.ordinal)
    assert.ok(end.time >= start.time + (scenario.completionOrder.indexOf(start.handler) ? SLOW_MS : FAST_MS))
    assert.equal(start.input.stop_hook_active, Boolean(start.ordinal))
    assert.equal(start.input.last_assistant_message, 'NATIVE_STOP_ANSWER_' + (start.ordinal + 1))
    assert.ok(requests[start.ordinal].time <= start.time)
  }
  assert.ok(execution.completedAt >= Math.max(...ends.map(row => row.time)))
  if (expected > 1) assert.ok(requests[1].time >= Math.max(...ends.filter(row => !row.ordinal).map(row => row.time)))
  let additionalNativeHandlers = 0, nativeDiagnosticItems = 0
  if (dialect === 'claude-code') {
    const result = JSON.parse(execution.stdout)
    assert.equal(result.is_error, false)
    assert.equal(result.result, scenario.cliResult)
    assert.ok(starts.every(row => Array.isArray(row.input.background_tasks) && Array.isArray(row.input.session_crons)))
    const summaries = rows.filter(row => row.type === 'system' && row.subtype === 'stop_hook_summary')
    assert.equal(summaries.length, expected)
    for (const [pass, summary] of summaries.entries()) {
      const owned = summary.hookInfos.filter(info => commands.includes(info.command))
      assert.equal(owned.length, commands.length)
      assert.deepEqual(owned.map(info => info.command), commands)
      assert.deepEqual(owned.map(info => Object.hasOwn(info, 'durationMs')), pass ? [true, true] : scenario.hookInfoDuration)
      assert.equal(summary.hookCount, summary.hookInfos.length)
      additionalNativeHandlers = Math.max(additionalNativeHandlers, summary.hookCount - owned.length)
      assert.deepEqual(summary.hookErrors, pass ? [] : scenario.hookErrors)
      assert.deepEqual(summary.hookAdditionalContext, pass ? [] : scenario.hookAdditionalContext)
      assert.equal(summary.preventedContinuation, !pass && scenario.preventedContinuation)
      assert.equal(summary.stopReason, pass ? '' : scenario.stopReason)
      assert.equal(summary.hasOutput, pass === 0)
    }
    const feedback = rows.filter(row => row.type === 'user' && row.isMeta === true && typeof row.message.content === 'string' && row.message.content.startsWith(FEEDBACK_PREFIX))
    assert.deepEqual(feedback.map(row => row.message.content.slice(FEEDBACK_PREFIX.length)), scenario.feedback)
    const firstAnswer = rows.findIndex(row => row.type === 'assistant' && texts(row.message).includes('NATIVE_STOP_ANSWER_1'))
    assert.ok(firstAnswer >= 0)
    assert.ok(feedback.every(row => rows.indexOf(row) > firstAnswer && rows.indexOf(row) < rows.indexOf(summaries[0])))
    const ownedRecords = rows.slice(firstAnswer + 1, rows.indexOf(summaries[0])).flatMap(row => {
      if (feedback.includes(row)) return [{ row, kind: 'feedback', handler: ['NATIVE_STOP_A', 'NATIVE_STOP_B'].indexOf(row.message.content.slice(FEEDBACK_PREFIX.length)) }]
      const attachment = row.attachment
      if (attachment?.hookEvent !== 'Stop') return []
      const command = attachment.command ?? attachment.blockingError?.command
      const handler = command !== undefined ? commands.indexOf(command) : attachment.type === 'hook_stopped_continuation' ? ['NATIVE_STOP_A', 'NATIVE_STOP_B'].indexOf(attachment.message) : attachment.type === 'hook_additional_context' ? ['NATIVE_STOP_A', 'NATIVE_STOP_B'].indexOf(attachment.content[0]) : -1
      return handler < 0 ? [] : [{ row, kind: attachment.type, handler }]
    })
    assert.deepEqual(ownedRecords.map(row => [row.kind, row.handler]), scenario.recordOrder)
    assert.ok(ownedRecords.filter(row => row.kind !== 'feedback').every(row => row.row.attachment.toolUseID === summaries[0].toolUseID))
    for (const owned of ownedRecords) {
      const previous = rows.slice(0, rows.indexOf(owned.row)).findLast(row => ['user', 'assistant', 'attachment', 'system'].includes(row.type))
      assert.equal(owned.row.parentUuid, previous.uuid)
    }
    if (expected > 1) {
      const reminders = scenario.completionOrder.flatMap(index => {
        const output = scenario.outputs[index]
        if (output.decision === 'block') return [`<system-reminder>\nStop hook blocking error from command: "${commands[index]}": ${output.reason}\n</system-reminder>`]
        if (output.hookSpecificOutput) return [`<system-reminder>\nStop hook additional context: ${output.hookSpecificOutput.additionalContext}\n</system-reminder>`]
        return []
      })
      const expectedBlocks = [...reminders.map((text, index) => text + (index === reminders.length - 1 && scenario.feedback.length ? '\n' : '')), ...scenario.feedback.map((text, index) => FEEDBACK_PREFIX + text + (index < scenario.feedback.length - 1 ? '\n' : ''))]
      const delivered = requests[1].body.messages.filter(message => texts(message).some(text => FEEDBACK_MARKER.test(text)))
      assert.equal(delivered.length, 1)
      assert.equal(delivered[0].role, 'user')
      assert.deepEqual(texts(delivered[0]), expectedBlocks)
    }
  } else {
    const output = execution.stdout.trim().split('\n').map(line => JSON.parse(line))
    assert.equal(output.filter(row => row.type === 'turn.started').length, 1)
    assert.equal(output.filter(row => row.type === 'turn.completed').length, 1)
    nativeDiagnosticItems = output.filter(row => row.item?.type === 'error').length
    assert.deepEqual(output.filter(row => row.item?.type === 'agent_message').map(row => row.item.text), expected > 1 ? ['NATIVE_STOP_ANSWER_1', 'NATIVE_STOP_ANSWER_2'] : ['NATIVE_STOP_ANSWER_1'])
    const prompts = rows.filter(row => row.type === 'event_msg' && row.payload.type === 'item_completed' && row.payload.item.type === 'HookPrompt')
    assert.equal(prompts.length, scenario.name === 'two-blocks' ? 1 : 0)
    if (prompts.length) {
      const prompt = prompts[0].payload
      assert.deepEqual(prompt.item.fragments.map(row => row.text), ['NATIVE_STOP_A', 'NATIVE_STOP_B'])
      assert.ok(prompt.item.fragments.every(row => /^stop:\d+:/.test(row.hookRunId) && row.hookRunId.endsWith(':' + sourcePath)))
      assert.equal(new Set(prompt.item.fragments.map(row => row.hookRunId)).size, commands.length)
      const response = rows.find(row => row.type === 'response_item' && row.payload.id === prompt.item.id)
      const wrappers = prompt.item.fragments.map(row => `<hook_prompt hook_run_id="${row.hookRunId}">${row.text}</hook_prompt>`)
      assert.equal(prompt.turn_id, starts[0].input.turn_id)
      assert.equal(response.payload.role, 'user')
      assert.deepEqual(texts(response.payload), wrappers)
      assert.equal(response.payload.internal_chat_message_metadata_passthrough.turn_id, prompt.turn_id)
      assert.deepEqual(response.payload.internal_chat_message_metadata_passthrough.content_item_metadata, [{ provenance: { type: 'harness', hook: true } }, { provenance: { type: 'harness', hook: true } }])
      const delivered = requests[1].body.input.filter(message => message.type === 'message' && texts(message).some(text => FEEDBACK_MARKER.test(text)))
      assert.equal(delivered.length, 1)
      assert.equal(delivered[0].role, 'user')
      assert.deepEqual(texts(delivered[0]), wrappers)
    }
  }
  return { mode: scenario.name, awaitedCompletion: true, modelRequests: expected, stopInvocations: starts.length, stableTurnIdentity: true, continuationActiveFlag: expected > 1, nativeAggregation: true, additionalNativeHandlers, nativeDiagnosticItems }
}
