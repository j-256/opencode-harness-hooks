import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { BackgroundRecords } from '../src/background-records.js'
import { ClaudeTranscript } from '../src/transcript.js'
import { CodexTranscript } from '../src/codex-transcript.js'
import { Sessions } from '../src/sessions.js'
import type { BackgroundDelivery } from '../src/background-types.js'
import type { Registration } from '../src/types.js'
import type { HostToolEvent } from '../src/tool-types.js'

const created = 1700000000000, digest = 'a'.repeat(64)
const event = (callID: string): HostToolEvent => ({ host: 'v1', event: 'PreToolUse', sessionID: 'session', callID, tool: 'bash', toolInput: { command: 'original' }, effectiveInput: { command: 'effective' }, signal: new AbortController().signal })
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const user = { info: { role: 'user', id: 'turn', sessionID: 'session', time: { created } }, parts: [{ type: 'text', text: 'Original prompt' }] }
function tool(id: string, callID: string, output = 'Original result') { return { info: { role: 'assistant', id, parentID: 'turn', sessionID: 'session', modelID: 'fixture', time: { created: created + 1 } }, parts: [{ type: 'tool', tool: 'bash', callID, state: { status: 'completed', input: { command: 'effective' }, output, time: { start: created + 2, end: created + 3 } } }] } }
function fixture(dialect: 'claude-code' | 'codex') {
  const registration: Registration = { id: 'hook', sourceID: 'source', sourceDigest: digest, dialect, event: 'UserPromptSubmit', groupIndex: 0, handlerIndex: 0, handler: { type: 'command', command: 'fixture', async: true } }
  const delivery: BackgroundDelivery = { id: 'job', sourceID: 'source', sourceDigest: digest, registrationID: 'hook', dialect, event: 'UserPromptSubmit', mode: 'safe-point', actions: [{ kind: 'context', placement: 'model', text: 'BACKGROUND_CONTEXT' }], completion: { completedAt: created + 4, execution: { status: 'exited', exitCode: 0, signal: null, durationMs: 1, processID: 12345, stdout: '{"systemMessage":"BACKGROUND_CONTEXT","continue":false}', stderr: 'Original stderr' } } }
  const sessions = new Sessions(), records = new BackgroundRecords({ registrations: [registration] }); sessions.prompt('session', 'turn')
  return { sessions, records, delivery, owner: () => sessions.get('session') }
}
const rows = async (path: string) => (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line))

for (const controlOnly of [false, true]) for (const anchor of ['prompt', 'tool'] as const) test(`Claude ${anchor} background attachments preserve raw native evidence and original history through repeated and cold preparation, non-rendering ${controlOnly}`, async t => {
  const f = fixture('claude-code'), history = [structuredClone(user), tool('answer', 'old'), tool('next-answer', 'next')]
  const delivery = controlOnly ? { ...f.delivery, actions: [], completion: { ...f.delivery.completion!, execution: { ...f.delivery.completion!.execution, stdout: '{"continue":false}' } } } : f.delivery
  f.records.admit(f.owner(), delivery)
  f.records.reserveBind(f.owner(), anchor === 'prompt' ? { kind: 'prompt', sessionID: 'session', turnID: 'turn', messageID: 'turn', signature: hash(JSON.stringify(['Original prompt'])) } : { kind: 'tool', sessionID: 'session', turnID: 'turn', messageID: 'answer', callID: 'old', signature: hash('Original result') }).commit()
  const transcript = new ClaudeTranscript({ host: 'v1', directory: '/project', background: f.records, history: async () => ({ id: 'session', messages: history }) })
  t.after(async () => { await transcript.dispose(); f.records.dispose(); f.sessions.dispose() })
  transcript.observeModel({ host: 'v1', sessionID: 'session', messageID: 'turn', signal: f.owner().turnSignal }, f.owner())
  transcript.observe(event('old'), f.owner()); transcript.observe(event('next'), f.owner())
  const path = await transcript.prepare(event('next'), f.owner(), f.owner().turnSignal), actual = await rows(path)
  const index = actual.findIndex(row => row.attachment?.type === 'async_hook_response')
  assert.ok(index > 0)
  const attachment = actual[index]!.attachment
  assert.equal(attachment.processId, 'async_hook_12345'); assert.equal(attachment.stdout, delivery.completion!.execution.stdout); assert.equal(attachment.stderr, 'Original stderr'); assert.equal(attachment.response.continue, false)
  const prior = anchor === 'prompt' ? actual.slice(0, index).findLast(row => row.type === 'user')! : actual[index - 1]!
  assert.equal(anchor === 'prompt' ? prior.message.content : prior.message.content[0].content, anchor === 'prompt' ? 'Original prompt' : 'Original result')
  assert.deepEqual(actual[index]!.rendered, controlOnly ? undefined : [{ content: '<system-reminder>\nBACKGROUND_CONTEXT\n</system-reminder>' }])
  assert.equal(actual[index + 1]!.parentUuid, actual[index]!.uuid)
  await transcript.prepare(event('next'), f.owner(), f.owner().turnSignal); assert.deepEqual(await rows(path), actual)
  const coldRecords = new BackgroundRecords(); coldRecords.restoreV1(f.owner(), f.records.snapshotV1('session'))
  const cold = new ClaudeTranscript({ host: 'v1', directory: '/project', background: coldRecords, history: async () => ({ id: 'session', messages: history }) })
  t.after(async () => { await cold.dispose(); coldRecords.dispose() }); cold.restoreV1(f.owner(), transcript.snapshotV1('session'))
  assert.deepEqual(await rows(await cold.prepare(event('next'), f.owner(), f.owner().turnSignal)), actual)
  const changedUser = history[0] as typeof user; changedUser.parts[0]!.text = 'Changed prompt'
  if (anchor === 'tool') (history[1] as ReturnType<typeof tool>).parts[0]!.state.output = 'Changed result'
  await assert.rejects(transcript.prepare(event('next'), f.owner(), f.owner().turnSignal)); assert.deepEqual(await rows(path), actual)
})

for (const anchor of ['prompt', 'tool'] as const) test(`Codex background developer records follow the bound ${anchor} with hook provenance and survive cold replay`, async t => {
  const f = fixture('codex')
  const history = { id: 'session', messages: [{ id: 'turn', turnID: 'turn', role: 'user' as const, created, content: ['Original prompt'] }, { id: 'answer', turnID: 'turn', role: 'assistant' as const, created: created + 1, content: [{ id: 'old', name: 'bash', status: 'completed' as const, created: created + 2, completed: created + 3, output: 'Original result' }] }, { id: 'next-answer', turnID: 'turn', role: 'assistant' as const, created: created + 5, content: [{ id: 'next', name: 'bash', status: 'running' as const, created: created + 5 }] }] }
  f.records.admit(f.owner(), f.delivery); f.records.reserveBind(f.owner(), anchor === 'prompt' ? { kind: 'prompt', sessionID: 'session', turnID: 'turn', messageID: 'turn', signature: hash(JSON.stringify(['Original prompt'])) } : { kind: 'tool', sessionID: 'session', turnID: 'turn', messageID: 'answer', callID: 'old', signature: hash('Original result') }).commit()
  const transcript = new CodexTranscript({ host: 'v1', directory: '/project', background: f.records, history: async () => history })
  t.after(async () => { await transcript.dispose(); f.records.dispose(); f.sessions.dispose() }); transcript.observe(event('old'), f.owner()); transcript.observe(event('next'), f.owner())
  const view = await transcript.prepare(event('next'), f.owner(), f.owner().turnSignal), actual = await rows(view.transcriptPath), index = actual.findIndex(row => row.payload?.role === 'developer')
  assert.ok(index > 0); assert.equal(actual[index - 1]!.payload.type, anchor === 'tool' ? 'function_call_output' : 'user_message'); if (anchor === 'tool') assert.equal(actual[index - 1]!.payload.output, 'Original result')
  assert.equal(actual[index]!.payload.content[0].text, 'BACKGROUND_CONTEXT'); assert.equal(actual[index + 1]!.payload.type, 'function_call')
  assert.deepEqual(actual[index]!.payload.internal_chat_message_metadata_passthrough, { turn_id: view.turnID, create_time: (created + 4) / 1000, content_item_kinds: ['hooks.additional_context'], content_item_metadata: [{ provenance: { type: 'harness', hook: true } }] })
  await transcript.prepare(event('next'), f.owner(), f.owner().turnSignal); assert.deepEqual(await rows(view.transcriptPath), actual)
  const coldRecords = new BackgroundRecords(); coldRecords.restoreV1(f.owner(), f.records.snapshotV1('session'))
  const cold = new CodexTranscript({ host: 'v1', directory: '/project', background: coldRecords, history: async () => history }); t.after(async () => { await cold.dispose(); coldRecords.dispose() }); cold.restoreV1(f.owner(), transcript.snapshotV1('session'))
  const next = await cold.prepare(event('next'), f.owner(), f.owner().turnSignal); assert.deepEqual(await rows(next.transcriptPath), actual)
})
