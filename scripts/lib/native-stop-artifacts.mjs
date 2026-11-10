import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { nativeCheckError } from './native-process.mjs'

const MAX_PASSES = 3
const READY_POLL_MS = 5
const SLOW_MS = 350
const FAST_MS = 25
const quote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'"
const escapeText = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

export async function stopArtifactCases() {
  const oracle = JSON.parse(await readFile(new URL('../../test/fixtures/codex-stop-artifact-oracle.json', import.meta.url), 'utf8'))
  return oracle.cases.filter(row => row.name !== 'repeated-2').map(row => ({ ...row, continuations: row.name === 'repeated-1' ? 2 : 1 }))
}

export async function createStopArtifactFixture(scenario, trace, hook) {
  const feedback = scenario.feedback
  await writeFile(hook, `const fs=require('node:fs');const input=JSON.parse(fs.readFileSync(0,'utf8'));const path=${JSON.stringify(trace)};const handler=Number(process.argv[2]);const feedback=${JSON.stringify(feedback)};const rows=()=>fs.existsSync(path)?fs.readFileSync(path,'utf8').trim().split('\\n').filter(Boolean).map(JSON.parse):[];const ordinal=rows().filter(row=>row.phase==='start'&&row.handler===handler).length;if(ordinal>=${MAX_PASSES})process.exit(9);const log=phase=>fs.appendFileSync(path,JSON.stringify({phase,handler,ordinal,input,time:Date.now()})+'\\n');log('start');const timer=setInterval(()=>{if(rows().filter(row=>row.phase==='start'&&row.ordinal===ordinal).length<feedback.length)return;clearInterval(timer);setTimeout(()=>{log('end');if(ordinal<${scenario.continuations})console.log(JSON.stringify({decision:'block',reason:feedback[handler]}))},handler===0&&feedback.length>1?${SLOW_MS}:${FAST_MS})},${READY_POLL_MS})`)
  return feedback.map((_, index) => ({ type: 'command', command: [process.execPath, hook, String(index)].map(quote).join(' '), timeout: 10 }))
}

export function validateStopArtifacts(scenario, trace, rows, requests, execution, sourcePath) {
  try { return validate(scenario, trace, rows, requests, execution, sourcePath) } catch (error) { throw nativeCheckError('NATIVE_STOP_ARTIFACT_CHECK_FAILED', scenario.name, error, import.meta.url) }
}

function validate(scenario, trace, rows, requests, execution, sourcePath) {
  const starts = trace.filter(row => row.phase === 'start'), ends = trace.filter(row => row.phase === 'end')
  assert.equal(requests.length, scenario.continuations + 1)
  assert.equal(starts.length, requests.length * scenario.feedback.length)
  assert.equal(ends.length, starts.length)
  assert.equal(new Set(starts.map(row => row.input.turn_id)).size, 1)
  assert.ok(starts.every(row => row.input.stop_hook_active === Boolean(row.ordinal) && row.input.last_assistant_message === 'NATIVE_STOP_ANSWER_' + (row.ordinal + 1)))
  if (scenario.feedback.length > 1) assert.deepEqual(ends.filter(row => !row.ordinal).map(row => row.handler), [1, 0])
  const output = execution.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  assert.equal(output.filter(row => row.type === 'turn.started').length, 1)
  assert.equal(output.filter(row => row.type === 'turn.completed').length, 1)
  assert.deepEqual(output.filter(row => row.item?.type === 'agent_message').map(row => row.item.text), requests.map((_, index) => 'NATIVE_STOP_ANSWER_' + (index + 1)))
  const events = rows.filter(row => row.type === 'event_msg' && row.payload.type === 'item_completed' && row.payload.item.type === 'HookPrompt')
  assert.equal(events.length, scenario.continuations)
  let runIDs
  for (const [pass, row] of events.entries()) {
    const event = row.payload, fragments = event.item.fragments
    assert.deepEqual(fragments.map(value => value.text), scenario.feedback)
    const ordinals = fragments.map(value => {
      assert.ok(value.hookRunId.endsWith(':' + sourcePath))
      const ordinal = Number(/^stop:(\d+):/.exec(value.hookRunId)?.[1])
      assert.ok(Number.isSafeInteger(ordinal) && ordinal >= 0)
      return ordinal
    })
    assert.deepEqual(ordinals, ordinals.map((_, index) => ordinals[0] + index))
    if (runIDs) assert.deepEqual(fragments.map(value => value.hookRunId), runIDs)
    else runIDs = fragments.map(value => value.hookRunId)
    assert.equal(event.thread_id, starts[0].input.session_id)
    assert.equal(event.turn_id, starts[0].input.turn_id)
    assert.ok(typeof event.item.id === 'string' && event.item.id.startsWith('msg_'))
    assert.ok(Number.isSafeInteger(event.started_at_ms) && Number.isSafeInteger(event.completed_at_ms) && event.completed_at_ms >= event.started_at_ms)
    const matches = rows.filter(value => value.type === 'response_item' && value.payload.id === event.item.id)
    assert.equal(matches.length, 1)
    const response = matches[0], content = fragments.map(value => ({ type: 'input_text', text: `<hook_prompt hook_run_id="${escapeText(value.hookRunId).replaceAll('"', '&quot;')}">${escapeText(value.text)}</hook_prompt>` }))
    assert.ok(Number.isFinite(response.payload.internal_chat_message_metadata_passthrough.create_time))
    assert.deepEqual(response.payload, { type: 'message', id: event.item.id, role: 'user', content, internal_chat_message_metadata_passthrough: { turn_id: event.turn_id, create_time: response.payload.internal_chat_message_metadata_passthrough.create_time, content_item_kinds: fragments.map(() => 'unknown'), content_item_metadata: fragments.map(() => ({ provenance: { type: 'harness', hook: true } })) } })
    const model = requests[pass + 1].body.input.filter(value => value.type === 'message' && value.id === event.item.id)
    assert.deepEqual(model, [{ type: 'message', id: event.item.id, role: 'user', content }])
    const assistant = rows.findIndex(value => value.type === 'response_item' && value.payload.role === 'assistant' && value.payload.content.some(part => part.text === 'NATIVE_STOP_ANSWER_' + (pass + 1)))
    assert.ok(assistant >= 0 && assistant < rows.indexOf(response) && rows.indexOf(response) < rows.indexOf(row))
    const nextAssistant = rows.findIndex(value => value.type === 'response_item' && value.payload.role === 'assistant' && value.payload.content.some(part => part.text === 'NATIVE_STOP_ANSWER_' + (pass + 2)))
    assert.ok(rows.indexOf(row) < nextAssistant)
    assert.ok(requests[pass + 1].time >= Math.max(...ends.filter(value => value.ordinal === pass).map(value => value.time)))
  }
  return { mode: scenario.name, modelRequests: requests.length, stopInvocations: starts.length, stableRegistrationRunIDs: true, configuredFragmentOrder: true, nativeEscaping: true, rolloutHarnessProvenance: true, sourceBytesUnchanged: true }
}
