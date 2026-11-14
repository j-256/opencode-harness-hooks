import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { BackgroundRecords } from '../src/background-records.js'
import { BACKGROUND_REQUEST_HEADER, V1BackgroundProjection } from '../src/hosts/background-projection-v1.js'
import { MODEL_REQUEST_HEADER } from '../src/hosts/model-v1.js'
import { Sessions } from '../src/sessions.js'
import type { BackgroundDelivery } from '../src/background-types.js'
import type { Registration } from '../src/types.js'

const digest = 'a'.repeat(64)
const registrations: readonly Registration[] = ['claude-code', 'codex'].map(dialect => ({ id: dialect, sourceID: dialect, sourceDigest: digest, dialect: dialect as Registration['dialect'], event: 'UserPromptSubmit', groupIndex: 0, handlerIndex: 0, handler: { type: 'command', command: 'fixture', async: true } }))
const reminder = '<system-reminder>\nCLAUDE_BACKGROUND\n</system-reminder>'
const user = (id: string, text = 'Same') => ({ info: { role: 'user', id, sessionID: 'session' }, parts: [{ type: 'text', text }] })
const tool = (parentID: string, id = 'answer', callID = 'call', output = 'Original tool output') => ({ info: { role: 'assistant', id, parentID, sessionID: 'session' }, parts: [{ type: 'tool', tool: 'bash', callID, state: { status: 'completed', output } }] })
const request = (value: unknown, token?: string) => new Request('https://provider.invalid/v1/chat/completions', { method: 'POST', headers: { authorization: 'Bearer fixture', ...(token ? { [BACKGROUND_REQUEST_HEADER]: token } : {}) }, body: JSON.stringify(value) })
function delivery(dialect: 'claude-code' | 'codex', id: string = dialect): BackgroundDelivery { return { id, sourceID: dialect, sourceDigest: digest, registrationID: dialect, dialect, event: 'UserPromptSubmit', mode: 'safe-point', actions: [{ kind: 'context', placement: 'model', text: 'CODEX_BACKGROUND' }, ...(dialect === 'codex' ? [{ kind: 'warning' as const, text: 'UI_ONLY' }] : [])], completion: { completedAt: 1700000000000, execution: { status: 'exited', exitCode: 0, signal: null, durationMs: 1, processID: 12345, stdout: '{"systemMessage":"CLAUDE_BACKGROUND"}', stderr: '' } } } }
function fixture(t: { after(callback: () => void): void }) {
  const sessions = new Sessions(), records = new BackgroundRecords({ registrations }); sessions.prompt('session', 'first')
  let prepared = 0, beforePrepare: (() => void) | undefined
  const projection = new V1BackgroundProjection({ records, prepare: async (session, anchor) => { prepared++; beforePrepare?.(); records.reserveBind(session, anchor).commit() } })
  t.after(() => { projection.dispose(); records.dispose(); sessions.dispose() })
  return { sessions, records, projection, owner: () => sessions.get('session'), prepared: () => prepared, beforePrepare: (operation: () => void) => { beforePrepare = operation } }
}

test('late mixed completions overlay only the owned tool carrier with distinct native channels and retry stability', async t => {
  const f = fixture(t), messages = [user('first'), tool('first')]
  f.projection.capture(f.owner(), messages)
  const token = f.projection.issue(f.owner(), 'provider', 'openai')
  f.beforePrepare(() => { f.records.admit(f.owner(), delivery('claude-code')); f.records.admit(f.owner(), delivery('codex')) })
  const input = { model: 'fixture', stream: true, messages: [{ role: 'system', content: 'Instructions' }, { role: 'user', content: 'Same' }, { role: 'assistant', tool_calls: [{ id: 'call' }] }, { role: 'tool', tool_call_id: 'call', content: 'Original tool output', extra: true }] }
  const original = request(input, token), projected = await f.projection.project(original, token, 'provider'), actual = await projected.clone().json()
  assert.deepEqual(actual, { ...input, messages: [...input.messages.slice(0, -1), { ...input.messages.at(-1), content: 'Original tool output\n\n' + reminder }, { role: 'developer', content: 'CODEX_BACKGROUND' }] })
  assert.equal(projected.headers.get('authorization'), 'Bearer fixture'); assert.equal(projected.headers.has(BACKGROUND_REQUEST_HEADER), false)
  assert.deepEqual(await original.json(), input); assert.equal((messages[1] as ReturnType<typeof tool>).parts[0]!.state.output, 'Original tool output')
  assert.equal(f.records.read(f.owner())[0]!.anchor!.kind, 'tool')
  assert.deepEqual(await (await f.projection.project(projected, token, 'provider')).json(), actual)
  assert.deepEqual(await (await f.projection.project(request(input), token, 'provider')).json(), actual)
  assert.equal(f.prepared(), 1); assert.equal(JSON.stringify(actual).includes('UI_ONLY'), false)
})

test('identical prompts retain different anchor positions, including normal prompt-context prefixes and cold history', async t => {
  const f = fixture(t)
  f.records.admit(f.owner(), delivery('claude-code'))
  f.projection.capture(f.owner(), [user('first')])
  const first = f.projection.issue(f.owner(), 'provider', 'openai')
  await f.projection.project(request({ messages: [{ role: 'user', content: 'Same' }] }), first, 'provider')
  f.sessions.prompt('session', 'second')
  f.projection.capture(f.owner(), [user('first'), { info: { role: 'assistant', id: 'answer', parentID: 'first', sessionID: 'session' }, parts: [{ type: 'text', text: 'Previous' }] }, user('second')])
  f.records.admit(f.owner(), delivery('codex'))
  const second = f.projection.issue(f.owner(), 'provider', 'openai')
  const input = { messages: [{ role: 'user', content: 'Same' }, { role: 'assistant', content: 'Previous' }, { role: 'user', content: [{ type: 'text', text: 'Foreground reminder' }, { type: 'text', text: 'Same', cache_control: { type: 'ephemeral' } }] }] }
  const actual = await (await f.projection.project(request(input), second, 'provider')).json()
  assert.deepEqual(actual.messages, [{ role: 'user', content: [{ type: 'text', text: reminder + '\n' }, { type: 'text', text: 'Same' }] }, input.messages[1], input.messages[2], { role: 'developer', content: 'CODEX_BACKGROUND' }])
  const cold = new BackgroundRecords(); t.after(() => cold.dispose()); cold.restoreV1(f.owner(), f.records.snapshotV1('session'))
  const replay = new V1BackgroundProjection({ records: cold, prepare: async () => {} }); t.after(() => replay.dispose())
  replay.capture(f.owner(), [user('first'), { info: { role: 'assistant', id: 'answer', parentID: 'first', sessionID: 'session' }, parts: [] }, user('second')])
  assert.deepEqual(await (await replay.project(request(input), replay.issue(f.owner(), 'provider', 'openai'), 'provider')).json(), actual)
})

for (const protocol of ['responses', 'anthropic'] as const) test(`${protocol} preserves its tool-result envelope and unrelated payload`, async t => {
  const f = fixture(t); f.records.admit(f.owner(), delivery('claude-code')); f.projection.capture(f.owner(), [user('first'), tool('first')])
  const token = f.projection.issue(f.owner(), 'provider', protocol === 'anthropic' ? 'anthropic' : 'openai')
  const rows = protocol === 'responses' ? [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Same' }] }, { type: 'function_call', call_id: 'call', arguments: '{}' }, { type: 'function_call_output', call_id: 'call', output: 'Original tool output' }] : [{ role: 'user', content: 'Same' }, { role: 'assistant', content: [{ type: 'tool_use', id: 'call', name: 'bash', input: {} }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call', content: 'Original tool output', is_error: false }] }]
  const field = protocol === 'responses' ? 'input' : 'messages', input = { [field]: rows, metadata: { fixture: true } }
  const output = await (await f.projection.project(request(input), token, 'provider')).json()
  assert.deepEqual(output[field].slice(0, 2), rows.slice(0, 2)); assert.deepEqual(output.metadata, input.metadata)
  assert.equal(protocol === 'responses' ? output.input[2].output : output.messages[2].content[0].content, 'Original tool output\n\n' + reminder)
})

test('foreign providers, changed tool output, duplicate calls, pruned or changed prompts and reused host IDs reject without acknowledging', async t => {
  for (const mode of ['provider', 'tool', 'duplicate', 'pruned', 'prompt'] as const) {
    const f = fixture(t); f.records.admit(f.owner(), delivery('claude-code')); f.projection.capture(f.owner(), [user('first'), tool('first')])
    const token = f.projection.issue(f.owner(), 'provider', 'openai')
    const rows: unknown[] = [{ role: 'user', content: mode === 'prompt' ? 'Changed' : 'Same' }, { role: 'tool', tool_call_id: 'call', content: mode === 'tool' ? 'Changed' : 'Original tool output' }]
    if (mode === 'pruned') rows.shift(); if (mode === 'duplicate') rows.push(rows[1])
    await assert.rejects(f.projection.project(request({ messages: rows }), token, mode === 'provider' ? 'foreign' : 'provider'))
    assert.equal(f.prepared(), 0); assert.equal(f.records.read(f.owner())[0]!.anchor, undefined)
  }
  const f = fixture(t)
  assert.throws(() => f.projection.capture(f.owner(), [user('first'), user('first')]))
  assert.throws(() => f.projection.capture(f.owner(), [user('first'), { ...tool('first'), info: { ...tool('first').info, sessionID: 'foreign' } }]))
})

test('cancellation, deletion and disposal invalidate tickets while request variants and metadata stay bounded', async t => {
  const f = fixture(t); f.projection.capture(f.owner(), [user('first')]); const token = f.projection.issue(f.owner(), 'provider', 'openai')
  f.sessions.prompt('session', 'second')
  await assert.rejects(f.projection.project(request({ messages: [{ role: 'user', content: 'Same' }] }), token, 'provider'))
  f.projection.capture(f.owner(), [user('first'), user('second')]); const next = f.projection.issue(f.owner(), 'provider', 'openai')
  f.projection.removeSession('session'); assert.equal(f.projection.owner(next), undefined); assert.equal(f.projection.inspect().tickets, 0)
  f.projection.dispose(); assert.throws(() => f.projection.capture(f.owner(), [user('first'), user('second')]))
  const small = new V1BackgroundProjection({ records: f.records, prepare: async () => {}, maxBytes: 64 }); t.after(() => small.dispose())
  assert.throws(() => small.capture(f.owner(), [user('first'), user('second')]), { code: 'HOST_BACKGROUND_LIMIT' })
  assert.equal(small.inspect().layouts, 0)
})

test('a failed persistence barrier leaves delivery unbound and retryable; ticket retries do not absorb later completions', async t => {
  const sessions = new Sessions(), records = new BackgroundRecords({ registrations }); sessions.prompt('session', 'first'); const owner = sessions.get('session')
  let fail = true
  const projection = new V1BackgroundProjection({ records, prepare: async (session, anchor) => { const reservation = records.reserveBind(session, anchor); if (fail) { reservation.release(); throw new Error('Checkpoint failed') }; reservation.commit() } })
  t.after(() => { projection.dispose(); records.dispose(); sessions.dispose() })
  records.admit(owner, delivery('claude-code')); projection.capture(owner, [user('first')]); const token = projection.issue(owner, 'provider', 'openai')
  const input = { messages: [{ role: 'user', content: 'Same' }] }
  await assert.rejects(projection.project(request(input), token, 'provider'), /Checkpoint failed/); assert.equal(records.read(owner)[0]!.anchor, undefined)
  fail = false; const first = await (await projection.project(request(input), token, 'provider')).json(); records.admit(owner, delivery('codex'))
  assert.deepEqual(await (await projection.project(request(input), token, 'provider')).json(), first)
  assert.equal(records.read(owner)[1]!.anchor, undefined)
  assert.equal(records.read(owner)[0]!.anchor!.signature, createHash('sha256').update(JSON.stringify(['Same'])).digest('hex'))
})

test('multiple Claude completions retain completion order at one prompt rather than reversing prefixes', async t => {
  const f = fixture(t)
  f.records.admit(f.owner(), delivery('claude-code'))
  const second = delivery('claude-code', 'second'), third = delivery('claude-code', 'third')
  f.records.admit(f.owner(), { ...second, completion: { ...second.completion!, execution: { ...second.completion!.execution, stdout: '{"systemMessage":"SECOND","hookSpecificOutput":{"additionalContext":"THIRD"}}' } } })
  f.records.admit(f.owner(), { ...third, completion: { ...third.completion!, execution: { ...third.completion!.execution, stdout: '{"systemMessage":"FOURTH"}' } } })
  f.projection.capture(f.owner(), [user('first')])
  const output = await (await f.projection.project(request({ messages: [{ role: 'user', content: [{ type: 'text', text: 'Same' }] }] }), f.projection.issue(f.owner(), 'provider', 'openai'), 'provider')).json()
  assert.deepEqual(output.messages[0].content.map((part: { text: string }) => part.text), [reminder, ...['SECOND', 'THIRD', 'FOURTH'].map((text, index) => '<system-reminder>\n' + text + '\n</system-reminder>' + (index === 2 ? '\n' : '')), 'Same'])
})

test('the last Claude reminder text part separates the next genuine prompt with the native newline', async t => {
  const f = fixture(t); f.records.admit(f.owner(), delivery('claude-code')); f.projection.capture(f.owner(), [user('first')])
  const output = await (await f.projection.project(request({ messages: [{ role: 'user', content: 'Same' }] }), f.projection.issue(f.owner(), 'provider', 'openai'), 'provider')).json()
  assert.deepEqual(output.messages[0].content, [{ type: 'text', text: '<system-reminder>\nCLAUDE_BACKGROUND\n</system-reminder>\n' }, { type: 'text', text: 'Same' }])
})

test('internal evaluator tickets and unsupported Codex roles cannot bind or expose pending output', async t => {
  const f = fixture(t); f.records.admit(f.owner(), delivery('codex')); f.projection.capture(f.owner(), [user('first')])
  const token = f.projection.issue(f.owner(), 'provider', 'anthropic'), original = request({ messages: [{ role: 'user', content: 'Same' }] })
  await assert.rejects(f.projection.project(original, token, 'provider'), { code: 'HOST_BACKGROUND_ROLE_UNAVAILABLE' })
  original.headers.set(MODEL_REQUEST_HEADER, 'private-evaluator')
  await assert.rejects(f.projection.project(original, token, 'provider'), { code: 'HOST_BACKGROUND_REQUEST_UNAVAILABLE' })
  assert.equal(f.prepared(), 0); assert.equal(f.records.read(f.owner())[0]!.anchor, undefined)
})

test('recaptured modified host identities and wire shape ambiguity fail without substituting another carrier', async t => {
  const f = fixture(t); f.projection.capture(f.owner(), [user('first'), tool('first')])
  assert.throws(() => f.projection.capture(f.owner(), [user('first'), tool('first', 'answer', 'call', 'Changed')]), { code: 'HOST_BACKGROUND_LAYOUT_CHANGED' })
  for (const content of [[{ type: 'image', data: 'opaque' }], [{ type: 'text', text: 'Same' }, { type: 'text', text: 'Unexpected suffix' }]]) {
    const token = f.projection.issue(f.owner(), 'provider', 'openai')
    await assert.rejects(f.projection.project(request({ messages: [{ role: 'user', content }, { role: 'tool', tool_call_id: 'call', content: 'Original tool output' }] }), token, 'provider'))
  }
  assert.equal(f.prepared(), 0)
})

test('held transport readers are bounded and disposal cancels every owned projection without binding output', { timeout: 3000 }, async t => {
  const f = fixture(t); f.projection.capture(f.owner(), [user('first')]); const token = f.projection.issue(f.owner(), 'provider', 'openai')
  const requests = Array.from({ length: 16 }, () => new Request('https://provider.invalid', { method: 'POST', body: new ReadableStream(), duplex: 'half' } as RequestInit))
  const outcomes = requests.map(input => f.projection.project(input, token, 'provider').then(() => 'fulfilled', error => error.code))
  await new Promise(resolve => setImmediate(resolve))
  f.projection.dispose()
  const result = await Promise.all(outcomes)
  assert.ok(result.includes('HOST_BACKGROUND_LIMIT')); assert.ok(result.includes('HOST_BACKGROUND_CANCELLED')); assert.equal(f.projection.inspect().pending, 0)
  assert.equal(f.prepared(), 0)
})

test('Claude wire formatting preserves the captured native prompt part boundaries and tool reminder separators', async t => {
  const capture = JSON.parse(readFileSync(new URL('./fixtures/claude-background-artifacts-oracle.json', import.meta.url), 'utf8'))
  const output = capture.cases.find((row: { name: string }) => row.name === 'pretty').stdout, expected = capture.deliveryFormatting
  for (const kind of ['tool', 'prompt'] as const) {
    const f = fixture(t), original = delivery('claude-code')
    f.records.admit(f.owner(), { ...original, completion: { ...original.completion!, execution: { ...original.completion!.execution, stdout: output } } })
    f.projection.capture(f.owner(), kind === 'prompt' ? [user('first', expected.promptOriginal)] : [user('first'), tool('first')])
    const input = kind === 'prompt' ? [{ role: 'user', content: expected.promptOriginal }] : [{ role: 'user', content: 'Same' }, { role: 'tool', tool_call_id: 'call', content: 'Original tool output' }]
    const result = await (await f.projection.project(request({ messages: input }), f.projection.issue(f.owner(), 'provider', 'openai'), 'provider')).json()
    assert.deepEqual(result.messages.at(-1).content, kind === 'prompt' ? expected.promptParts : 'Original tool output' + expected.toolSuffix)
  }
})
