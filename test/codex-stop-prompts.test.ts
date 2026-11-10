import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { loadSources } from '../src/config.js'
import { compileCodexStopPrompt } from '../src/codex-stop-prompts.js'
import type { CodexStopPromptInput } from '../src/codex-stop-prompts.js'
import { dispatchEvent } from '../src/engine.js'

const oracle = JSON.parse(readFileSync(new URL('./fixtures/codex-stop-artifact-oracle.json', import.meta.url), 'utf8'))
const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'"
const escapeAttribute = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
function repath(value: unknown, from: string, to: string): unknown {
  if (typeof value === 'string') return value.startsWith('<hook_prompt hook_run_id=') ? value.replaceAll(escapeAttribute(from), escapeAttribute(to)) : value.replaceAll(from, to)
  if (Array.isArray(value)) return value.map(item => repath(item, from, to))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, repath(item, from, to)]))
  return value
}
async function fixture(t: TestContext, scenario = oracle.cases[0], output?: unknown) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'harness-codex-stop-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const script = join(root, 'hook.cjs'), path = join(root, 'hooks <&>"\'.json')
  const scriptBytes = `const fs=require('node:fs');const index=Number(process.argv[2]);const count=${scenario.feedback.length};const input=JSON.parse(fs.readFileSync(0,'utf8'));fs.writeFileSync('started-'+index,'');const timer=setInterval(()=>{if(fs.readdirSync('.').filter(name=>name.startsWith('started-')).length<count)return;clearInterval(timer);setTimeout(()=>console.log(JSON.stringify(${JSON.stringify(output ?? null)}??{decision:'block',reason:${JSON.stringify(scenario.feedback)}[index]})),index===0&&count>1?350:0)},5)`
  await writeFile(script, scriptBytes)
  const bytes = JSON.stringify({ hooks: { Stop: [{ hooks: scenario.feedback.map((_: string, index: number) => ({ type: 'command', command: [process.execPath, script, String(index)].map(quote).join(' '), timeout: 5 })) }] } })
  await writeFile(path, bytes)
  const sources = await loadSources([{ id: 'native', dialect: 'codex', path }])
  const dispatch = await dispatchEvent(sources, { event: 'Stop', cwd: root, sessionID: scenario.identity.threadID, data: { turn_id: scenario.identity.turnID, last_assistant_message: 'Answer', permission_mode: 'default', model: 'fixture', stop_hook_active: false } }, { environment: { SHELL: '/bin/sh' }, projectRoot: root })
  assert.equal(dispatch.diagnostic.failed, 0)
  assert.equal(dispatch.diagnostic.unsupported, 0)
  const registrations = sources[0]!.registrations.map((row, index) => ({ sourceID: row.sourceID, sourceDigest: sources[0]!.digest, sourcePath: sources[0]!.path, registrationID: row.id, ordinal: scenario.ordinals[index] }))
  const input: CodexStopPromptInput = { dispatch, sources, registrations, identity: scenario.identity }
  return { input, sources, dispatch, path, expected: repath(scenario.expected, scenario.sourcePath, path), unchanged: async () => { assert.equal(await readFile(path, 'utf8'), bytes); assert.equal(await readFile(script, 'utf8'), scriptBytes) } }
}

for (const scenario of oracle.cases) test('Codex Stop artifacts match native capture: ' + scenario.name, { timeout: 10000 }, async t => {
  const f = await fixture(t, scenario)
  const value = compileCodexStopPrompt(f.input)!
  const { origins, ...artifacts } = value
  assert.deepEqual(artifacts, f.expected)
  assert.deepEqual(origins.map(row => row.ordinal), scenario.ordinals)
  assert.ok(origins.every(row => row.sourceDigest === f.sources[0]!.digest && row.sourcePath === f.path))
  assert.ok(Object.isFrozen(value) && Object.isFrozen(value.event.item.fragments) && Object.isFrozen(value.response.internal_chat_message_metadata_passthrough.content_item_metadata[0]!.provenance))
  if (scenario.name === 'configured-order') assert.deepEqual([...f.dispatch.entries].sort((a, b) => a.completionOrder - b.completionOrder).map(row => row.configuredOrder), [1, 0])
  await f.unchanged()
})

test('Codex Stop retains independent repeated sources and omits Claude fragments', async t => {
  const f = await fixture(t, oracle.cases[1])
  const source = f.sources[0]!, registration = source.registrations[0]!
  const other = { ...source, id: 'other', registrations: [{ ...registration, id: 'other:Stop:0:0', sourceID: 'other' }] }
  const claude = { ...source, id: 'claude', dialect: 'claude-code' as const, registrations: [{ ...registration, id: 'claude:Stop:0:0', sourceID: 'claude', dialect: 'claude-code' as const }] }
  const event = { event: 'Stop', sessionID: 'session', cwd: '/project', data: { turn_id: 'turn', model: 'fixture', transcript_path: '/artifacts/session.jsonl', last_assistant_message: 'Answer', background_tasks: [], session_crons: [], permission_mode: 'default', stop_hook_active: false } }
  const root = f.path.slice(0, f.path.lastIndexOf('/'))
  const dispatch = await dispatchEvent([source, claude, other], { ...event, cwd: root }, { environment: { SHELL: '/bin/sh' }, projectRoot: root })
  assert.equal(dispatch.actions.filter(row => row.action.kind === 'continue-turn').length, 3, JSON.stringify(dispatch.entries.map(row => ({ sourceID: row.sourceID, status: row.result.status, code: 'code' in row.result ? row.result.code : undefined, actions: row.result.actions }))))
  const value = compileCodexStopPrompt({ ...f.input, dispatch, sources: [source, claude, other], registrations: [...f.input.registrations, { ...f.input.registrations[0]!, sourceID: 'other', registrationID: other.registrations[0]!.id }] })!
  assert.equal(value.event.item.fragments.length, 2)
  assert.deepEqual(value.event.item.fragments[0], value.event.item.fragments[1])
  assert.deepEqual(value.origins.map(row => row.sourceID), ['native', 'other'])
})

test('Codex Stop emits no HookPrompt when continuation is prevented or dispatch is cancelled', async t => {
  const f = await fixture(t)
  const action = f.dispatch.actions[0]!
  for (const dialect of ['codex', 'claude-code'] as const) {
    const stopped = { ...f.dispatch, actions: [...f.dispatch.actions, { ...action, dialect, action: { kind: 'stop-session' as const, reason: 'Complete' } }] }
    assert.equal(compileCodexStopPrompt({ ...f.input, dispatch: stopped }), undefined)
  }
  assert.equal(compileCodexStopPrompt({ ...f.input, dispatch: { ...f.dispatch, cancelled: true } }), undefined)
  const empty = await fixture(t, oracle.cases[1], {})
  assert.equal(compileCodexStopPrompt(empty.input), undefined)
})

test('Codex Stop rejects missing, stale and ambiguous registration inventory without inventing ordinals', async t => {
  const f = await fixture(t), first = f.input.registrations[0]!
  for (const registrations of [[], [first, first, ...f.input.registrations.slice(1)], ...[{ ordinal: -1 }, { ordinal: 1.5 }, { ordinal: Number.NaN }, { sourceDigest: 'changed' }, { sourcePath: '/foreign/hooks.json' }, { registrationID: 'foreign' }].map(change => [{ ...first, ...change }, ...f.input.registrations.slice(1)])]) {
    assert.throws(() => compileCodexStopPrompt({ ...f.input, registrations }), { code: 'CODEX_STOP_IDENTITY_UNAVAILABLE' })
  }
  for (const sources of [[], [{ ...f.sources[0]!, digest: 'changed' }], [f.sources[0]!, f.sources[0]!]]) assert.throws(() => compileCodexStopPrompt({ ...f.input, sources }), { code: 'CODEX_STOP_IDENTITY_UNAVAILABLE' })
  assert.throws(() => compileCodexStopPrompt({ ...f.input, registrations: [first, { ...f.input.registrations[1]!, ordinal: first.ordinal }] }), { code: 'CODEX_STOP_IDENTITY_UNAVAILABLE' })
  const reused = compileCodexStopPrompt({ ...f.input, identity: { ...f.input.identity, messageID: 'msg_next' } })!
  assert.deepEqual(reused.event.item.fragments, compileCodexStopPrompt(f.input)!.event.item.fragments)
})

test('Codex Stop validates invocation metadata and enforces serialized artifact budgets', async t => {
  const f = await fixture(t, oracle.cases[1])
  for (const change of [{ threadID: '' }, { turnID: 'bad\0id' }, { messageID: 'x'.repeat(4097) }, { createTime: Number.NaN }, { createTime: String(f.input.identity.createTime) as unknown as number }, { startedAtMs: -1 }, { completedAtMs: f.input.identity.startedAtMs - 1 }]) assert.throws(() => compileCodexStopPrompt({ ...f.input, identity: { ...f.input.identity, ...change } }), { code: 'CODEX_STOP_METADATA_UNAVAILABLE' })
  assert.throws(() => compileCodexStopPrompt({ ...f.input, maxBytes: 1 }), { code: 'CODEX_STOP_ARTIFACT_LIMIT' })
  const bytes = Buffer.byteLength(JSON.stringify(compileCodexStopPrompt(f.input)))
  assert.ok(compileCodexStopPrompt({ ...f.input, maxBytes: bytes }))
  assert.throws(() => compileCodexStopPrompt({ ...f.input, maxBytes: bytes - 1 }), { code: 'CODEX_STOP_ARTIFACT_LIMIT' })
  for (const maxBytes of [0, -1, 1.5, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER]) assert.throws(() => compileCodexStopPrompt({ ...f.input, maxBytes }), { code: 'CODEX_STOP_LIMIT_INVALID' })
  assert.throws(() => compileCodexStopPrompt({ ...f.input, dispatch: { ...f.dispatch, diagnostic: { ...f.dispatch.diagnostic, event: 'SubagentStop' } } }), { code: 'CODEX_STOP_EVENT_UNSUPPORTED' })
})
