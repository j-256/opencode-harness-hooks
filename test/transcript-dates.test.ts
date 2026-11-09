import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { ClaudeTranscript } from '../src/transcript.js'
import { Sessions } from '../src/sessions.js'
import { dispatchEvent } from '../src/engine.js'

const FIRST = new Date(2026, 0, 1, 12).getTime()
const NEXT = new Date(2026, 0, 2, 12).getTime()

test('both transcript formats retain observed native dates without repeating same-day hints', async t => {
  for (const host of ['v1', 'v2'] as const) {
    const sessions = new Sessions()
    let now = FIRST
    const records: unknown[] = []
    const transcripts = new ClaudeTranscript({ host, directory: '/project', now: () => now, history: async () => ({ id: 'session', messages: records }) })
    t.after(() => transcripts.dispose())
    const dispatch = await dispatchEvent([], { event: 'UserPromptSubmit', sessionID: 'session', cwd: '/project' }, { environment: {}, projectRoot: '/project' })
    for (const id of ['first', 'second', 'third']) {
      sessions.prompt('session', id, 'model')
      const session = sessions.get('session')
      if (id === 'third') now = NEXT
      transcripts.admitPrompt({ host, event: 'UserPromptSubmit', sessionID: 'session', messageID: id, prompt: id, signal: session.turnSignal }, session, dispatch)
      transcripts.observeModel({ host, sessionID: 'session', messageID: id, signal: session.turnSignal }, session)
      if (host === 'v1') records.push(
        { info: { role: 'user', sessionID: 'session', id, time: { created: now } }, parts: [{ type: 'text', text: id }] },
        { info: { role: 'assistant', sessionID: 'session', id: id + '-answer', parentID: id, modelID: 'model', finish: 'stop', time: { created: now } }, parts: [{ type: 'text', text: 'Answer' }] },
      )
      else records.push(
        { type: 'user', id, text: id, time: { created: now } },
        { type: 'assistant', id: id + '-answer', model: { id: 'model' }, finish: 'end-turn', time: { created: now }, content: [{ type: 'text', text: 'Answer' }] },
      )
    }
    sessions.prompt('session', 'next', 'model')
    const session = sessions.get('session')
    const prompt = { host, event: 'UserPromptSubmit' as const, sessionID: 'session', messageID: 'next', prompt: 'Next', signal: session.turnSignal }
    const path = await transcripts.prepare(prompt, session, prompt.signal)
    const rows = (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    const dates = rows.filter(row => row.attachment?.type === 'date')
    assert.deepEqual(dates.map(row => row.attachment.date), ['2026-01-01', '2026-01-02'])
    assert.equal(dates[0].renderedRole, 'system')
    assert.equal(dates[0].rendered[0].content, "<system-reminder>\nToday's date is 2026-01-01.\n</system-reminder>")
    assert.equal(rows[rows.indexOf(dates[0]) - 1].message.content, 'first')
    assert.equal(rows[rows.indexOf(dates[1]) - 1].message.content, 'third')
    const before = await readFile(path, 'utf8')
    await transcripts.prepare(prompt, session, prompt.signal)
    assert.equal(await readFile(path, 'utf8'), before)
    sessions.close('session')
    assert.equal(transcripts.inspect().modelDates, 0)
    assert.equal(transcripts.inspect().modelTurns, 0)
  }
})

test('model history without an observed request fails instead of inventing a date at read time', async t => {
  const sessions = new Sessions()
  sessions.prompt('session', 'turn', 'model')
  const transcripts = new ClaudeTranscript({ host: 'v2', directory: '/project', history: async () => ({ id: 'session', messages: [
    { type: 'user', id: 'turn', text: 'Prompt', time: { created: FIRST } },
    { type: 'assistant', id: 'answer', model: { id: 'model' }, time: { created: FIRST }, content: [{ type: 'tool', id: 'call', name: 'shell', state: { status: 'running' } }] },
  ] }) })
  t.after(() => transcripts.dispose())
  const tool = { host: 'v2' as const, event: 'PreToolUse' as const, sessionID: 'session', callID: 'call', tool: 'shell', toolInput: { command: 'original' }, effectiveInput: { command: 'original' }, signal: sessions.get('session').turnSignal }
  transcripts.observe(tool, sessions.get('session'))
  await assert.rejects(transcripts.prepare(tool, sessions.get('session'), tool.signal), { code: 'TRANSCRIPT_MODEL_CONTEXT_UNAVAILABLE' })
  assert.equal(transcripts.inspect().created, false)
  sessions.dispose()
})
