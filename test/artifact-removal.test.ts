import assert from 'node:assert/strict'
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { ClaudeTranscript } from '../src/transcript.js'
import { CodexTranscript } from '../src/codex-transcript.js'
import { Sessions } from '../src/sessions.js'

for (const replaced of [false, true]) test(`Claude per-session removal preserves other sessions and verifies ownership (replacement=${replaced})`, async t => {
  const parent = await mkdtemp(join(tmpdir(), 'claude-removal-')), sessions = new Sessions()
  const transcript = new ClaudeTranscript({ host: 'v1', directory: '/project', temporaryParent: parent, history: async event => ({ id: event.sessionID, messages: [{ info: { id: 'user', sessionID: event.sessionID, role: 'user', time: { created: 1000 } }, parts: [{ type: 'text', text: 'Original' }] }] }) })
  t.after(async () => { await transcript.dispose(); sessions.dispose(); await rm(parent, { recursive: true, force: true }) })
  const prepare = (sessionID: string) => { const session = sessions.get(sessionID); return transcript.prepare({ host: 'v1', event: 'SessionStart', sessionID, activationID: 'activation', cwd: '/project', data: { source: 'resume' } }, session, session.signal) }
  const path = await prepare('first'), second = await prepare('second'), retained = await readFile(second, 'utf8')
  sessions.close('first')
  if (replaced) {
    await rename(path, path + '.retained'); await writeFile(path, 'replacement')
    await assert.rejects(transcript.removeSession('first'), { code: 'TRANSCRIPT_FILE_CHANGED' })
    assert.equal(await readFile(path, 'utf8'), 'replacement')
    await rm(path); await rename(path + '.retained', path)
  }
  await transcript.removeSession('first')
  await assert.rejects(readFile(path), { code: 'ENOENT' })
  assert.equal(await readFile(second, 'utf8'), retained)
  await transcript.removeSession('first')
  await assert.rejects(async () => prepare('first'))
})

for (const dialect of ['claude', 'codex'] as const) test(`${dialect} deletion drains an already-running history read and prevents late artifact recreation`, async t => {
  const parent = await mkdtemp(join(tmpdir(), 'artifact-drain-')), sessions = new Sessions()
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve }), started = new Promise<void>(resolve => { entered = resolve })
  const options = { host: 'v1' as const, directory: '/project', temporaryParent: parent, history: async () => { entered(); await gate; return { id: 'session', messages: [] } } }
  const transcript = dialect === 'claude' ? new ClaudeTranscript(options) : new CodexTranscript(options)
  t.after(async () => { release(); await transcript.dispose(); sessions.dispose(); await rm(parent, { recursive: true, force: true }) })
  const session = sessions.get('session'), event = { host: 'v1' as const, event: 'SessionStart' as const, sessionID: 'session', activationID: 'activation', cwd: '/project', data: { source: 'resume' } }
  const pending = transcript instanceof ClaudeTranscript ? transcript.prepare(event, session, session.signal) : transcript.prepareStart(event, session, session.signal)
  await started
  const deletion = transcript.removeSession('session')
  release()
  const result = await pending, path = typeof result === 'string' ? result : result.transcriptPath
  await deletion
  await assert.rejects(readFile(path), { code: 'ENOENT' })
  if (transcript instanceof ClaudeTranscript) await assert.rejects(transcript.prepare(event, session, session.signal), { code: 'TRANSCRIPT_SESSION_DELETED' })
  else await assert.rejects(transcript.prepareStart(event, session, session.signal), { code: 'CODEX_TRANSCRIPT_SESSION_DELETED' })
})
