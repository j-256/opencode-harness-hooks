import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../src/runtime.js'

async function fixture(t: { after: (callback: () => Promise<void>) => void }, matcher = '') {
  const directory = await mkdtemp(join(tmpdir(), 'agent-tool-runtime-')), transcript = join(directory, 'reserved.jsonl')
  t.after(() => rm(directory, { recursive: true, force: true }))
  await writeFile(join(directory, 'record.cjs'), 'const fs=require("node:fs");const p=JSON.parse(fs.readFileSync(0,"utf8"));fs.appendFileSync("calls.jsonl",JSON.stringify({...p,exists:fs.existsSync(p.transcript_path)})+"\\n");')
  const command = { type: 'command', command: 'node record.cjs' }, prompt = { type: 'prompt', prompt: 'MODEL_MUST_NOT_RECURSE' }, agent = { type: 'agent', prompt: 'AGENT_MUST_NOT_RECURSE' }
  const claude = JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'agent', prompt: 'OUTER_AGENT' }] }], PreToolUse: [{ matcher, hooks: [command, prompt, agent] }], PostToolUse: [{ matcher, hooks: [command, prompt, agent] }] } })
  const codex = JSON.stringify({ hooks: { PreToolUse: [{ matcher, hooks: [command] }], PostToolUse: [{ matcher, hooks: [command] }] } })
  await writeFile(join(directory, 'claude.json'), claude); await writeFile(join(directory, 'codex.json'), codex)
  let modelCalls = 0
  const runtime = await createRuntime('v1', directory, { sources: [{ id: 'claude', dialect: 'claude-code', path: 'claude.json' }, { id: 'codex', dialect: 'codex', path: 'codex.json' }], reviewedDigests: { claude: createHash('sha256').update(claude).digest('hex'), codex: createHash('sha256').update(codex).digest('hex') }, permissionMode: 'bypassPermissions' }, {
    report: () => {}, dispatchDiagnostic: () => {},
    host: { environment: process.env, evaluatePrompt: async () => { modelCalls++; return { ok: true } }, runAgent: async () => { modelCalls++; return { ok: true } } },
    transcripts: { observe() { throw new Error('EVALUATOR_MUST_NOT_ENTER_PARENT_TRANSCRIPT') }, prepare: async () => transcript, dispose: async () => {} },
    codexTranscripts: { observe() { throw new Error('EVALUATOR_MUST_NOT_ENTER_CODEX_TRANSCRIPT') }, prepare: async () => ({ sessionID: '11111111-1111-5111-8111-111111111111', turnID: '22222222-2222-5222-8222-222222222222', transcriptPath: transcript }), dispose: async () => {} },
  })
  t.after(() => runtime.dispose())
  runtime.sessions.prompt('parent', 'turn', 'model')
  const registration = runtime.report.sources.find(source => source.id === 'claude')!.selected.find(row => row.event === 'UserPromptSubmit')!
  const execution = { parentID: 'parent', turnID: 'turn', sessionID: 'child', signal: new AbortController().signal, context: { host: 'v1' as const, dialect: 'claude-code' as const, event: 'UserPromptSubmit', sourceID: 'claude', registrationID: registration.id, nativeInput: { session_id: 'native-parent', transcript_path: transcript, permission_mode: 'bypassPermissions' } } }
  const event = { host: 'v1' as const, event: 'PreToolUse' as const, sessionID: 'child', callID: 'owned-call', tool: 'read', toolInput: { filePath: 'owned.txt' }, effectiveInput: { filePath: 'owned.txt' }, signal: execution.signal }
  return { runtime, execution, event, directory, transcript, models: () => modelCalls, calls: async () => (await readFile(join(directory, 'calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)) }
}

test('agent tool dispatch projects parent native metadata without persisting evaluator messages or recursing model hooks', async t => {
  const f = await fixture(t)
  const before = await f.runtime.agentTool(f.execution, f.event)
  const after = await f.runtime.agentTool(f.execution, { ...f.event, event: 'PostToolUse', result: { title: 'Read', output: 'owned result', metadata: {} } })
  assert.equal(f.models(), 0)
  assert.equal([...before.entries, ...after.entries].filter(row => row.result.code === 'NATIVE_AGENT_MODEL_RECURSION').length, 4)
  const calls = await f.calls(); assert.equal(calls.length, 4)
  const native = calls.filter(row => row.session_id === 'native-parent'), codex = calls.filter(row => row.session_id === '11111111-1111-5111-8111-111111111111')
  assert.equal(native.length, 2); assert.equal(codex.length, 2)
  for (const row of native) { assert.equal(row.permission_mode, 'dontAsk'); assert.equal(row.tool_name, 'Read'); assert.equal(row.tool_input.file_path, 'owned.txt'); assert.equal(row.tool_use_id, 'owned-call'); assert.equal(row.exists, false) }
  for (const row of codex) { assert.equal(row.permission_mode, 'dontAsk'); assert.equal(row.turn_id, '22222222-2222-5222-8222-222222222222'); assert.equal(row.tool_use_id, 'owned-call') }
  await assert.rejects(access(f.transcript)); assert.equal(f.runtime.sessions.get('parent').turnID, 'turn')
  assert.equal(f.runtime.inspect().activeDispatches, 0)
})

test('agent projection rejects stale turns, wrong child identities and unrelated registration provenance before commands run', async t => {
  const f = await fixture(t)
  await assert.rejects(f.runtime.agentTool({ ...f.execution, turnID: 'stale' }, f.event), { code: 'SESSION_STALE_TURN' })
  await assert.rejects(f.runtime.agentTool({ ...f.execution, sessionID: 'foreign' }, f.event), { code: 'HOST_AGENT_CONTEXT_UNAVAILABLE' })
  await assert.rejects(f.runtime.agentTool({ ...f.execution, context: { ...f.execution.context, registrationID: 'foreign' } }, f.event), { code: 'HOST_AGENT_CONTEXT_UNAVAILABLE' })
  await assert.rejects(access(join(f.directory, 'calls.jsonl')))
})

test('unclassified agent tool failures cannot silently omit matching Codex post policies', async t => {
  const f = await fixture(t)
  await assert.rejects(f.runtime.agentTool(f.execution, { ...f.event, event: 'PostToolUseFailure', result: { message: 'Owned tool failure' } }), { code: 'HOST_POST_FAILURE_UNVERIFIED' })
  await assert.rejects(access(join(f.directory, 'calls.jsonl')))
})


test('unmatched agent post results require no native serialization', async t => {
  const f = await fixture(t, 'Bash'), cycle: Record<string, unknown> = {}
  cycle.self = cycle
  const result = await f.runtime.agentTool(f.execution, { ...f.event, event: 'PostToolUse', result: cycle })
  assert.deepEqual(result.entries, [])
  await assert.rejects(access(join(f.directory, 'calls.jsonl')))
})
