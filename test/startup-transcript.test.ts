import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { ClaudeTranscript } from '../src/transcript.js'
import { createRuntime } from '../src/runtime.js'
import type { SessionStartEvent } from '../src/session-start.js'
import type { HostToolEvent } from '../src/tool-types.js'

const CREATED = Date.parse('2026-01-01T12:00:00Z')

test('actual startup commands reserve the native path and attach records before the first original user', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'startup-transcript-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const source = JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: "printf 'START_CONTEXT\\n'" }] }] } })
  await writeFile(join(directory, 'hooks.json'), source)
  let history: readonly unknown[] = []
  const transcripts = new ClaudeTranscript({ host: 'v1', directory, history: async () => ({ id: 'session', messages: history }) })
  const runtime = await createRuntime('v1', directory, { sources: [{ id: 'claude', dialect: 'claude-code', path: 'hooks.json' }], reviewedDigests: { claude: createHash('sha256').update(source).digest('hex') }, permissionMode: 'default' }, { transcripts, report: () => {}, dispatchDiagnostic: () => {}, sessionStart: { environmentDirectory: join(directory, 'environment'), diagnostic: () => {}, admit: async delivery => { transcripts.admitStart(delivery) } } })
  t.after(() => runtime.dispose())
  const event: SessionStartEvent = { host: 'v1', event: 'SessionStart', sessionID: 'session', activationID: 'activation', cwd: directory, data: { source: 'startup' } }
  const session = runtime.sessions.get('session')
  const reserved = await transcripts.prepare(event, session, session.signal)
  await assert.rejects(access(reserved))
  await runtime.start({ ...event, data: { ...event.data, transcript_path: reserved } })
  runtime.sessions.prompt('session', 'turn', 'fixture')
  transcripts.bindStart(runtime.sessions.get('session'), 'activation', 'turn')
  const tool: HostToolEvent = { host: 'v1', event: 'PreToolUse', sessionID: 'session', callID: 'call', tool: 'bash', toolInput: { command: 'printf fine' }, effectiveInput: { command: 'printf fine' }, signal: runtime.sessions.get('session').turnSignal }
  history = [
    { info: { id: 'turn', sessionID: 'session', role: 'user', time: { created: CREATED } }, parts: [{ type: 'text', text: 'Original user' }] },
    { info: { id: 'answer', sessionID: 'session', role: 'assistant', parentID: 'turn', modelID: 'fixture', time: { created: CREATED + 1 } }, parts: [{ type: 'tool', tool: 'bash', callID: 'call', state: { status: 'running' } }] },
  ]
  transcripts.observe(tool, runtime.sessions.get('session'))
  runtime.observeModel({ host: 'v1', sessionID: 'session', messageID: 'turn', signal: tool.signal })
  assert.equal(await transcripts.prepare(tool, runtime.sessions.get('session'), tool.signal), reserved)
  const before = await readFile(reserved, 'utf8'), rows = before.trim().split('\n').map(line => JSON.parse(line))
  assert.equal(rows[0].type, 'attachment')
  assert.equal(rows[0].attachment.hookEvent, 'SessionStart')
  assert.equal(rows[0].attachment.content, 'START_CONTEXT')
  assert.ok(rows.findIndex(row => row.type === 'user') > 0)
  for (let i = 1; i < rows.length; i++) assert.equal(rows[i].parentUuid, rows[i - 1].uuid)
  await transcripts.prepare(tool, runtime.sessions.get('session'), tool.signal)
  assert.equal(await readFile(reserved, 'utf8'), before)
  assert.throws(() => transcripts.bindStart(runtime.sessions.get('session'), 'activation', 'foreign'), { code: 'STARTUP_BINDING_INVALID' })
})
