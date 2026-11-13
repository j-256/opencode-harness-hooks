import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { dispatchEvent } from '../src/engine.js'
import { selectRegistrations } from '../src/matchers.js'
import { buildPayload } from '../src/payload.js'
import { createRuntime } from '../src/runtime.js'
import { createV1Hooks } from '../src/hosts/v1.js'
import { MAX_TOOL_RESULT_BYTES, v1ShellFailure } from '../src/tool-failure.js'
import type { LoadedSource, NativeEvent } from '../src/types.js'

const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'"
const call = { host: 'v1' as const, sessionID: 'session', callID: 'call', tool: 'bash', toolInput: { command: 'failure' }, effectiveInput: { command: 'failure' }, signal: new AbortController().signal }
const failure = () => ({ title: 'Failed shell', metadata: { exit: 17 }, output: 'FAILED_TOOL_STDOUT' })

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'native-tool-failure-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const capture = join(directory, 'captured.jsonl'), script = join(directory, 'hook.cjs')
  await writeFile(script, `const fs=require('node:fs');const p=JSON.parse(fs.readFileSync(0,'utf8'));fs.appendFileSync(${JSON.stringify(capture)},JSON.stringify(p)+'\\n');if(p.tool_input.command==='failure')console.log(JSON.stringify(p.hook_event_name==='PostToolUseFailure'?{hookSpecificOutput:{hookEventName:p.hook_event_name,additionalContext:'CLAUDE_FAILURE_CONTEXT'}}:{decision:'block',reason:'CODEX_FAILURE_REPLACEMENT'}));`)
  const sources: LoadedSource[] = []
  for (const [id, dialect, event] of [['claude', 'claude-code', 'PostToolUseFailure'], ['codex', 'codex', 'PostToolUse']] as const) {
    const handler = { type: 'command' as const, command: [process.execPath, script].map(quote).join(' ') }
    const text = JSON.stringify({ hooks: { [event]: [{ matcher: 'Bash', hooks: [handler] }] } }), path = join(directory, id + '.json')
    await writeFile(path, text)
    sources.push({ id, dialect, path, digest: createHash('sha256').update(text).digest('hex'), enabled: true, excluded: [], registrations: [{ id: id + ':0', sourceID: id, dialect, event, groupIndex: 0, handlerIndex: 0, matcher: 'Bash', handler }] })
  }
  const options = { sources: sources.map(({ id, dialect, path }) => ({ id, dialect, path })), reviewedDigests: Object.fromEntries(sources.map(source => [source.id, source.digest])), permissionMode: 'default' }
  const nativeData = async () => ({ 'claude-code': { transcript_path: join(directory, 'provided.jsonl') } })
  return { directory, capture, sources, options, nativeData }
}

test('one dispatch selects per-dialect native events with shared action order and correct payload identity', async t => {
  const f = await fixture(t)
  const event: NativeEvent = { host: 'v1', event: 'PostToolUseFailure', dialectEvents: { codex: 'PostToolUse' }, sessionID: 'session', cwd: f.directory, tool: 'bash', toolInput: { command: 'failure' }, data: { error: 'Failed stdout', transcript_path: '/provided/transcript.jsonl', permission_mode: 'default', model: 'fixture', turn_id: 'turn', tool_use_id: 'call' }, dialectData: { codex: { tool_response: 'Failed stdout' } } }
  assert.deepEqual(selectRegistrations(f.sources, event).map(row => row.sourceID), ['claude', 'codex'])
  assert.equal(buildPayload(f.sources[1]!.registrations[0]!, event).hook_event_name, 'PostToolUse')
  const result = await dispatchEvent(f.sources, event, { environment: { PATH: process.env.PATH }, projectRoot: f.directory })
  assert.deepEqual(result.entries.map(row => row.sourceID), ['claude', 'codex'])
  assert.deepEqual(result.entries.map(row => row.configuredOrder), [0, 1])
  assert.equal(new Set(result.entries.map(row => row.completionOrder)).size, 2)
  assert.deepEqual(result.entries.map(row => row.result.diagnostic.event), ['PostToolUseFailure', 'PostToolUse'])
  assert.ok(result.entries.every(row => row.result.status === 'success'))
  assert.deepEqual(result.actions.map(row => row.action.kind), ['context', 'replace-result'])
  assert.equal(event.event, 'PostToolUseFailure')
})

test('V1 projects nonzero shell results to Claude errors and Codex post-tool output in one dispatch', async t => {
  const f = await fixture(t)
  const runtime = await createRuntime('v1', f.directory, f.options, { report: () => {}, dispatchDiagnostic: () => {}, nativeData: f.nativeData })
  t.after(() => runtime.dispose())
  runtime.sessions.prompt('session', 'turn', 'fixture')
  const result = await runtime.tools.dispatch({ ...call, event: 'PostToolUseFailure', result: failure() })
  assert.deepEqual(result.entries.map(row => row.sourceID), ['claude', 'codex'])
  const rows = (await readFile(f.capture, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  const claude = rows.find(row => row.hook_event_name === 'PostToolUseFailure'), codex = rows.find(row => row.hook_event_name === 'PostToolUse')
  assert.match(claude.error, /Exit code 17\nFAILED_TOOL_STDOUT/)
  assert.equal(claude.is_interrupt, false)
  assert.equal(claude.tool_response, undefined)
  assert.equal(typeof codex.tool_response, 'string')
  assert.ok(codex.tool_response.includes('FAILED_TOOL_STDOUT'))
  assert.equal(codex.error, undefined)
})

test('mixed failed-shell payload preflight prevents either native hook from executing on invalid metadata', async t => {
  const f = await fixture(t)
  const runtime = await createRuntime('v1', f.directory, f.options, { report: () => {}, nativeData: async () => ({ ...await f.nativeData(), codex: { model: 7 } }) })
  t.after(() => runtime.dispose())
  runtime.sessions.prompt('session', 'turn', 'fixture')
  await assert.rejects(runtime.tools.dispatch({ ...call, event: 'PostToolUseFailure', result: failure() }), { code: 'HOST_NATIVE_METADATA_UNAVAILABLE' })
  await assert.rejects(readFile(f.capture), { code: 'ENOENT' })
})

test('default V1 combines failed-shell Codex replacement with Claude context and releases them before the next call', async t => {
  const f = await fixture(t)
  const runtime = await createRuntime('v1', f.directory, f.options, { report: () => {}, dispatchDiagnostic: () => {}, nativeData: f.nativeData })
  const hooks = createV1Hooks(runtime.tools)
  t.after(async () => { await hooks.dispose(); await runtime.dispose() })
  runtime.sessions.prompt('session', 'turn', 'fixture')
  await hooks['tool.execute.before'](call, { args: { command: 'failure' } })
  const output = failure()
  await hooks['tool.execute.after']({ ...call, args: { command: 'failure' } }, output)
  assert.ok(output.output.startsWith('CODEX_FAILURE_REPLACEMENT'))
  assert.equal(output.output.includes('FAILED_TOOL_STDOUT'), false)
  assert.equal(output.output.split('CLAUDE_FAILURE_CONTEXT').length - 1, 1)
  assert.equal(output.metadata.exit, 17)
  assert.equal(output.title, 'Failed shell')
  const next = { ...call, callID: 'next' }
  await hooks['tool.execute.before'](next, { args: { command: 'clean' } })
  const clean = { title: 'Control', metadata: { exit: 0 }, output: 'CLEAN_CONTROL' }
  await hooks['tool.execute.after']({ ...next, args: { command: 'clean' } }, clean)
  assert.equal(clean.output, 'CLEAN_CONTROL')
  assert.deepEqual(hooks.inspect().diagnostics, [])
})

test('failed-shell classification accepts empty stdout and rejects unproven layouts and invalid exit status', () => {
  const event = { ...call, event: 'PostToolUseFailure' as const, result: failure() }
  assert.deepEqual(v1ShellFailure({ ...event, result: { ...failure(), output: '' } }), { output: '', error: 'Exit code 17\n' })
  for (const exit of [0, -1, 256, 1.5, NaN, undefined]) assert.equal(v1ShellFailure({ ...event, result: { ...failure(), metadata: { exit } } }), undefined)
  for (const changed of [{ host: 'v2' as const }, { tool: 'write' }, { event: 'PostToolUse' as const }, { result: { message: 'Unknown error' } }, { result: { ...failure(), get output(): string { throw new Error('Unreadable') } } }]) assert.equal(v1ShellFailure({ ...event, ...changed }), undefined)
  assert.equal(v1ShellFailure({ ...event, result: { ...failure(), output: '\u00e9'.repeat(MAX_TOOL_RESULT_BYTES / 2) } }), undefined)
})

test('unknown and V2 failures keep explicit Codex rejection without executing either source', async t => {
  for (const host of ['v1', 'v2'] as const) {
    const f = await fixture(t)
    const runtime = await createRuntime(host, f.directory, f.options, { report: () => {}, nativeData: f.nativeData })
    t.after(() => runtime.dispose())
    runtime.sessions.prompt('session', 'turn', 'fixture')
    await assert.rejects(runtime.tools.dispatch({ ...call, host, tool: host === 'v2' ? 'shell' : 'bash', event: 'PostToolUseFailure', result: host === 'v1' ? { message: 'Unknown failure' } : failure() }), { code: 'HOST_POST_FAILURE_UNVERIFIED' })
    await assert.rejects(readFile(f.capture), { code: 'ENOENT' })
  }
})

test('explicit native metadata owns failure output and noninterruption fields', async t => {
  const f = await fixture(t)
  const runtime = await createRuntime('v1', f.directory, f.options, { report: () => {}, dispatchDiagnostic: () => {}, nativeData: async () => ({ 'claude-code': { ...((await f.nativeData())['claude-code']), error: 'EXPLICIT_ERROR', is_interrupt: true }, codex: { tool_response: 'EXPLICIT_CODEX_RESULT' } }) })
  t.after(() => runtime.dispose())
  runtime.sessions.prompt('session', 'turn', 'fixture')
  await runtime.tools.dispatch({ ...call, event: 'PostToolUseFailure', result: failure() })
  const rows = (await readFile(f.capture, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  const claude = rows.find(row => row.hook_event_name === 'PostToolUseFailure'), codex = rows.find(row => row.hook_event_name === 'PostToolUse')
  assert.equal(claude.error, 'EXPLICIT_ERROR'); assert.equal(claude.is_interrupt, true)
  assert.equal(codex.tool_response, 'EXPLICIT_CODEX_RESULT')
})
