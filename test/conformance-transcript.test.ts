import assert from 'node:assert/strict'
import { test } from 'node:test'

test('the independent Codex transcript observer requires real prompt, call and identity records', async () => {
  const { inspectCodexTranscript } = await import(new URL('../scripts/lib/conformance-transcript.mjs', import.meta.url).href)
  const input = { session_id: '11111111-1111-5111-8111-111111111111', turn_id: '22222222-2222-5222-8222-222222222222', tool_use_id: 'owned', tool_input: { command: 'original' } }
  const rows = [
    { type: 'session_meta', payload: { id: input.session_id, session_id: input.session_id } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Owned prompt' }] } },
    { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'owned', arguments: '{"cmd":"original"}', internal_chat_message_metadata_passthrough: { turn_id: input.turn_id } } },
  ]
  assert.equal(inspectCodexTranscript(rows, input, 'Owned prompt'), true)
  for (const mutate of [
    (r: any[]) => { r[0].payload.id = 'other' },
    (r: any[]) => { r[1].payload.content[0].text = 'Other prompt' },
    (r: any[]) => { r[2].payload.call_id = 'other' },
    (r: any[]) => { r[2].payload.arguments = '{"cmd":"effective"}' },
    (r: any[]) => { r[2].payload.internal_chat_message_metadata_passthrough.turn_id = 'other' },
    (r: any[]) => { r.push({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'owned', output: 'Too early' } }) },
    (r: any[]) => { r.push(r[2]) },
  ]) {
    const value = structuredClone(rows); mutate(value)
    assert.equal(inspectCodexTranscript(value, input, 'Owned prompt'), false)
  }
  assert.equal(inspectCodexTranscript([], input, 'Owned prompt'), false)
})

test('Codex control success additionally requires content and native-reader checks', async () => {
  const { compareControlObservations } = await import(new URL('../scripts/lib/conformance.mjs', import.meta.url).href)
  const trace = () => ({ sourceDigest: 'a'.repeat(64), hookDigest: 'b'.repeat(64), controls: ['deny', 'allow'].map(id => ({ id, hookInvocations: 1, event: 'PreToolUse', tool: 'Bash', cwdMatches: true, commandMatches: true, identityValid: true, transcriptExists: true, resultOwned: true, reasonDelivered: id === 'deny', sideEffect: id === 'allow', primaryModelCalls: 2, transcriptContentValid: true, nativeReaderAccepted: true })) })
  const native = trace(), host = trace()
  assert.equal(compareControlObservations(native, host, { codexTranscript: true }).match, true)
  host.controls[0]!.transcriptContentValid = false
  assert.throws(() => compareControlObservations(native, host, { codexTranscript: true }), /host.deny.transcriptContentValid/)
  host.controls[0]!.transcriptContentValid = true
  host.controls[0]!.nativeReaderAccepted = false
  assert.throws(() => compareControlObservations(native, host, { codexTranscript: true }), /host.deny.nativeReaderAccepted/)
})
