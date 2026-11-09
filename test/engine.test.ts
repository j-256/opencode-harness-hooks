import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { mkdtemp, writeFile, readFile, readdir, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { getEventListeners } from 'node:events'
import type { Handler, LoadedSource, NativeEvent } from '../src/types.js'
import type { Dialect } from '../src/contracts.js'

async function fixture(t: TestContext): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'harness-engine-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}
function event(root: string): NativeEvent {
  return { event: 'PreToolUse', sessionID: 'session', cwd: root, tool: 'bash', toolInput: { command: 'original' }, data: { transcript_path: '/artifacts/transcript.jsonl', permission_mode: 'default', model: 'fixture', turn_id: 'turn', tool_use_id: 'call' } }
}
function source(id: string, dialect: Dialect, handlers: readonly Handler[]): LoadedSource {
  return { id, dialect, path: '/fixtures/config.json', digest: `revision-${id}`, enabled: true, excluded: [], registrations: handlers.map((handler, index) => ({ id: `${id}:${index}`, sourceID: id, dialect, event: 'PreToolUse', groupIndex: 0, handlerIndex: index, handler })) }
}

test('mixed native sources execute repeated matching commands concurrently and retain source revisions', { timeout: 10000 }, async t => {
  const { loadSources } = await import('../src/config.js')
  const { dispatchEvent } = await import('../src/engine.js')
  const root = await fixture(t)
  const script = join(root, 'hook.cjs')
  await writeFile(script, `const fs=require('node:fs');const input=JSON.parse(fs.readFileSync(0,'utf8'));fs.writeFileSync('started-'+process.pid,JSON.stringify(input));const timer=setInterval(()=>{if(fs.readdirSync('.').filter(name=>name.startsWith('started-')).length<3)return;clearInterval(timer);console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',additionalContext:'Independent context'}}))},10);setTimeout(()=>process.exit(3),3000).unref()`)
  const handler = { type: 'command', command: `"${process.execPath}" "${script}"`, timeout: 4 }
  const specs = (['claude-code', 'codex'] as const).map((dialect, index) => ({ id: dialect, dialect, path: join(root, `source-${index}.json`) }))
  for (const spec of specs) await writeFile(spec.path, JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: spec.dialect === 'claude-code' ? [handler, handler] : [handler] }] } }))
  const sources = await loadSources(specs)
  const result = await dispatchEvent(sources, event(root), { environment: { SHELL: '/bin/sh' }, projectRoot: root })
  assert.deepEqual(result.entries.map(entry => entry.sourceID), ['claude-code', 'claude-code', 'codex'])
  assert.deepEqual(result.entries.map(entry => entry.configuredOrder), [0, 1, 2])
  assert.equal(new Set(result.entries.map(entry => entry.completionOrder)).size, 3)
  assert.ok(result.entries.every(entry => entry.result.status === 'success'))
  assert.ok(result.entries.every(entry => entry.sourceDigest === sources.find(source => source.id === entry.sourceID)?.digest))
  assert.equal(result.actions.filter(row => row.action.kind === 'context').length, 3)
  assert.equal((await readdir(root)).filter(name => name.startsWith('started-')).length, 3)
  for (const name of (await readdir(root)).filter(name => name.startsWith('started-'))) assert.equal(JSON.parse(await readFile(join(root, name), 'utf8')).tool_input.command, 'original')
  assert.equal(JSON.stringify(result.diagnostic).includes(script), false)
  assert.equal(JSON.stringify(result.diagnostic).includes('Independent context'), false)
})

test('configured reporting order is independent of native completion order and denial survives later approval', { timeout: 5000 }, async t => {
  const { dispatchEvent } = await import('../src/engine.js')
  const root = await fixture(t)
  const pending = new Map<string, (text: string) => void>()
  let ready!: () => void
  const started = new Promise<void>(resolve => { ready = resolve })
  const sources = [source('claude', 'claude-code', ['first', 'second'].map(tool => ({ type: 'mcp_tool', server: 'fixture', tool, input: {} }))), source('codex', 'codex', [{ type: 'mcp_tool', server: 'fixture', tool: 'third', input: {} }])]
  const dispatch = dispatchEvent(sources, event(root), { environment: {}, projectRoot: root, mcp: { timeoutAccounting: 'exclude-elicitation', execute: request => new Promise(resolve => { pending.set(request.tool, text => resolve({ text })); if (pending.size === 3) ready() }) } })
  await started
  pending.get('third')!('{}')
  await setImmediate()
  pending.get('first')!(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Denied' } }))
  await setImmediate()
  pending.get('second')!(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } }))
  const result = await dispatch
  assert.deepEqual(result.entries.map(entry => entry.completionOrder), [1, 2, 0])
  assert.equal(result.permission?.action.decision, 'deny')
  assert.equal(result.permission?.sourceID, 'claude')
  assert.deepEqual(result.actions.flatMap(row => row.action.kind === 'permission' ? [row.action.decision] : []), ['deny', 'allow'])
})

test('Claude model hooks have their own bounded concurrency and queued work uses the original dispatch snapshot', { timeout: 5000 }, async t => {
  const { dispatchEvent } = await import('../src/engine.js')
  const root = await fixture(t)
  const handlers = Array.from({ length: 13 }, (_, index) => ({ type: 'prompt', prompt: `Prompt ${index}`, timeout: 0.1 } as const))
  const sources = [source('claude', 'claude-code', handlers)]
  let active = 0
  let maximum = 0
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let ready!: () => void
  const started = new Promise<void>(resolve => { ready = resolve })
  const prompts: string[] = []
  const input = event(root)
  const controller = new AbortController()
  const host = { environment: {}, projectRoot: root, signal: controller.signal, evaluatePrompt: async (request: { prompt: string }) => {
    prompts.push(request.prompt)
    active++
    maximum = Math.max(maximum, active)
    if (prompts.length === 12) ready()
    if (prompts.length <= 12) await gate
    active--
    return { ok: true }
  } }
  const dispatch = dispatchEvent(sources, input, host)
  await started
  assert.equal(prompts.length, 12)
  ;(handlers[12] as { prompt: string }).prompt = 'PRIVATE_MUTATION'
  ;(input.toolInput as { command: string }).command = 'PRIVATE_MUTATION'
  host.signal = new AbortController().signal
  release()
  const result = await dispatch
  assert.equal(maximum, 12)
  assert.ok(result.entries.every(entry => entry.result.status === 'success'))
  assert.equal(prompts.length, 13)
  assert.ok(prompts[12]?.includes('Prompt 12'))
  assert.equal(prompts[12]?.includes('PRIVATE_MUTATION'), false)
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
})

test('invalid matcher diagnostics identify the registration without suppressing other matching hooks', async t => {
  const { dispatchEvent } = await import('../src/engine.js')
  const root = await fixture(t)
  const loaded = source('claude', 'claude-code', [{ type: 'prompt', prompt: 'Bad matcher' }, { type: 'prompt', prompt: 'Good matcher' }])
  const sources = [{ ...loaded, registrations: loaded.registrations.map((registration, index) => ({ ...registration, matcher: index === 0 ? '[PRIVATE_MATCHER' : 'Bash' })) }]
  let evaluated = 0
  const result = await dispatchEvent(sources, event(root), { environment: {}, projectRoot: root, evaluatePrompt: async () => { evaluated++; return { ok: true } } })
  assert.equal(evaluated, 1)
  assert.equal(result.entries[0]?.result.code, 'MATCHER_INVALID')
  assert.equal(result.entries[1]?.result.status, 'success')
  assert.equal(result.diagnostic.failed, 1)
  assert.equal(JSON.stringify(result.diagnostic).includes('PRIVATE_MATCHER'), false)
})

test('cancelled dispatches drain active and queued services without delivering late actions or leaking listeners', { timeout: 5000 }, async t => {
  const { dispatchEvent } = await import('../src/engine.js')
  const root = await fixture(t)
  const controller = new AbortController()
  let started!: () => void
  const ready = new Promise<void>(resolve => { started = resolve })
  let calls = 0
  const sources = [source('claude', 'claude-code', Array.from({ length: 13 }, () => ({ type: 'prompt', prompt: 'Wait' })))]
  const dispatch = dispatchEvent(sources, event(root), { environment: {}, projectRoot: root, signal: controller.signal, evaluatePrompt: async () => { if (++calls === 12) started(); return new Promise(() => {}) } })
  await ready
  controller.abort()
  const result = await dispatch
  assert.equal(result.cancelled, true)
  assert.deepEqual(result.actions, [])
  assert.equal(result.entries.length, 13)
  assert.equal(calls, 12)
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
})

test('unsupported service requirements remain explicit instead of counting as successful dispatch', async t => {
  const { dispatchEvent } = await import('../src/engine.js')
  const root = await fixture(t)
  const sources = [source('claude', 'claude-code', [{ type: 'prompt', prompt: 'Requires model' }]), source('codex', 'codex', [{ type: 'prompt' }])]
  const result = await dispatchEvent(sources, event(root), { environment: {}, projectRoot: root })
  assert.equal(result.entries[0]?.result.status, 'unsupported')
  assert.equal(result.entries[1]?.result.status, 'skipped')
  assert.equal(result.diagnostic.unsupported, 1)
  assert.equal(result.diagnostic.skipped, 1)
})

test('background completions retain the source revision selected before caller mutation', async t => {
  const { dispatchEvent } = await import('../src/engine.js')
  const { BackgroundManager } = await import('../src/background.js')
  const root = await fixture(t)
  const manager = new BackgroundManager()
  t.after(() => manager.dispose())
  const sources = [source('claude', 'claude-code', [{ type: 'command', command: process.execPath, args: ['-e', `setTimeout(()=>console.log('{"systemMessage":"Background context"}'),30)`], async: true }])]
  const dispatch = dispatchEvent(sources, event(root), { environment: {}, projectRoot: root, background: manager })
  ;(sources[0] as { digest: string }).digest = 'changed-revision'
  const result = await dispatch
  assert.equal(result.entries[0]?.result.status, 'background')
  assert.equal(result.entries[0]?.result.diagnostic.sourceDigest, 'revision-claude')
  await manager.waitForIdle('session')
  assert.equal(manager.inspect('session').history[0]?.sourceDigest, 'revision-claude')
  await manager.deliver('session', 'safe-point', records => { assert.equal(records[0]?.sourceDigest, 'revision-claude') })
})
