import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { mkdtemp, readFile, writeFile, access, rm, realpath } from 'node:fs/promises'
import { watch } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getEventListeners } from 'node:events'
import type { Dialect } from '../src/contracts.js'
import type { NativeEvent, Registration } from '../src/types.js'

async function fixture(t: TestContext): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'harness-background-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}
function event(root: string, sessionID = 'session'): NativeEvent {
  return { event: 'PreToolUse', sessionID, cwd: root, tool: 'bash', toolInput: { command: 'original' }, data: { transcript_path: '/artifacts/transcript.jsonl', permission_mode: 'default', model: 'fixture', turn_id: 'turn', tool_use_id: 'call' } }
}
function registration(dialect: Dialect, id = 'hook'): Registration {
  return { id, sourceID: 'source', dialect, event: 'PreToolUse', groupIndex: 0, handlerIndex: 0, handler: { type: 'command', command: 'fixture', async: true } }
}
function work(root: string, dialect: Dialect, script: string, options: { sessionID?: string; timeoutMs?: number; id?: string } = {}) {
  return { registration: registration(dialect, options.id), event: event(root, options.sessionID), invocation: { command: process.execPath, args: ['-e', script], cwd: root, env: { PATH: process.env.PATH }, stdin: '{}', timeoutMs: options.timeoutMs ?? 5000 } }
}
function readyFile(root: string, file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const watcher = watch(root, (_type, name) => { if (String(name) === file) void check() })
    const timer = setTimeout(() => { watcher.close(); reject(new Error('Fixture readiness timed out')) }, 5000)
    async function check() {
      try { const value = await readFile(join(root, file), 'utf8'); clearTimeout(timer); watcher.close(); resolve(value) } catch {}
    }
    void check()
  })
}
const contextScript = `console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',additionalContext:'Context'}}))`

test('background submission returns before completion and delivery preserves distinct native channels without controls', async t => {
  const { BackgroundManager } = await import('../src/background.js')
  const { executeRegistration } = await import('../src/handlers.js')
  const root = await fixture(t)
  const manager = new BackgroundManager()
  t.after(() => manager.dispose())
  const hook = { ...registration('claude-code'), handler: { type: 'command', command: process.execPath, args: ['-e', `setTimeout(()=>console.log(JSON.stringify({continue:false,systemMessage:'PRIVATE_MODEL_TEXT',hookSpecificOutput:{hookEventName:'PreToolUse',additionalContext:'Context'}})),100)`], async: true, timeout: 0.01 } } as const
  const result = await executeRegistration(hook, event(root), { environment: {}, projectRoot: root, background: manager })
  assert.equal(result.status, 'background')
  assert.deepEqual(result.actions, [])
  assert.equal(manager.inspect('session').active, 1)
  assert.equal(manager.inspect('session').pending, 0)
  await manager.waitForIdle('session')
  const delivered: unknown[] = []
  await manager.deliver('session', 'safe-point', records => { delivered.push(...records.flatMap(record => record.actions)) })
  assert.deepEqual(delivered, [
    { kind: 'context', text: 'PRIVATE_MODEL_TEXT', placement: 'model', channel: 'systemMessage' },
    { kind: 'context', text: 'Context', placement: 'model', channel: 'additionalContext' },
  ])
  assert.equal(JSON.stringify(manager.inspect('session')).includes('PRIVATE_MODEL_TEXT'), false)
  assert.equal(manager.inspect('session').pending, 0)
})

test('Codex background jobs run independently with per-session concurrency and queued deadlines starting at execution', async t => {
  const { BackgroundManager } = await import('../src/background.js')
  const root = await fixture(t)
  let maximum = 0
  const manager = new BackgroundManager({ onEvent: () => { maximum = Math.max(maximum, manager.inspect('session').active) } })
  t.after(() => manager.dispose())
  const gate = `const fs=require('node:fs');let done=false;const finish=()=>{if(done)return;done=true;watcher.close();${contextScript}};const watcher=fs.watch('.',(_type,name)=>{if(name==='release')finish()});if(fs.existsSync('release'))finish()`
  const ids = []
  for (let index = 0; index < 8; index++) ids.push(manager.enqueue(work(root, 'codex', gate)))
  const prepared = work(root, 'codex', `console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',additionalContext:process.env.VALUE}}))`, { timeoutMs: 500 })
  const queuedWork = { ...prepared, invocation: { ...prepared.invocation, env: { ...prepared.invocation.env, VALUE: 'Context' } } }
  const queued = manager.enqueue(queuedWork)
  queuedWork.invocation.args[1] = 'console.log("PRIVATE_CHANGED_COMMAND")'
  queuedWork.invocation.env.VALUE = 'PRIVATE_CHANGED_ENV'
  assert.equal(queued.status, 'accepted')
  assert.equal(manager.inspect('session').active, 8)
  assert.equal(manager.inspect('session').queued, 1)
  manager.enqueue(work(root, 'codex', contextScript, { sessionID: 'other' }))
  await manager.waitForIdle('other')
  assert.equal(manager.inspect('other').pending, 1)
  await new Promise(resolve => setTimeout(resolve, 600))
  await writeFile(join(root, 'release'), '')
  await manager.waitForIdle('session')
  assert.equal(maximum, 8)
  assert.equal(manager.inspect('session').pending, 9)
  const history = manager.inspect('session').history
  const last = history.find(record => record.jobID === (queued.status === 'accepted' ? queued.id : ''))
  assert.equal(last?.outcome, 'success')
  assert.ok((last?.queuedMs ?? 0) >= 500)
  assert.equal(new Set([...ids, queued].map(row => row.status === 'accepted' ? row.id : '')).size, 9)
  await manager.deliver('session', 'safe-point', records => { assert.ok(records.every(record => record.actions.every(action => action.kind === 'context' && action.text === 'Context'))) })
})

test('delivery commits only after the host accepts the batch and serializes concurrent claims', async t => {
  const { BackgroundManager } = await import('../src/background.js')
  const root = await fixture(t)
  const manager = new BackgroundManager()
  t.after(() => manager.dispose())
  manager.enqueue(work(root, 'claude-code', contextScript))
  await manager.waitForIdle('session')
  await assert.rejects(manager.deliver('session', 'safe-point', () => { throw new Error('PRIVATE_HOST_ERROR') }))
  assert.equal(manager.inspect('session').pending, 1)
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let received = 0
  const first = manager.deliver('session', 'safe-point', async records => { received += records.length; await gate })
  const second = manager.deliver('session', 'safe-point', records => { received += records.length })
  release()
  await Promise.all([first, second])
  assert.equal(received, 1)
  assert.equal(manager.inspect('session').pending, 0)
  assert.equal(JSON.stringify(manager.inspect('session')).includes('PRIVATE_HOST_ERROR'), false)
})

test('session disposal kills running children, drops queued work and pending output, and prevents stale reuse', async t => {
  const { BackgroundManager } = await import('../src/background.js')
  const root = await fixture(t)
  const manager = new BackgroundManager()
  t.after(() => manager.dispose())
  const ready = readyFile(root, 'ready')
  const script = `const fs=require('node:fs');process.on('SIGTERM',()=>{});fs.writeFileSync('ready.tmp',String(process.pid));fs.renameSync('ready.tmp','ready');setTimeout(()=>fs.writeFileSync('late-effect','bad'),2000)`
  manager.enqueue(work(root, 'claude-code', script))
  const pid = Number(await ready)
  await manager.disposeSession('session')
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
  await assert.rejects(access(join(root, 'late-effect')))
  assert.equal(manager.inspect('session').pending, 0)
  assert.equal(manager.enqueue(work(root, 'claude-code', contextScript)).status, 'failed')
  manager.beginSession('session')
  manager.enqueue(work(root, 'claude-code', contextScript))
  await manager.waitForIdle('session')
  assert.equal(manager.inspect('session').pending, 1)
})

test('turn cancellation leaves background work alive while the session signal cancels all of its work', async t => {
  const { BackgroundManager } = await import('../src/background.js')
  const { executeRegistration } = await import('../src/handlers.js')
  const root = await fixture(t)
  const manager = new BackgroundManager()
  t.after(() => manager.dispose())
  const turn = new AbortController()
  const session = new AbortController()
  const hook = { ...registration('claude-code'), handler: { type: 'command', command: process.execPath, args: ['-e', `setTimeout(()=>{${contextScript}},100)`], async: true } } as const
  await executeRegistration(hook, event(root), { environment: {}, projectRoot: root, background: manager, signal: turn.signal, sessionSignal: session.signal })
  turn.abort()
  await manager.waitForIdle('session')
  assert.equal(manager.inspect('session').pending, 1)
  session.abort()
  await manager.waitForIdle('session')
  assert.equal(manager.inspect('session').pending, 0)
  assert.equal(getEventListeners(session.signal, 'abort').length, 0)
})

test('explicit background limits retain diagnostics without source text', async t => {
  const { BackgroundManager } = await import('../src/background.js')
  const root = await fixture(t)
  const manager = new BackgroundManager({ maxQueuedJobs: 0, maxPendingBytes: 10 })
  t.after(() => manager.dispose())
  for (let index = 0; index < 8; index++) manager.enqueue(work(root, 'codex', `setTimeout(()=>{${contextScript}},100)`))
  const rejected = manager.enqueue(work(root, 'codex', 'PRIVATE_COMMAND'))
  assert.equal(rejected.status, 'failed')
  assert.equal(rejected.code, 'BACKGROUND_QUEUE_LIMIT')
  await manager.waitForIdle('session')
  assert.equal(manager.inspect('session').pending, 0)
  assert.equal(manager.inspect('session').history.at(-1)?.code, 'BACKGROUND_DELIVERY_LIMIT')
  assert.equal(JSON.stringify(manager.inspect('session')).includes('PRIVATE_COMMAND'), false)
})

test('Codex SessionEnd stays synchronous even with a background manager configured', async t => {
  const { BackgroundManager } = await import('../src/background.js')
  const { executeRegistration } = await import('../src/handlers.js')
  const root = await fixture(t)
  const manager = new BackgroundManager()
  t.after(() => manager.dispose())
  const hook = { ...registration('codex'), event: 'SessionEnd', handler: { type: 'command', command: 'printf done > "$SESSION_END_CAPTURE"', async: true } } as const
  const result = await executeRegistration(hook, { ...event(root), event: 'SessionEnd', data: { reason: 'other' } }, { environment: { SHELL: '/bin/sh', SESSION_END_CAPTURE: join(root, 'end') }, projectRoot: root, background: manager })
  assert.equal(result.status, 'success')
  assert.equal(await readFile(join(root, 'end'), 'utf8'), 'done')
  assert.equal(manager.inspect('session').history.length, 0)
})

test('reentrant disposal during queue notification cannot launch work after the session closes', async t => {
  const { BackgroundManager } = await import('../src/background.js')
  const root = await fixture(t)
  let disposal: Promise<void> | undefined
  const manager = new BackgroundManager({ onEvent: record => { if (record.phase === 'queued') disposal = manager.disposeSession('session') } })
  t.after(() => manager.dispose())
  manager.enqueue(work(root, 'claude-code', `require('node:fs').writeFileSync('forbidden','bad')`))
  await disposal
  await manager.waitForIdle('session')
  assert.equal(manager.inspect('session').active, 0)
  assert.equal(manager.inspect('session').queued, 0)
  await assert.rejects(access(join(root, 'forbidden')))
})

test('asyncRewake needs an explicit wake service and sends only its native failure reminder', async t => {
  const { BackgroundManager } = await import('../src/background.js')
  const { executeRegistration } = await import('../src/handlers.js')
  const root = await fixture(t)
  const absent = new BackgroundManager()
  t.after(() => absent.dispose())
  const hook = { ...registration('claude-code'), handler: { type: 'command', command: process.execPath, args: ['-e', `console.log('{"systemMessage":"Ignored JSON"}');console.error('React to failure');process.exit(2)`], async: true, asyncRewake: true } } as const
  assert.equal((await executeRegistration(hook, event(root), { environment: {}, projectRoot: root, background: absent })).status, 'unsupported')
  assert.equal(absent.inspect('session').active, 0)
  const received: unknown[] = []
  const manager = new BackgroundManager({ wake: notice => { received.push(...notice.delivery.actions); assert.equal(notice.signal.aborted, false) } })
  t.after(() => manager.dispose())
  const result = await executeRegistration(hook, event(root), { environment: {}, projectRoot: root, background: manager })
  assert.equal(result.status, 'background')
  await manager.waitForIdle('session')
  assert.deepEqual(received, [{ kind: 'native-extension', name: 'asyncRewake', value: 'React to failure\n' }])
  assert.equal(manager.inspect('session').pending, 0)
})

test('rewake deadlines apply with both flags set and disposal aborts a pending wake operation', async t => {
  const { BackgroundManager } = await import('../src/background.js')
  const { executeRegistration } = await import('../src/handlers.js')
  const root = await fixture(t)
  let calls = 0
  const manager = new BackgroundManager({ wake: () => { calls++ } })
  t.after(() => manager.dispose())
  const hook = { ...registration('claude-code'), handler: { type: 'command', command: process.execPath, args: ['-e', `setTimeout(()=>{require('node:fs').writeFileSync('late','bad');process.exit(2)},1000)`], async: true, asyncRewake: true, timeout: 0.02 } } as const
  await executeRegistration(hook, event(root), { environment: {}, projectRoot: root, background: manager })
  await manager.waitForIdle('session')
  assert.equal(calls, 0)
  assert.equal(manager.inspect('session').history.at(-1)?.code, 'EXECUTION_TIMEOUT')
  await assert.rejects(access(join(root, 'late')))
  let signal: AbortSignal | undefined
  let ready!: () => void
  const started = new Promise<void>(resolve => { ready = resolve })
  const blocked = new BackgroundManager({ wake: async notice => { signal = notice.signal; ready(); return new Promise(() => {}) } })
  t.after(() => blocked.dispose())
  const pending = work(root, 'claude-code', `console.error('Wake');process.exit(2)`)
  blocked.enqueue({ ...pending, registration: { ...pending.registration, handler: { ...pending.registration.handler, asyncRewake: true } } })
  await started
  await blocked.disposeSession('session')
  assert.equal(signal?.aborted, true)
  assert.equal(blocked.inspect('session').waking, 0)
  assert.equal(blocked.inspect('session').pending, 0)
})

test('failed wake delivery remains retryable and asynchronous telemetry failures remain private', async t => {
  const { BackgroundManager } = await import('../src/background.js')
  const root = await fixture(t)
  const manager = new BackgroundManager({ wake: async () => { throw new Error('PRIVATE_WAKE_ERROR') }, onEvent: async () => { throw new Error('PRIVATE_LOG_ERROR') } })
  t.after(() => manager.dispose())
  const pending = work(root, 'claude-code', `console.error('Wake');process.exit(2)`)
  manager.enqueue({ ...pending, registration: { ...pending.registration, handler: { ...pending.registration.handler, asyncRewake: true } } })
  await manager.waitForIdle('session')
  assert.equal(manager.inspect('session').pending, 1)
  assert.equal(manager.inspect('session').history.at(-1)?.code, 'BACKGROUND_WAKE_FAILED')
  assert.ok(manager.inspect('session').observerFailures > 0)
  await manager.deliver('session', 'wake', records => { assert.equal(records.length, 1) })
  assert.equal(manager.inspect('session').pending, 0)
  assert.equal(JSON.stringify(manager.inspect('session')).includes('PRIVATE_'), false)
})
