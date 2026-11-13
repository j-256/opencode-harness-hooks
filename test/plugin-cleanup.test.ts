import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { createHarnessHooks } from '../src/hosts/plugin-v1.js'

test('V1 deletion attempts durable tombstone even when another artifact owner fails', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'v1-cleanup-fanout-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const source = JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: ':' }] }] } })
  await writeFile(join(directory, 'hooks.json'), source)
  const diagnostics: string[] = [], original = console.error
  console.error = value => diagnostics.push(String(value)); t.after(() => { console.error = original })
  let failures = true, attempts = 0
  const services = { host: { environment: { PATH: process.env.PATH, HOME: directory, XDG_STATE_HOME: join(directory, 'state') } }, report: () => {}, dispatchDiagnostic: () => {}, transcripts: { observe: () => {}, prepare: async () => { throw new Error('unused') }, dispose: async () => {}, removeSession: async () => { attempts++; if (failures) throw new Error('PRIVATE_FAILURE_DETAIL') } } }
  const options = { sources: [{ id: 'claude', dialect: 'claude-code', path: 'hooks.json' }], reviewedDigests: { claude: createHash('sha256').update(source).digest('hex') }, permissionMode: 'default' }
  const hooks = await createHarnessHooks({ directory }, options, services)
  t.after(() => hooks.dispose())
  const prompt = { sessionID: 'session' }, output = { message: { id: 'turn' }, parts: [{ type: 'text', text: 'Original' }] }
  await hooks['chat.message'](prompt, output)
  await hooks.event({ event: { type: 'session.deleted', properties: { info: { id: 'session' } } } })
  assert.equal(attempts, 1)
  assert.equal(hooks.inspect().cleanup.failedSessions, 1)
  assert.ok(!diagnostics.join('\n').includes('PRIVATE_FAILURE_DETAIL'))
  const next = await createHarnessHooks({ directory }, options, services)
  t.after(() => next.dispose())
  await assert.rejects(next['chat.message'](prompt, output), { code: 'SESSION_STORE_DELETED' })
  failures = false
  await hooks.event({ event: { type: 'session.deleted', properties: { info: { id: 'session' } } } })
  assert.equal(hooks.inspect().cleanup.failedSessions, 0)
})

test('V1 actual deletion removes native environment files and its frozen shell snapshot', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'v1-cleanup-environment-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const capture = join(directory, 'path.txt'), script = join(directory, 'hook.cjs')
  await writeFile(script, `const fs=require('node:fs');fs.readFileSync(0,'utf8');fs.writeFileSync(process.env.CLAUDE_ENV_FILE,'export VALUE=retained\\n',{mode:0o600});fs.writeFileSync(${JSON.stringify(capture)},process.env.CLAUDE_ENV_FILE);`)
  const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'"
  const source = JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: quote(process.execPath) + ' ' + quote(script) }] }] } })
  await writeFile(join(directory, 'hooks.json'), source)
  const input = { directory, client: { session: { get: async () => ({ data: { id: 'session' } }), messages: async () => ({ data: [] }) } } }
  const hooks = await createHarnessHooks(input, { sources: [{ id: 'claude', dialect: 'claude-code', path: 'hooks.json' }], reviewedDigests: { claude: createHash('sha256').update(source).digest('hex') }, permissionMode: 'default' }, { host: { environment: { PATH: process.env.PATH, HOME: directory, XDG_STATE_HOME: join(directory, 'state') } }, report: () => {}, dispatchDiagnostic: () => {} })
  t.after(() => hooks.dispose())
  await hooks.config({ model: 'fixture/model', shell: '/bin/bash' })
  await hooks.event({ event: { type: 'session.created', properties: { info: { id: 'session' } } } })
  const nativeFile = await readFile(capture, 'utf8'), env: Record<string, string> = {}
  await hooks['shell.env']({ sessionID: 'session' }, { env })
  const snapshot = env.OPENCODE_HARNESS_ENV_SNAPSHOT!
  assert.match(await readFile(snapshot, 'utf8'), /VALUE=retained/)
  await hooks.event({ event: { type: 'session.deleted', properties: { info: { id: 'session' } } } })
  await assert.rejects(readFile(nativeFile), { code: 'ENOENT' })
  await assert.rejects(readFile(snapshot), { code: 'ENOENT' })
  await assert.rejects(readFile(join(dirname(nativeFile), 'manifest.json')), { code: 'ENOENT' })
  assert.equal(hooks.inspect().cleanup.failedSessions, 0)
})
