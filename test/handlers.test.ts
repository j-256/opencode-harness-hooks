import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { mkdtemp, readFile, writeFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Dialect } from '../src/contracts.js'
import type { Handler, NativeEvent, Registration } from '../src/types.js'

async function fixture(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'harness-handler-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return realpath(root)
}

function registration(dialect: Dialect, handler: Handler, event = 'PreToolUse'): Registration {
  return { id: `${dialect}:fixture`, sourceID: dialect, dialect, event, groupIndex: 0, handlerIndex: 0, handler }
}

function event(cwd: string, name = 'PreToolUse'): NativeEvent {
  return { event: name, sessionID: 'session', cwd, tool: 'bash', toolInput: { command: 'original' }, data: {
    transcript_path: '/artifacts/transcript.jsonl', permission_mode: 'default', model: 'test-model', turn_id: 'turn', tool_use_id: 'call',
    source: 'startup', stop_hook_active: false, last_assistant_message: 'done', reason: 'other',
  } }
}

const environment = { PATH: process.env.PATH, SHELL: '/bin/sh' }

test('command artifact capture is opt-in and excludes stdin and environment from records and diagnostics', async t => {
  const { executeRegistration } = await import('../src/handlers.js')
  const root = await fixture(t)
  const hook = registration('claude-code', { type: 'command', command: process.execPath, args: ['-e', 'process.stdout.write("PRIVATE_STDOUT\\n");process.stderr.write("PRIVATE_STDERR")', "literal space 'quote'"] }, 'UserPromptSubmit')
  const input = { ...event(root, 'UserPromptSubmit'), data: { ...event(root).data, prompt: 'PRIVATE_PROMPT' } }
  const host = { environment: { ...environment, PRIVATE_ENV: 'PRIVATE_VALUE' }, projectRoot: root }
  const ordinary = await executeRegistration(hook, input, host)
  assert.equal('commandArtifact' in ordinary, false)
  const captured = await executeRegistration(hook, input, { ...host, captureCommandArtifacts: true })
  assert.ok('commandArtifact' in captured && captured.commandArtifact)
  const artifact = captured.commandArtifact
  assert.equal(artifact.command, [process.execPath, ...hook.handler.args!].join(' '))
  assert.equal(artifact.stdout, 'PRIVATE_STDOUT\n')
  assert.equal(artifact.stderr, 'PRIVATE_STDERR')
  assert.equal(artifact.exitCode, 0)
  assert.equal(artifact.status, 'exited')
  assert.equal(artifact.timeoutMs, 30_000)
  assert.ok(artifact.durationMs >= 0)
  assert.ok(artifact.completedAt > 0)
  for (const excluded of ['PRIVATE_PROMPT', 'PRIVATE_VALUE']) assert.equal(JSON.stringify(artifact).includes(excluded), false)
  for (const excluded of ['PRIVATE_STDOUT', 'PRIVATE_STDERR', 'literal space']) assert.equal(JSON.stringify(captured.diagnostic).includes(excluded), false)
})

test('command artifact deadlines retain the effective shared budget for a timed-out execution', async t => {
  const { executeRegistration } = await import('../src/handlers.js')
  const root = await fixture(t)
  const hook = registration('claude-code', { type: 'command', command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], timeout: 10 }, 'UserPromptSubmit')
  const result = await executeRegistration(hook, { ...event(root, 'UserPromptSubmit'), data: { ...event(root).data, prompt: 'Deadline fixture' } }, { environment, projectRoot: root, captureCommandArtifacts: true, remainingBudgetMs: 125 })
  assert.equal(result.code, 'EXECUTION_TIMEOUT')
  assert.ok('commandArtifact' in result && result.commandArtifact)
  assert.equal(result.commandArtifact.status, 'timeout')
  assert.equal(result.commandArtifact.timeoutMs, 125)
  assert.ok(!Object.hasOwn(result.diagnostic, 'timeoutMs'))
})

test('executes Claude commands with literal exec arguments, source paths, input, and isolated environment', async t => {
  const { executeRegistration } = await import('../src/handlers.js')
  const root = await fixture(t)
  const output = join(root, 'capture.json')
  const script = join(root, 'capture.mjs')
  await writeFile(script, `import fs from 'node:fs'; const input = fs.readFileSync(0, 'utf8'); fs.writeFileSync(process.argv[2], JSON.stringify({args:process.argv.slice(3),cwd:process.cwd(),input:JSON.parse(input),env:process.env})); console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:'fixture denial'}}));`)
  const hook = { ...registration('claude-code', { type: 'command', command: process.execPath, args: [script, output, '${CLAUDE_PLUGIN_ROOT}/a', '${user_config.value}', '$(do-not-execute)', '$CLAUDE_PROJECT_DIR'] }), pluginRoot: '/plugin root' }
  const effect = await executeRegistration(hook, event(root), {
    environment: { ...environment, CLAUDE_PLUGIN_ROOT: 'stale', CLAUDE_ENV_FILE: 'parent-file', OTEL_EXPORTER_OTLP_HEADERS: 'PRIVATE_TELEMETRY' },
    projectRoot: '/original project', sourceContext: { 'claude-code': { pluginData: '/plugin data', pluginOptions: { value: 'a $literal `text`' } } },
  })
  assert.equal(effect.status, 'success')
  assert.deepEqual(effect.actions, [{ kind: 'permission', decision: 'deny', reason: 'fixture denial' }])
  const captured = JSON.parse(await readFile(output, 'utf8'))
  assert.deepEqual(captured.args, ['/plugin root/a', 'a $literal `text`', '$(do-not-execute)', '$CLAUDE_PROJECT_DIR'])
  assert.equal(captured.cwd, root)
  assert.equal(captured.input.tool_name, 'Bash')
  assert.deepEqual(captured.input.tool_input, { command: 'original' })
  assert.equal(captured.env.CLAUDE_PROJECT_DIR, '/original project')
  assert.equal(captured.env.CLAUDE_PLUGIN_DATA, '/plugin data')
  assert.equal(captured.env.CLAUDE_PLUGIN_OPTION_VALUE, 'a $literal `text`')
  assert.equal(captured.env.CLAUDE_ENV_FILE, undefined)
  assert.equal(captured.env.OTEL_EXPORTER_OTLP_HEADERS, undefined)
  assert.equal(JSON.stringify(effect.diagnostic).includes('PRIVATE_TELEMETRY'), false)
})

test('Claude shell expansion and exec substitutions stay separate; shell user_config fails without execution', async t => {
  const { executeRegistration } = await import('../src/handlers.js')
  const root = await fixture(t)
  const output = join(root, 'shell.txt')
  const host = { environment: { ...environment, OUTPUT: output }, projectRoot: '/original project' }
  const result = await executeRegistration(registration('claude-code', { type: 'command', command: 'printf "%s" "$CLAUDE_PROJECT_DIR" > "$OUTPUT"' }), event(root), host)
  assert.equal(result.status, 'success')
  assert.equal(await readFile(output, 'utf8'), '/original project')
  const failed = await executeRegistration({ ...registration('claude-code', { type: 'command', command: 'printf bad > "$OUTPUT"; echo "${user_config.secret}"' }), pluginRoot: '/plugin' }, event(root), host)
  assert.equal(failed.status, 'failed')
  assert.equal(await readFile(output, 'utf8'), '/original project')
})

test('Codex commands use its login shell, native environment filtering, and plugin compatibility names', async t => {
  const { executeRegistration } = await import('../src/handlers.js')
  const root = await fixture(t)
  const shell = join(root, 'shell')
  const capture = join(root, 'shell.json')
  await writeFile(shell, `#!${process.execPath}\nimport('node:fs').then(fs => { fs.writeFileSync(process.env.CAPTURE, JSON.stringify({args:process.argv.slice(2),env:process.env})); console.log('{}') })\n`, { mode: 0o755 })
  const effect = await executeRegistration({ ...registration('codex', { type: 'command', command: 'literal command' }), pluginRoot: '/codex plugin' }, event(root), {
    environment: { ...environment, SHELL: shell, CAPTURE: capture, CODEX_THREAD_ID: 'parent-thread', CODEX_TOOL_CALL_ID: 'parent-call', openai_identity_token_file: 'PRIVATE_IDENTITY' },
    projectRoot: root, sourceContext: { codex: { pluginData: '/codex data' } },
  })
  assert.equal(effect.status, 'success')
  const captured = JSON.parse(await readFile(capture, 'utf8'))
  assert.deepEqual(captured.args, ['-lc', 'literal command'])
  assert.equal(captured.env.PLUGIN_ROOT, '/codex plugin')
  assert.equal(captured.env.CLAUDE_PLUGIN_ROOT, '/codex plugin')
  assert.equal(captured.env.PLUGIN_DATA, '/codex data')
  assert.equal(captured.env.CLAUDE_PLUGIN_DATA, '/codex data')
  assert.equal(captured.env.CODEX_THREAD_ID, 'session')
  assert.equal(captured.env.CODEX_TOOL_CALL_ID, 'call')
  assert.equal(captured.env.openai_identity_token_file, undefined)
})

test('uses event-specific seconds defaults, Codex minimums, and shared remaining shutdown budgets', async t => {
  const { prepareCommand } = await import('../src/command-context.js')
  const root = await fixture(t)
  const host = { environment, projectRoot: root }
  for (const [dialect, name, timeout, expected] of [
    ['claude-code', 'PreToolUse', undefined, 600_000], ['claude-code', 'UserPromptSubmit', undefined, 30_000],
    ['claude-code', 'MessageDisplay', undefined, 10_000], ['claude-code', 'SessionEnd', undefined, 1500],
    ['claude-code', 'PreToolUse', 0.02, 20], ['codex', 'PreToolUse', 0, 1000],
    ['codex', 'SessionEnd', 60, 3000], ['codex', 'Interrupt', undefined, 1000],
  ] as const) {
    const hook = registration(dialect, { type: 'command', command: 'unused', ...(timeout === undefined ? {} : { timeout }) }, name)
    const prepared = await prepareCommand(hook, event(root, name), {}, host)
    assert.equal(prepared.timeoutMs, expected)
  }
  const prepared = await prepareCommand(registration('claude-code', { type: 'command', command: 'unused', timeout: 20 }, 'SessionEnd'), event(root, 'SessionEnd'), {}, { ...host, remainingBudgetMs: 12 })
  assert.equal(prepared.timeoutMs, 12)
})

test('honors real command cancellation and deadline failures without leaking command or output', async t => {
  const { executeRegistration } = await import('../src/handlers.js')
  const root = await fixture(t)
  const hook = registration('claude-code', { type: 'command', command: process.execPath, args: ['-e', 'console.error("PRIVATE_OUTPUT");setTimeout(()=>{},10000)'], timeout: 0.03, onFailure: 'block' })
  const timedOut = await executeRegistration(hook, event(root), { environment, projectRoot: root })
  assert.equal(timedOut.status, 'failed')
  assert.equal(timedOut.code, 'EXECUTION_TIMEOUT')
  assert.equal(timedOut.actions[0]?.kind, 'permission')
  assert.equal(JSON.stringify(timedOut.diagnostic).includes('PRIVATE_OUTPUT'), false)
  const controller = new AbortController()
  controller.abort()
  const cancelled = await executeRegistration(hook, event(root), { environment, projectRoot: root, signal: controller.signal })
  assert.equal(cancelled.code, 'EXECUTION_CANCELLED')
})

test('matches native handler availability before consulting services and reports bridge gaps explicitly', async t => {
  const { executeRegistration } = await import('../src/handlers.js')
  const root = await fixture(t)
  const host = { environment, projectRoot: root }
  for (const [dialect, name, handler] of [
    ['codex', 'PreToolUse', { type: 'prompt' }], ['codex', 'Stop', { type: 'agent' }],
    ['claude-code', 'SessionStart', { type: 'http', url: 'http://invalid' }],
    ['claude-code', 'PermissionRequest', { type: 'agent', prompt: 'unused' }],
    ['claude-code', 'Setup', { type: 'mcp_tool', server: 'unused', tool: 'unused' }],
    ['claude-code', 'SessionStart', { type: 'mcp_tool', server: 'unused', tool: 'unused' }],
    ['codex', 'SessionEnd', { type: 'mcp_tool', server: 'unused', tool: 'unused' }],
  ] as const) {
    const result = await executeRegistration(registration(dialect, handler, name), event(root, name), host)
    assert.equal(result.status, 'skipped', `${dialect}/${name}/${handler.type}`)
    assert.deepEqual(result.actions, [])
  }
  const result = await executeRegistration(registration('claude-code', { type: 'command', command: 'unused', if: 'Bash(git *)' }), event(root), host)
  assert.equal(result.status, 'unsupported')
  assert.equal(result.code, 'HOST_CONDITION_UNAVAILABLE')
  const background = await executeRegistration(registration('codex', { type: 'command', command: 'unused', async: true }), event(root), host)
  assert.equal(background.status, 'unsupported')
  assert.equal(background.code, 'HOST_BACKGROUND_UNAVAILABLE')
})

test('Claude conditions receive native tool input and prevent execution when false or on non-tool events', async t => {
  const { executeRegistration } = await import('../src/handlers.js')
  const root = await fixture(t)
  const hook = registration('claude-code', { type: 'command', command: '/definitely-absent-executable', args: [], if: 'Bash(git *)' })
  const host = { environment, projectRoot: root, evaluateCondition: async (rule: string, payload: Readonly<Record<string, unknown>>) => {
    assert.equal(rule, 'Bash(git *)')
    assert.equal(payload.tool_name, 'Bash')
    return false
  } }
  assert.equal((await executeRegistration(hook, event(root), host)).status, 'skipped')
  assert.equal((await executeRegistration({ ...hook, event: 'Stop' }, event(root, 'Stop'), host)).status, 'skipped')
})

test('fallback command cwd preserves the original native payload and initial project root', async t => {
  const { executeRegistration } = await import('../src/handlers.js')
  const root = await fixture(t)
  const output = join(root, 'fallback.json')
  const script = `require('node:fs').writeFileSync(process.argv[1],JSON.stringify({cwd:process.cwd(),project:process.env.CLAUDE_PROJECT_DIR,input:JSON.parse(require('node:fs').readFileSync(0,'utf8'))}))`
  const absent = join(root, 'removed')
  const result = await executeRegistration(registration('claude-code', { type: 'command', command: process.execPath, args: ['-e', script, output] }), event(absent), { environment, projectRoot: '/missing-project', sessionDirectory: root })
  assert.equal(result.status, 'success')
  const captured = JSON.parse(await readFile(output, 'utf8'))
  assert.equal(captured.cwd, root)
  assert.equal(captured.project, '/missing-project')
  assert.equal(captured.input.cwd, absent)
})

test('limits native environment-file access to supported Claude events and ignores shell in exec form', async t => {
  const { prepareCommand } = await import('../src/command-context.js')
  const root = await fixture(t)
  for (const name of ['SessionStart', 'Setup', 'CwdChanged', 'FileChanged', 'PreToolUse']) {
    const hook = registration('claude-code', { type: 'command', command: 'unused', args: [], shell: 'powershell' }, name)
    const host = { environment, projectRoot: root, registrationContext: { [hook.id]: { envFile: '/session/environment' } } }
    const invocation = await prepareCommand(hook, event(root, name), {}, host)
    assert.equal(invocation.env.CLAUDE_ENV_FILE, name === 'PreToolUse' ? undefined : '/session/environment')
  }
})

test('same-source Claude registrations write independent environment files without losing source options', async t => {
  const { executeRegistration } = await import('../src/handlers.js')
  const root = await fixture(t)
  const script = join(root, 'environment.cjs')
  await writeFile(script, `const fs=require('node:fs');const path=process.env.CLAUDE_ENV_FILE;fs.appendFileSync(path,'export FIXTURE=value\\n');fs.writeFileSync(path+'.json',JSON.stringify({data:process.env.CLAUDE_PLUGIN_DATA,option:process.env.CLAUDE_PLUGIN_OPTION_NAME}));`)
  const first = { ...registration('claude-code', { type: 'command', command: process.execPath, args: [script] }, 'SessionStart'), id: 'same-source:first' }
  const second = { ...first, id: 'same-source:second', handlerIndex: 1 }
  const host = {
    environment: { ...environment, CLAUDE_ENV_FILE: 'unowned-parent-file' }, projectRoot: root,
    sourceContext: { 'claude-code': { pluginData: '/plugin-data', pluginOptions: { name: 'source-option' } } },
    registrationContext: { [first.id]: { envFile: join(root, 'first.sh') }, [second.id]: { envFile: join(root, 'second.sh') } },
  }
  const results = await Promise.all([first, second].map(hook => executeRegistration(hook, event(root, 'SessionStart'), host)))
  assert.deepEqual(results.map(result => result.status), ['success', 'success'])
  for (const name of ['first', 'second']) {
    assert.equal(await readFile(join(root, name + '.sh'), 'utf8'), 'export FIXTURE=value\n')
    assert.deepEqual(JSON.parse(await readFile(join(root, name + '.sh.json'), 'utf8')), { data: '/plugin-data', option: 'source-option' })
  }
  for (const result of results) assert.equal(JSON.stringify(result.diagnostic).includes(root), false)
})

test('captures event and source context before asynchronous services can observe caller changes', async t => {
  const { executeRegistration } = await import('../src/handlers.js')
  const root = await fixture(t)
  const capture = join(root, 'snapshot.json')
  const input = { ...event(root), toolInput: { command: 'original' } }
  const sourceContext = { 'claude-code': { pluginOptions: { option: 'original' } } }
  const hostEnv = { ...environment, CAPTURE: capture, SNAPSHOT: 'original' }
  let release!: (value: boolean) => void
  const condition = new Promise<boolean>(resolve => { release = resolve })
  const script = `require('node:fs').writeFileSync(process.env.CAPTURE,JSON.stringify({input:JSON.parse(require('node:fs').readFileSync(0,'utf8')),env:process.env.SNAPSHOT,option:process.env.CLAUDE_PLUGIN_OPTION_OPTION}))`
  const running = executeRegistration(registration('claude-code', { type: 'command', command: process.execPath, args: ['-e', script], if: 'Bash(*)' }), input, {
    environment: hostEnv, projectRoot: root, sourceContext, evaluateCondition: () => condition,
  })
  input.toolInput.command = 'changed'
  hostEnv.SNAPSHOT = 'changed'
  sourceContext['claude-code'].pluginOptions.option = 'changed'
  release(true)
  assert.equal((await running).status, 'success')
  const captured = JSON.parse(await readFile(capture, 'utf8'))
  assert.equal(captured.input.tool_input.command, 'original')
  assert.equal(captured.env, 'original')
  assert.equal(captured.option, 'original')
})
