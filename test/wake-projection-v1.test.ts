import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { BackgroundRecords } from '../src/background-records.js'
import type { BackgroundAnchor } from '../src/background-records.js'
import { V1BackgroundProjection } from '../src/hosts/background-projection-v1.js'
import { WakeRecords } from '../src/wake-records.js'
import { Sessions } from '../src/sessions.js'
import { executeRegistration } from '../src/handlers.js'
import type { DispatchResult } from '../src/engine.js'
import type { Registration } from '../src/types.js'
import type { BackgroundDelivery } from '../src/background-types.js'

const OUTPUT = 'ORIGINAL_TOOL_RESULT', GENUINE = 'GENUINE_PROMPT'
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const request = (body: unknown) => new Request('https://provider.invalid/request', { method: 'POST', headers: { authorization: 'Bearer synthetic' }, body: JSON.stringify(body) })
async function fixture(t: { after(callback: () => unknown): void }, kind: 'active' | 'idle') {
  const source: Registration = { id: 'wake', sourceID: 'source', sourceDigest: 'a'.repeat(64), dialect: 'claude-code', event: 'UserPromptSubmit', groupIndex: 0, handlerIndex: 0, handler: { type: 'command', command: 'owned', asyncRewake: true } }
  const sessions = new Sessions(), wakes = new WakeRecords({ registrations: [source] }), records = new BackgroundRecords()
  t.after(() => { wakes.dispose(); records.dispose(); sessions.dispose() }); sessions.prompt('session', 'turn', 'model'); const session = sessions.get('session')
  const delivery: BackgroundDelivery = { id: 'job', sourceID: 'source', sourceDigest: source.sourceDigest!, registrationID: 'wake', dialect: 'claude-code', event: 'UserPromptSubmit', mode: 'wake', actions: [{ kind: 'native-extension', name: 'asyncRewake', value: 'OWNED_WAKE' }], completion: { completedAt: 1700000000000, execution: { status: 'exited', exitCode: 2, signal: null, stdout: '', stderr: 'OWNED_WAKE', durationMs: 1, processID: 123 } } }
  wakes.admit(session, delivery); const text = wakes.read(session)[0]!.text
  const anchor: BackgroundAnchor = kind === 'active' ? { kind: 'tool', sessionID: 'session', turnID: 'turn', messageID: 'answer', callID: 'call', signature: hash(OUTPUT) } : { kind: 'prompt', sessionID: 'session', turnID: 'turn', messageID: 'turn', signature: hash(JSON.stringify([text.prompt])) }
  const attempt = wakes.begin(session, 'job', anchor), event = { host: 'v1' as const, event: 'UserPromptSubmit' as const, sessionID: 'session', messageID: 'turn', prompt: text.prompt, signal: session.turnSignal, notificationID: attempt.id, anchor }
  const output = JSON.stringify({ systemMessage: 'UI_ONLY', hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'CALLBACK_CONTEXT' } })
  const result = await executeRegistration({ ...source, id: 'callback', handler: { type: 'command', command: "printf '%s' '" + output + "'" } }, { host: 'v1', event: 'UserPromptSubmit', sessionID: 'session', cwd: process.cwd(), data: { prompt: text.prompt, transcript_path: '/unused', permission_mode: 'default' } }, { projectRoot: process.cwd(), environment: {}, captureCommandArtifacts: true })
  const origin = { sourceID: 'source', sourceDigest: source.sourceDigest!, registrationID: 'callback', dialect: 'claude-code' as const, configuredOrder: 0, completionOrder: 0 }
  const dispatch: DispatchResult = { entries: [{ ...origin, result }], actions: result.actions.map(action => ({ ...origin, action })), cancelled: false, diagnostic: { dispatchID: 'dispatch', sessionID: 'session', event: 'UserPromptSubmit', durationMs: 1, cancelled: false, failed: 0, unsupported: 0, skipped: 0, background: 0, handlers: [] } }
  wakes.capture(session, event, dispatch)
  wakes.reserveBind(session, 'job', attempt.id, anchor, kind === 'active' ? { kind: 'queued', human: false } : { kind: 'system', promptIndex: 0, turnIndex: 2 }).commit()
  const projection = new V1BackgroundProjection({ records, wakes, prepare: async () => {} }); t.after(() => projection.dispose())
  const history = [{ info: { role: 'user', id: 'turn', sessionID: 'session' }, parts: [{ type: 'text', text: kind === 'active' ? GENUINE : text.prompt }] }, ...(kind === 'active' ? [{ info: { role: 'assistant', id: 'answer', parentID: 'turn', sessionID: 'session' }, parts: [{ type: 'tool', callID: 'call', state: { status: 'completed', output: OUTPUT } }] }] : [])]
  projection.capture(session, history)
  return { session, wakes, records, projection, history, text, binding: wakes.read(session)[0]!.binding! }
}

for (const protocol of ['openai', 'responses', 'anthropic'] as const) test(`active wake model text follows the original ${protocol} tool result without changing host history`, async t => {
  const f = await fixture(t, 'active'), token = f.projection.issue(f.session, 'provider', protocol === 'anthropic' ? 'anthropic' : 'openai')
  const carrier = protocol === 'responses' ? { type: 'function_call_output', call_id: 'call', output: OUTPUT } : protocol === 'anthropic' ? { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call', content: OUTPUT, is_error: false }] } : { role: 'tool', tool_call_id: 'call', content: OUTPUT }
  const field = protocol === 'responses' ? 'input' : 'messages', input = { [field]: [{ role: 'user', content: GENUINE }, carrier], extra: true }
  const original = request(input), projected = await f.projection.project(original, token, 'provider'), actual = await projected.clone().json()
  const value = protocol === 'responses' ? actual.input[1].output : protocol === 'anthropic' ? actual.messages[1].content[0].content : actual.messages[1].content
  assert.equal(value, OUTPUT + '\n\n' + f.binding.model.join('\n\n')); assert.ok(!value.includes('UI_ONLY'))
  assert.deepEqual(await original.json(), input); assert.equal((f.history[1]!.parts[0] as any).state.output, OUTPUT)
  assert.equal(projected.headers.get('authorization'), 'Bearer synthetic'); assert.equal(actual.extra, true)
  assert.deepEqual(await (await f.projection.project(projected, token, 'provider')).json(), actual)
  assert.deepEqual(await (await f.projection.project(request(input), token, 'provider')).json(), actual)
})

test('idle wake projection replaces only its owned raw notification and preserves native callback prefix ordering and metadata', async t => {
  const f = await fixture(t, 'idle'), token = f.projection.issue(f.session, 'provider', 'anthropic')
  const original = { type: 'text', text: f.text.prompt, cache_control: { type: 'ephemeral' } }, input = { messages: [{ role: 'user', content: [original], extra: 'retained' }] }
  const actual = await (await f.projection.project(request(input), token, 'provider')).json()
  assert.deepEqual(actual.messages[0], { role: 'user', extra: 'retained', content: [{ type: 'text', text: '<system-reminder>\nUserPromptSubmit hook additional context: CALLBACK_CONTEXT\n</system-reminder>\n' }, { ...original, text: f.text.model }] })
  const first = f.history[0]!.parts[0]!; assert.ok('text' in first); assert.equal(first.text, f.text.prompt)
  const cold = new WakeRecords(); t.after(() => cold.dispose()); cold.restoreV1(f.session, f.wakes.snapshotV1('session'))
  const replay = new V1BackgroundProjection({ records: f.records, wakes: cold, prepare: async () => {} }); t.after(() => replay.dispose()); replay.capture(f.session, f.history)
  assert.deepEqual(await (await replay.project(request(input), replay.issue(f.session, 'provider', 'anthropic'), 'provider')).json(), actual)
})

test('changed and pruned wake carriers fail before projecting accepted notification context', async t => {
  const f = await fixture(t, 'active'), token = f.projection.issue(f.session, 'provider', 'openai')
  for (const messages of [[{ role: 'user', content: GENUINE }], [{ role: 'user', content: GENUINE }, { role: 'tool', tool_call_id: 'call', content: 'changed' }]]) await assert.rejects(f.projection.project(request({ messages }), token, 'provider'))
})
