import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { ClaudeTranscript } from '../src/transcript.js'
import type { HostToolEvent } from '../src/hosts/tools.js'
import { Sessions } from '../src/sessions.js'
import { dispatchEvent } from '../src/engine.js'

const CREATED = Date.parse('2026-01-01T00:00:00Z')
const event = (host: 'v1' | 'v2', callID = 'call'): HostToolEvent => ({ host, event: 'PreToolUse', sessionID: 'session', callID, tool: host === 'v1' ? 'bash' : 'shell', toolInput: { command: 'original' }, effectiveInput: { command: 'original' }, signal: new AbortController().signal })
function history(host: 'v1' | 'v2', status = 'running'): unknown[] {
  if (host === 'v1') return [
    { info: { role: 'user', id: 'turn', sessionID: 'session', time: { created: CREATED } }, parts: [{ type: 'text', text: 'User prompt' }] },
    { info: { role: 'assistant', id: 'answer', parentID: 'turn', sessionID: 'session', modelID: 'fixture', time: { created: CREATED + 1 } }, parts: [{ type: 'step-start' }, { type: 'text', text: 'Before tool' }, { type: 'tool', callID: 'call', tool: 'bash', state: { status, input: { command: 'effective' }, output: 'Tool result', time: { start: CREATED + 2, end: CREATED + 3 } } }] },
  ]
  return [
    { type: 'user', id: 'turn', text: 'User prompt', files: [], time: { created: CREATED } },
    { type: 'assistant', id: 'answer', model: { id: 'fixture' }, time: { created: CREATED + 1 }, content: [{ type: 'text', text: 'Before tool' }, { type: 'tool', id: 'call', name: 'shell', time: { created: CREATED + 2, completed: CREATED + 3 }, state: { status, input: { command: 'effective' }, content: [{ type: 'text', text: 'Tool result' }] } }] },
  ]
}

test('prompt snapshots reserve an absent initial path and expose only earlier admitted history', async t => {
  for (const host of ['v1', 'v2'] as const) {
    const sessions = new Sessions()
    sessions.prompt('session', 'current', 'model')
    let records: unknown[] = []
    const transcript = new ClaudeTranscript({ host, directory: '/project', history: async () => ({ id: 'session', messages: records }) })
    t.after(() => transcript.dispose())
    const prompt = { host, event: 'UserPromptSubmit' as const, sessionID: 'session', messageID: 'current', prompt: 'Current prompt', signal: new AbortController().signal }
    const path = await transcript.prepare(prompt, sessions.get('session'), prompt.signal)
    await assert.rejects(access(path))
    sessions.prompt('session', 'turn', 'model')
    const priorPrompt = { ...prompt, messageID: 'turn', prompt: 'User prompt' }
    const dispatch = await dispatchEvent([], { event: 'UserPromptSubmit', sessionID: 'session', cwd: '/project' }, { environment: {}, projectRoot: '/project' })
    transcript.admitPrompt(priorPrompt, sessions.get('session'), dispatch)
    sessions.prompt('session', 'current', 'model')
    records = history(host).slice(0, 1)
    assert.equal(await transcript.prepare(prompt, sessions.get('session'), prompt.signal), path)
    const rows = (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    assert.equal(rows.length, 1)
    assert.equal(rows[0].message.content, 'User prompt')
    const alreadySaved = { ...prompt, messageID: 'turn' }
    await assert.rejects(transcript.prepare(alreadySaved, sessions.get('session'), prompt.signal), { code: 'TRANSCRIPT_PROMPT_ALREADY_ADMITTED' })
    records = []
    await assert.rejects(transcript.prepare(prompt, sessions.get('session'), prompt.signal), { code: 'TRANSCRIPT_HISTORY_RESET_UNVERIFIED' })
    sessions.dispose()
  }
})

test('both host histories project readable Claude message records and preserve original call input', async t => {
  for (const host of ['v1', 'v2'] as const) {
    const sessions = new Sessions()
    sessions.prompt('session', 'turn', 'fixture')
    const transcript = new ClaudeTranscript({ host, directory: '/project', history: async () => ({ id: 'session', messages: history(host) }) })
    t.after(() => transcript.dispose())
    transcript.observe(event(host), sessions.get('session'))
    transcript.observeModel({ host, sessionID: 'session', messageID: 'turn', signal: sessions.get('session').turnSignal }, sessions.get('session'))
    const path = await transcript.prepare(event(host), sessions.get('session'), event(host).signal)
    const rows = (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    assert.deepEqual(rows.map(row => row.type), ['user', 'attachment', 'assistant'])
    assert.equal(rows[1].attachment.type, 'date')
    assert.equal(rows[0].message.content, 'User prompt')
    assert.equal(rows[2].message.model, 'fixture')
    assert.equal(rows[2].parentUuid, rows[1].uuid)
    assert.equal(rows[2].message.content[0].text, 'Before tool')
    assert.deepEqual(rows[2].message.content[1], { type: 'tool_use', id: 'call', name: 'Bash', input: { command: 'original' } })
    assert.equal(rows[2].message.usage, undefined)
    assert.equal((await stat(path)).mode & 0o777, 0o600)
    assert.equal((await stat(dirname(path))).mode & 0o777, 0o700)
    assert.ok(!JSON.stringify(transcript.inspect()).includes('"command"'))
    await transcript.dispose()
    await assert.rejects(access(path))
    sessions.dispose()
  }
})

test('post-tool snapshots omit the current result and expose completed results to the next call', async t => {
  const sessions = new Sessions()
  sessions.prompt('session', 'turn', 'fixture')
  const records = history('v2', 'completed') as Record<string, any>[]
  const transcript = new ClaudeTranscript({ host: 'v2', directory: '/project', history: async () => ({ id: 'session', messages: records }) })
  t.after(() => transcript.dispose())
  transcript.observe(event('v2'), sessions.get('session'))
  transcript.observeModel({ host: 'v2', sessionID: 'session', messageID: 'turn', signal: sessions.get('session').turnSignal }, sessions.get('session'))
  const post = { ...event('v2'), event: 'PostToolUse' as const }
  const path = await transcript.prepare(post, sessions.get('session'), post.signal)
  const before = await readFile(path, 'utf8')
  assert.ok(!before.includes('Tool result'))
  const next = event('v2', 'next')
  transcript.observe(next, sessions.get('session'))
  await assert.rejects(transcript.prepare(next, sessions.get('session'), next.signal), { code: 'TRANSCRIPT_CURRENT_CALL_MISSING' })
  assert.equal(await readFile(path, 'utf8'), before)
  records.push({ type: 'assistant', id: 'next-answer', model: { id: 'fixture' }, time: { created: CREATED + 4 }, content: [{ type: 'tool', id: 'next', name: 'shell', state: { status: 'running', input: { command: 'original' } } }] })
  assert.equal(await transcript.prepare(next, sessions.get('session'), next.signal), path)
  const rows = (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(rows.map(row => row.type), ['user', 'attachment', 'assistant', 'user', 'assistant'])
  assert.deepEqual(rows[3].message.content, [{ type: 'tool_result', tool_use_id: 'call', content: [{ type: 'text', text: 'Tool result' }] }])
  sessions.dispose()
})

test('unsupported content, foreign identity, compaction and unobserved completed inputs fail before publishing an artifact', async t => {
  const parent = await mkdtemp(join(tmpdir(), 'harness-artifacts-'))
  t.after(() => rm(parent, { recursive: true, force: true }))
  const sessions = new Sessions()
  sessions.prompt('session', 'turn', 'fixture')
  for (const [messages, id, code] of [
    [[{ type: 'user', id: 'turn', time: { created: CREATED }, text: 'Prompt', files: [{ url: 'file:///private/example' }] }], 'session', 'TRANSCRIPT_CONTENT_UNSUPPORTED'],
    [history('v2'), 'other', 'TRANSCRIPT_SESSION_MISMATCH'],
    [[{ type: 'compaction', id: 'compact', time: { created: CREATED } }], 'session', 'TRANSCRIPT_CONTENT_UNSUPPORTED'],
    [history('v2', 'completed'), 'session', 'TRANSCRIPT_ORIGINAL_INPUT_UNAVAILABLE'],
  ] as const) {
    const transcript = new ClaudeTranscript({ host: 'v2', directory: '/project', temporaryParent: parent, history: async () => ({ id, messages }) })
    t.after(() => transcript.dispose())
    transcript.observeModel({ host: 'v2', sessionID: 'session', messageID: 'turn', signal: sessions.get('session').turnSignal }, sessions.get('session'))
    await assert.rejects(transcript.prepare(event('v2'), sessions.get('session'), event('v2').signal), { code })
    assert.equal(transcript.inspect().created, false)
  }
  sessions.dispose()
})

test('concurrent snapshots for one session serialize their reads without skipping a request', { timeout: 2000 }, async t => {
  const sessions = new Sessions()
  sessions.prompt('session', 'turn', 'fixture')
  let read = 0
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let entered!: () => void
  const ready = new Promise<void>(resolve => { entered = resolve })
  const transcript = new ClaudeTranscript({ host: 'v2', directory: '/project', history: async () => {
    read++
    entered()
    if (read === 1) await gate
    return { id: 'session', messages: history('v2') }
  } })
  t.after(() => transcript.dispose())
  transcript.observe(event('v2'), sessions.get('session'))
  transcript.observeModel({ host: 'v2', sessionID: 'session', messageID: 'turn', signal: sessions.get('session').turnSignal }, sessions.get('session'))
  const first = transcript.prepare(event('v2'), sessions.get('session'), event('v2').signal)
  await ready
  const second = transcript.prepare(event('v2'), sessions.get('session'), event('v2').signal)
  assert.equal(read, 1)
  release()
  const paths = await Promise.all([first, second])
  assert.equal(paths[0], paths[1])
  assert.equal(read, 2)
  sessions.dispose()
})

test('disposal cancels history work without publishing late output', { timeout: 3000 }, async t => {
  const sessions = new Sessions()
  sessions.prompt('session', 'turn', 'fixture')
  let entered!: () => void
  const ready = new Promise<void>(resolve => { entered = resolve })
  const transcript = new ClaudeTranscript({ host: 'v2', directory: '/project', history: async (_event, signal) => {
    entered()
    await new Promise<void>(resolve => { signal.addEventListener('abort', () => resolve(), { once: true }) })
    return { id: 'session', messages: history('v2') }
  } })
  t.after(() => transcript.dispose())
  transcript.observe(event('v2'), sessions.get('session'))
  transcript.observeModel({ host: 'v2', sessionID: 'session', messageID: 'turn', signal: sessions.get('session').turnSignal }, sessions.get('session'))
  const pending = transcript.prepare(event('v2'), sessions.get('session'), event('v2').signal)
  await ready
  await transcript.dispose()
  await assert.rejects(pending, { code: 'TRANSCRIPT_CANCELLED' })
  assert.equal(transcript.inspect().created, false)
  sessions.dispose()
})
