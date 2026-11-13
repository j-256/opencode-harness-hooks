import assert from 'node:assert/strict'
import { test } from 'node:test'
import { inspectResumeTranscript, compareResumeEvidence } from '../scripts/lib/conformance-resume.mjs'

const options = { dialect: 'claude-code', sessionID: 'session', callID: 'call', original: 'original' }
const rows = [{ type: 'assistant', sessionId: 'session', message: { content: [{ type: 'tool_use', id: 'call', input: { command: 'original' } }] } }]
test('resume observations require an owned historical original input instead of the effective input or matching text', () => {
  assert.equal(inspectResumeTranscript(rows, options), true)
  assert.equal(inspectResumeTranscript([{ ...rows[0], sessionId: 'foreign' }], options), false)
  assert.equal(inspectResumeTranscript([{ ...rows[0], message: { content: [{ type: 'tool_use', id: 'call', input: { command: 'effective' } }] } }], options), false)
  assert.equal(inspectResumeTranscript([{ type: 'assistant', text: 'original' }], options), false)
  const codex = [{ type: 'session_meta', payload: { id: 'session' } }, { type: 'response_item', payload: { type: 'function_call', call_id: 'call', arguments: '{"cmd":"original"}' } }]
  assert.equal(inspectResumeTranscript(codex, { ...options, dialect: 'codex' }), true)
  assert.equal(inspectResumeTranscript(codex, { ...options, dialect: 'codex', callID: 'other' }), false)
})
test('resume comparison fails when either runtime lacks independent session, prefix or original-input evidence', () => {
  const proof = { sessionRetained: true, prefixRetained: true, originalRetained: true }
  assert.equal(compareResumeEvidence(proof, proof).match, true)
  for (const field of Object.keys(proof)) assert.equal(compareResumeEvidence(proof, { ...proof, [field]: false }).match, false)
  assert.equal(compareResumeEvidence({}, proof).match, false)
})
