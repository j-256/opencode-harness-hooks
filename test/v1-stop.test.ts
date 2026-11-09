import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import definition from '../src/index.js'
import { createRuntime } from '../src/runtime.js'
import { createHarnessHooks } from '../src/plugin.js'
import type { Dialect } from '../src/contracts.js'
import type { SourceSpec } from '../src/types.js'

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'harness-v1-stop-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const sources: SourceSpec[] = [], reviewedDigests: Record<string, string> = {}
  return { directory, options: { sources, reviewedDigests }, async add(id: string, dialect: Dialect, data: unknown, selection?: SourceSpec['selection']) {
    const path = join(directory, id + ' hooks.json'), bytes = JSON.stringify(data)
    await writeFile(path, bytes)
    sources.push({ id, dialect, path, ...(selection ? { selection } : {}) })
    reviewedDigests[id] = createHash('sha256').update(bytes).digest('hex')
    return path
  } }
}

function rejection(error: unknown, paths: readonly string[], ids: readonly string[]): boolean {
  assert.ok(error instanceof Error && 'code' in error && 'outcome' in error)
  assert.equal(error.code, 'HOST_STOP_UNSUPPORTED')
  assert.equal(error.outcome, 'unsupported')
  for (const value of ['V1', 'Stop', 'awaited-completion-decision', ...paths, ...ids]) assert.ok(error.message.includes(value), value)
  assert.equal(error.message.includes('PRIVATE_NATIVE_BODY'), false)
  return true
}

for (const dialect of ['claude-code', 'codex'] as const) test(`V1 core activation refuses enabled Stop registrations before returning runtime hooks (${dialect})`, async t => {
  const f = await fixture(t)
  const unwanted = join(f.directory, 'executed')
  const path = await f.add('stop-source', dialect, { hooks: { Stop: [{ matcher: 'unmatched', hooks: [{ type: 'command', command: 'PRIVATE_NATIVE_BODY', if: 'Bash(*)' }] }], UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'touch ' + unwanted }] }] } })
  await assert.rejects(createRuntime('v1', f.directory, f.options, { report: () => {} }), error => rejection(error, [path], ['stop-source']))
  await assert.rejects(createHarnessHooks({ directory: f.directory }, f.options), error => rejection(error, [path], ['stop-source']))
  await assert.rejects(readFile(unwanted), { code: 'ENOENT' })
})

test('the default V1 root survives swallowed loader errors with fatal configuration, prompt and tool guards', async t => {
  const f = await fixture(t)
  const path = await f.add('incompatible-stop', 'claude-code', { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'PRIVATE_NATIVE_BODY' }] }] } })
  const notices: unknown[] = []
  const client = {
    session: { get: async () => { assert.fail('Failed activation read session state') }, messages: async () => { assert.fail('Failed activation read history') } },
    tui: { showToast: async (options: unknown) => { notices.push(options); return { data: true } } },
  }
  const guards = await definition.server({ directory: f.directory, client }, f.options)
  await assert.rejects(guards.config({}), error => rejection(error, [path], ['incompatible-stop']))
  const body = (notices[0] as { body: { variant: string; title: string; message: string }; signal: AbortSignal }).body
  assert.equal(body.variant, 'error')
  assert.ok(body.title.includes('V1'))
  assert.ok(body.message.includes(path) && body.message.includes('Stop'))
  const prompt = { sessionID: 'session', message: { id: 'turn' } }
  const call = { sessionID: 'session', callID: 'call', tool: 'bash', args: { command: 'never' } }
  for (const refused of [
    () => guards['chat.message'](prompt, { message: prompt.message }),
    () => guards['chat.params'](prompt),
    () => guards['chat.headers'](prompt, { headers: {} }),
    () => guards['experimental.chat.messages.transform']({}, { messages: [] }),
    () => guards['tool.execute.before'](call, { args: call.args }),
    () => guards['tool.execute.after'](call, {}),
  ]) await assert.rejects(refused(), error => rejection(error, [path], ['incompatible-stop']))
  assert.throws(() => guards.inspect(), error => rejection(error, [path], ['incompatible-stop']))
  await guards.disposeSession('session')
  await guards.dispose()
  await assert.rejects(guards['chat.message'](prompt, { message: prompt.message }), { code: 'HOST_STOP_UNSUPPORTED' })
})

test('failure to show a V1 notice cannot activate the incompatible configuration', async t => {
  const f = await fixture(t)
  const path = await f.add('incompatible-stop', 'codex', { hooks: { Stop: [{ hooks: [{ type: 'command', command: ':' }] }] } })
  const guards = await definition.server({ directory: f.directory, client: {
    session: { get: async () => ({}), messages: async () => ({}) },
    tui: { showToast: async () => { throw new Error('PRIVATE_NOTICE_FAILURE') } },
  } }, f.options)
  await assert.rejects(guards.config({}), error => rejection(error, [path], ['incompatible-stop']))
  await assert.rejects(guards['tool.execute.before']({ sessionID: 'session', callID: 'call', tool: 'bash' }, { args: {} }), { code: 'HOST_STOP_UNSUPPORTED' })
  await guards.dispose()
})

test('a notice waiting for V1 initialization cannot postpone the fatal configuration result', async t => {
  const f = await fixture(t)
  await f.add('incompatible-stop', 'codex', { hooks: { Stop: [{ hooks: [{ type: 'command', command: ':' }] }] } })
  let release!: () => void
  const initialized = new Promise<void>(resolve => { release = resolve })
  const guards = await definition.server({ directory: f.directory, client: {
    session: { get: async () => ({}), messages: async () => ({}) },
    tui: { showToast: async () => { await initialized; return { data: true } } },
  } }, f.options)
  t.after(async () => { release(); await guards.dispose() })
  const loading = guards.config({})
  const result = await Promise.race([loading.then(() => 'fulfilled', () => 'rejected'), delay(100).then(() => 'waiting')])
  assert.equal(result, 'rejected')
  release()
  await assert.rejects(loading, { code: 'HOST_STOP_UNSUPPORTED' })
})

test('the V1 root preserves other activation errors instead of creating Stop guards', async t => {
  const f = await fixture(t)
  await f.add('unreviewed', 'codex', { hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: ':' }] }] } })
  await assert.rejects(definition.server({ directory: f.directory }, { ...f.options, reviewedDigests: {} }), { code: 'SOURCE_REVIEW_REQUIRED' })
})

test('V1 reports every incompatible selected source before generic event or digest gates', async t => {
  const f = await fixture(t)
  await f.add('earlier-start', 'codex', { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: ':' }] }] } })
  const claude = await f.add('claude-stop', 'claude-code', { hooks: { Stop: [{ hooks: [{ type: 'prompt', prompt: 'PRIVATE_NATIVE_BODY' }] }] } })
  const codex = await f.add('codex-stop', 'codex', { hooks: { Stop: [{ hooks: [{ type: 'agent' }] }] } })
  await assert.rejects(createRuntime('v1', f.directory, { ...f.options, reviewedDigests: {} }, { report: () => {} }), error => rejection(error, [claude, codex], ['claude-stop', 'codex-stop']))
})

test('V1 Stop rejection covers each enabled native handler family', async t => {
  for (const handler of [
    { type: 'command', command: 'PRIVATE_NATIVE_BODY' }, { type: 'prompt', prompt: 'PRIVATE_NATIVE_BODY' },
    { type: 'agent', prompt: 'PRIVATE_NATIVE_BODY' }, { type: 'http', url: 'http://127.0.0.1:1' },
    { type: 'mcp_tool', server: 'unused', tool: 'unused' },
  ]) {
    const f = await fixture(t)
    const path = await f.add('stop-source', 'claude-code', { hooks: { Stop: [{ hooks: [handler] }] } })
    await assert.rejects(createRuntime('v1', f.directory, f.options, { report: () => {} }), error => rejection(error, [path], ['stop-source']))
  }
})

test('native disablement and explicit selection produce reported exclusions rather than enabled Stop registrations', async t => {
  const f = await fixture(t)
  const hooks = { Stop: [{ hooks: [{ type: 'command', command: 'PRIVATE_NATIVE_BODY' }] }] }
  await f.add('claude-disabled', 'claude-code', { disableAllHooks: true, hooks })
  await f.add('claude-excluded', 'claude-code', { hooks }, { events: ['PreToolUse'] })
  await f.add('codex-excluded', 'codex', { hooks }, { events: ['PreToolUse'] })
  const disabledPath = join(f.directory, 'codex-disabled hooks.json')
  await f.add('codex-disabled', 'codex', { hooks: { ...hooks, state: { [disabledPath + ':stop:0:0']: { enabled: false } } } })
  await f.add('empty-stop', 'codex', { hooks: { Stop: [{ hooks: [] }] } })
  const runtime = await createRuntime('v1', f.directory, f.options, { report: () => {} })
  t.after(() => runtime.dispose())
  assert.ok(runtime.report.sources.every(source => !source.events.includes('Stop') && !source.selected.length))
  assert.deepEqual(runtime.report.sources.map(source => source.excluded.map(row => row.reason)), [['source-disabled'], ['event-excluded'], ['event-excluded'], ['handler-disabled'], []])
})

test('the V1 exception does not replace the remaining V2 Stop integration gate', async t => {
  const f = await fixture(t)
  await f.add('stop-source', 'codex', { hooks: { Stop: [{ hooks: [{ type: 'command', command: ':' }] }] } })
  await assert.rejects(createRuntime('v2', f.directory, f.options, { report: () => {} }), { code: 'HOST_EVENT_UNAVAILABLE' })
})
