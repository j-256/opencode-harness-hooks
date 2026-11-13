import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { ClaudeTranscript } from '../src/transcript.js'
import { CodexTranscript } from '../src/codex-transcript.js'
import { Sessions } from '../src/sessions.js'
import type { HostToolEvent } from '../src/tool-types.js'

const CREATED = Date.parse('2026-01-01T00:00:00Z')
function event(session: ReturnType<Sessions['get']>): HostToolEvent { return { host: 'v1', event: 'PreToolUse', sessionID: 'session', callID: 'call', tool: 'bash', toolInput: { command: 'original' }, effectiveInput: { command: 'effective' }, signal: session.turnSignal } }
function claudeHistory() { return { id: 'session', messages: [
  { info: { role: 'user', id: 'turn', sessionID: 'session', time: { created: CREATED } }, parts: [{ type: 'text', text: 'User prompt' }] },
  { info: { role: 'assistant', id: 'answer', parentID: 'turn', sessionID: 'session', modelID: 'fixture', time: { created: CREATED + 1 } }, parts: [{ type: 'tool', callID: 'call', tool: 'bash', state: { status: 'running', input: { command: 'effective' }, time: { start: CREATED + 2 } } }] },
] } }
function codexHistory() { return { id: 'session', messages: [
  { id: 'turn', turnID: 'turn', role: 'user' as const, created: CREATED, content: ['User prompt'] },
  { id: 'answer', turnID: 'turn', role: 'assistant' as const, created: CREATED + 1, content: [{ id: 'call', name: 'bash', status: 'running' as const, created: CREATED + 2 }] },
] } }

for (const dialect of ['claude', 'codex'] as const) test(`${dialect} cold restoration preserves original inputs and native projection identity`, async t => {
  const make = () => dialect === 'claude' ? new ClaudeTranscript({ host: 'v1', directory: '/project', now: () => CREATED, history: async () => claudeHistory() }) : new CodexTranscript({ host: 'v1', directory: '/project', history: async () => codexHistory() })
  const sessions = new Sessions(), source = make(), next = new Sessions(), restored = make()
  t.after(async () => { await source.dispose(); await restored.dispose(); sessions.dispose(); next.dispose() })
  sessions.prompt('session', 'turn', 'fixture')
  const owner = sessions.get('session'), input = event(owner)
  source.observe(input, owner)
  if (source instanceof ClaudeTranscript) source.observeModel({ host: 'v1', sessionID: 'session', messageID: 'turn', signal: owner.turnSignal }, owner)
  else { source.rememberStart(owner, 'activation', ['START_CONTEXT']); source.bindStart(owner, 'activation', 'turn') }
  const first = await source.prepare(input, owner, owner.turnSignal)
  const before = await readFile(typeof first === 'string' ? first : first.transcriptPath, 'utf8')
  const snapshot = source.snapshotV1('session')
  await source.dispose(); sessions.dispose()
  restored.restoreV1(next.get('session'), snapshot)
  next.prompt('session', 'turn', 'fixture')
  const current = next.get('session'), second = await restored.prepare(event(current), current, current.turnSignal)
  const after = await readFile(typeof second === 'string' ? second : second.transcriptPath, 'utf8')
  assert.equal(after, before)
  assert.ok(after.includes('original'))
  assert.ok(!after.includes('effective'))
  assert.deepEqual(restored.snapshotV1('session'), snapshot)
  next.close('session')
  assert.equal(restored instanceof ClaudeTranscript ? restored.inspect().originals : restored.inspect().originalCalls, 0)
})

for (const dialect of ['claude', 'codex'] as const) test(`${dialect} restored ownership rejects a changed historical tool name`, async t => {
  const history: any = dialect === 'claude' ? claudeHistory() : codexHistory()
  const make = () => dialect === 'claude' ? new ClaudeTranscript({ host: 'v1', directory: '/project', now: () => CREATED, history: async () => history }) : new CodexTranscript({ host: 'v1', directory: '/project', history: async () => history })
  const sessions = new Sessions(), source = make(), restored = make(), next = new Sessions()
  t.after(async () => { await source.dispose(); await restored.dispose(); sessions.dispose(); next.dispose() })
  sessions.prompt('session', 'turn', 'fixture')
  source.observe(event(sessions.get('session')), sessions.get('session'))
  if (source instanceof ClaudeTranscript) source.observeModel({ host: 'v1', sessionID: 'session', messageID: 'turn', signal: sessions.get('session').turnSignal }, sessions.get('session'))
  const snapshot = source.snapshotV1('session')
  restored.restoreV1(next.get('session'), snapshot)
  if (dialect === 'claude') history.messages[1].parts[0].tool = 'read'
  else history.messages[1].content[0].name = 'read'
  next.prompt('session', 'turn', 'fixture')
  await assert.rejects(restored.prepare(event(next.get('session')), next.get('session'), next.get('session').turnSignal), { code: dialect === 'claude' ? 'TRANSCRIPT_ORIGINAL_INPUT_UNAVAILABLE' : 'CODEX_TRANSCRIPT_ORIGINAL_INPUT_UNAVAILABLE' })
})

for (const dialect of ['claude', 'codex'] as const) test(`${dialect} malformed or foreign restoration leaves every owned store unchanged`, async t => {
  const make = () => dialect === 'claude' ? new ClaudeTranscript({ host: 'v1', directory: '/project', now: () => CREATED, history: async () => claudeHistory() }) : new CodexTranscript({ host: 'v1', directory: '/project', history: async () => codexHistory() })
  const sessions = new Sessions(), source = make()
  t.after(async () => { await source.dispose(); sessions.dispose() })
  sessions.prompt('session', 'turn', 'fixture')
  source.observe(event(sessions.get('session')), sessions.get('session'))
  if (source instanceof ClaudeTranscript) source.observeModel({ host: 'v1', sessionID: 'session', messageID: 'turn', signal: sessions.get('session').turnSignal }, sessions.get('session'))
  else source.rememberStart(sessions.get('session'), 'activation', ['START_CONTEXT'])
  const snapshot = source.snapshotV1('session')
  for (const mutate of [
    (value: any) => { value.sessionID = 'foreign' },
    (value: any) => { value.directory = '/other-project' },
    (value: any) => { value.originals.calls.push(structuredClone(value.originals.calls[0])) },
    (value: any) => { if (dialect === 'claude') value.models.turns[0].date.created = 'invalid'; else value.starts[0].created = 'invalid' },
  ]) {
    const next = new Sessions(), restored = make(), empty = restored.snapshotV1('session'), value = structuredClone(snapshot)
    mutate(value)
    assert.throws(() => restored.restoreV1(next.get('session'), value))
    assert.deepEqual(restored.snapshotV1('session'), empty)
    await restored.dispose(); next.dispose()
  }
  const before = source.snapshotV1('session')
  assert.throws(() => source.restoreV1(sessions.get('session'), snapshot), { code: 'SESSION_SNAPSHOT_STATE_CONFLICT' })
  assert.deepEqual(source.snapshotV1('session'), before)
  const closed = new Sessions(), owner = closed.get('session'); closed.close('session')
  const restored = make()
  assert.throws(() => restored.restoreV1(owner, snapshot), { code: 'SESSION_SNAPSHOT_CANCELLED' })
  await restored.dispose(); closed.dispose()
})

test('Codex metadata-only startup journal retains its original native timestamp after cold restoration', async t => {
  const make = () => new CodexTranscript({ host: 'v1', directory: '/project', history: async () => ({ id: 'session', messages: [] }) })
  const sessions = new Sessions(), source = make(), restored = make(), next = new Sessions()
  t.after(async () => { await source.dispose(); await restored.dispose(); sessions.dispose(); next.dispose() })
  const input = { host: 'v1' as const, event: 'SessionStart' as const, sessionID: 'session', activationID: 'activation', cwd: '/project', data: { source: 'startup' } }
  const first = await source.prepareStart(input, sessions.get('session'), sessions.get('session').signal), before = await readFile(first.transcriptPath, 'utf8')
  restored.restoreV1(next.get('session'), source.snapshotV1('session'))
  const second = await restored.prepareStart({ ...input, activationID: 'resume', data: { source: 'resume' } }, next.get('session'), next.get('session').signal)
  assert.equal(await readFile(second.transcriptPath, 'utf8'), before)
  assert.equal(second.sessionID, first.sessionID)
})

test('V1 snapshots reject V2 state explicitly rather than dropping Stop records', async t => {
  const sessions = new Sessions(), transcripts = [new ClaudeTranscript({ host: 'v2', directory: '/project', history: async () => ({ id: 'session', messages: [] }) }), new CodexTranscript({ host: 'v2', directory: '/project', history: async () => ({ id: 'session', messages: [] }) })]
  t.after(async () => { for (const item of transcripts) await item.dispose(); sessions.dispose() })
  for (const item of transcripts) {
    assert.throws(() => item.snapshotV1('session'), { code: 'SESSION_SNAPSHOT_HOST_UNSUPPORTED' })
    assert.throws(() => item.restoreV1(sessions.get('session'), {}), { code: 'SESSION_SNAPSHOT_HOST_UNSUPPORTED' })
  }
})
