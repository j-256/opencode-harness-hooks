#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { access, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs, promisify } from 'node:util'

const VERSIONS = Object.freeze({ v1: '1.19.5', v2: '2.2.5' })
const DIALECTS = new Set(['codex', 'claude-code', 'mixed'])
const STARTUP_MS = 15000
const CLIENT_MS = 30000
const SHUTDOWN_MS = 3000
const MAX_BYTES = 2 * 1024 * 1024
const MAX_REQUESTS = 16
const CONTROLLED_TOOL_CALLS = 2
const PROMPT_HANDLERS = 4
const PROMPT_TIMEOUT_SECONDS = 1
const SECOND_MS = 1000
const CODEX_PROMPT_CONTEXTS = Object.freeze([{ role: 'developer', content: 'PACKAGE_CODEX_PROMPT_CONTEXT' }, { role: 'developer', content: 'PACKAGE_CODEX_SECOND_CONTEXT' }])
const PROMPT_SUBMISSIONS = 3
const run = promisify(execFile)
const HELP = `Usage: node scripts/verify-plugin.mjs --host v1|v2 [-b PATH] [--dialect NAME] [--preapproval] [--prompts] [-s]

Verify the built package's default entrypoint, native options and tool enforcement
against a pinned OpenCode host. Requires npm run build, Node.js 22+, Git and the
host executable. Uses isolated temporary state and a loopback synthetic provider.
No installation, live configuration changes or model account is needed.

Options:
      --host VERSION  Required: v1 (${VERSIONS.v1}) or v2 (${VERSIONS.v2})
  -b, --binary PATH   Host executable (OPENCODE_V1_BINARY/OPENCODE_V2_BINARY,
                     then opencode)
      --dialect NAME Native source: codex (default), claude-code, or mixed (both)
      --preapproval  Exercise Claude allow with host permissions set to ask
      --prompts      Check prompt blocking, context roles and retained history
  -s, --stop-rejection  Verify V1's expected fatal load rejection for Stop configs
                       V1 only; cannot combine with --prompts or --preapproval
  -h, --help          Show help without requiring a host or dependencies

Success writes JSON to stdout; failures use stderr without provider traffic.
Exit status: 0 verified; 1 runtime/check failure; 2 usage/version; 3 dependency.
This exercises a synthetic native source with a fixture-declared permission mode.
Native artifact, trust, lifecycle and full dialect parity remain separate gates.
`

class ProbeError extends Error {
  constructor(code, status = 1) { super(code); this.status = status }
}
function quote(value) { return "'" + value.replaceAll("'", "'\"'\"'") + "'" }
async function bounded(operation, ms, code) {
  let timer
  try { return await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(new ProbeError(code)), ms) })]) } finally { clearTimeout(timer) }
}
async function dependency(program, args, name) {
  try { return await run(program, args, { timeout: STARTUP_MS, maxBuffer: MAX_BYTES }) } catch (error) {
    throw new ProbeError(error.code === 'ENOENT' || error.code === 'EACCES' ? 'DEPENDENCY_UNAVAILABLE: ' + name : 'DEPENDENCY_QUERY_FAILED: ' + name, error.code === 'ENOENT' || error.code === 'EACCES' ? 3 : 1)
  }
}
async function stop(child, done) {
  if (!child || !done) return
  if (child.exitCode === null && child.signalCode === null && child.pid) {
    try { process.kill(-child.pid, 'SIGTERM') } catch (error) { if (error.code !== 'ESRCH') throw error }
    try { await bounded(done, SHUTDOWN_MS, 'HOST_SHUTDOWN_TIMEOUT') } catch {
      try { process.kill(-child.pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
    }
  }
  await bounded(done, SHUTDOWN_MS, 'HOST_CLEANUP_FAILED')
}

async function verify(hostVersion, binary, dialect, preapproval, prompts, stopRejection) {
  const version = (await dependency(binary, ['--version'], 'OpenCode')).stdout.trim().replace(/^opencode v/, '')
  if (version !== VERSIONS[hostVersion]) throw new ProbeError('HOST_VERSION_MISMATCH: expected ' + VERSIONS[hostVersion], 2)
  await dependency('git', ['--version'], 'Git')
  const packageDirectory = fileURLToPath(new URL('..', import.meta.url))
  const entrypoint = fileURLToPath(new URL('../dist/index.js', import.meta.url))
  try { await access(entrypoint) } catch { throw new ProbeError('DEPENDENCY_UNAVAILABLE: built package', 3) }
  const root = await realpath(await mkdtemp(join(tmpdir(), 'harness-package-')))
  const password = randomBytes(32).toString('base64url')
  let gateway
  let child
  let done
  let stage = 'setup'
  const diagnosticCodes = new Set()
  try {
    const project = join(root, 'project')
    const config = join(root, 'config/opencode')
    const denied = join(root, 'forbidden')
    const rewritten = join(root, 'rewritten')
    const capture = join(root, 'payloads.jsonl')
    const sourcePath = join(root, 'hooks.json')
    const script = join(root, 'hook.cjs')
    const originalCommand = 'printf original > ' + quote(rewritten)
    const replacementCommand = 'printf rewritten > ' + quote(rewritten)
    await Promise.all([mkdir(project), mkdir(config, { recursive: true }), mkdir(join(root, 'tmp'))])
    const env = {
      PATH: process.env.PATH, SHELL: '/bin/sh', LANG: 'en_US.UTF-8', TMPDIR: join(root, 'tmp'),
      HOME: root, PWD: project, XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'), XDG_STATE_HOME: join(root, 'state'), XDG_CACHE_HOME: join(root, 'cache'),
      OPENCODE_CONFIG_DIR: config, OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_CLAUDE_CODE: '1', OPENCODE_DISABLE_DEFAULT_PLUGINS: '1', OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
      OPENCODE_PASSWORD: password,
    }
    await run('git', ['init', '-q', project], { env, timeout: STARTUP_MS })
    await writeFile(script, String.raw`const fs = require('node:fs')
const input = JSON.parse(fs.readFileSync(0, 'utf8'))
const codex = typeof input.turn_id === 'string'
if (input.hook_event_name === 'UserPromptSubmit') {
  const exists = !codex && fs.existsSync(input.transcript_path)
  const mode = process.argv[2] ?? 'additional'
  const historyAttachments = exists && fs.readFileSync(input.transcript_path, 'utf8').includes('hook_additional_context') && fs.readFileSync(input.transcript_path, 'utf8').includes('hook_success')
  fs.appendFileSync(${JSON.stringify(capture)}, JSON.stringify({ ...input, promptTranscriptExists: exists, promptHistoryAttachments: historyAttachments, promptMode: mode, nativeDialect: codex ? 'codex' : 'claude-code' }) + '\n')
  if (input.prompt.includes('Block the controlled prompt')) console.log(JSON.stringify({ decision: 'block', reason: 'PACKAGE_PROMPT_BLOCKED' }))
  else if (mode === 'timeout') { process.stdout.write('PACKAGE_TIMEOUT_STDOUT\n'); process.stderr.write('PACKAGE_TIMEOUT_STDERR\n'); setInterval(() => {}, 1000) }
  else setTimeout(() => {
    if (mode === 'failure') { process.stdout.write('PACKAGE_FAILURE_STDOUT\n'); process.stderr.write('PACKAGE_FAILURE_STDERR\n'); process.exit(1) }
    if (!codex && mode === 'stdout') { process.stdout.write('PACKAGE_CLAUDE_STDOUT_CONTEXT\n'); process.stderr.write('PACKAGE_STDOUT_STDERR\n') }
    else console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: codex ? mode === 'stdout' ? 'PACKAGE_CODEX_SECOND_CONTEXT' : 'PACKAGE_CODEX_PROMPT_CONTEXT' : 'PACKAGE_CLAUDE_PROMPT_CONTEXT' } }))
  }, mode === 'stdout' ? 0 : 200)
  return
}
let transcriptValidated = false
let promptArtifactIDs = []
if (!codex) {
  const rows = fs.readFileSync(input.transcript_path, 'utf8').trim().split('\n').map(JSON.parse)
  const date = rows.find(row => row.attachment?.type === 'date')
  if (!date) process.exit(10)
  const time = new Date(date.timestamp)
  const observedDate = [time.getFullYear(), String(time.getMonth() + 1).padStart(2, '0'), String(time.getDate()).padStart(2, '0')].join('-')
  if (date.attachment.date !== observedDate) process.exit(11)
  const blocks = rows.flatMap(row => Array.isArray(row.message?.content) ? row.message.content : [])
  const call = blocks.findLast(block => block.type === 'tool_use' && block.id === input.tool_use_id)
  if (!call || call.input.command !== input.tool_input.command || !rows.some(row => row.type === 'user' && JSON.stringify(row.message.content).includes('controlled package fixture'))) process.exit(8)
  if (${prompts}) {
    const attachments = rows.filter(row => row.type === 'attachment' && row.attachment.hookEvent === 'UserPromptSubmit')
    const stdout = attachments.find(row => row.attachment.type === 'hook_success')
    const additional = attachments.find(row => row.attachment.type === 'hook_additional_context')
    const failed = attachments.find(row => row.attachment.type === 'hook_non_blocking_error')
    const timeout = attachments.find(row => row.attachment.type === 'hook_cancelled')
    if (!stdout || !additional || !failed || stdout.attachment.stdout !== 'PACKAGE_CLAUDE_STDOUT_CONTEXT\n' || stdout.attachment.stderr !== 'PACKAGE_STDOUT_STDERR\n' || stdout.attachment.exitCode !== 0 || additional.attachment.content[0] !== 'PACKAGE_CLAUDE_PROMPT_CONTEXT' || failed.attachment.stdout !== 'PACKAGE_FAILURE_STDOUT\n' || failed.attachment.stderr !== 'Failed with non-blocking status code: PACKAGE_FAILURE_STDERR' || failed.attachment.exitCode !== 1 || Object.hasOwn(failed, 'rendered')) process.exit(9)
    if (attachments.filter(row => row.attachment.type !== 'hook_non_blocking_error')[0] !== stdout || stdout.attachment.toolUseID !== failed.attachment.toolUseID) process.exit(12)
    if (!timeout || timeout.attachment.timedOut !== true || timeout.attachment.timeoutMs !== ${PROMPT_TIMEOUT_SECONDS * SECOND_MS} || timeout.attachment.toolUseID !== stdout.attachment.toolUseID || Object.hasOwn(timeout.attachment, 'stdout') || Object.hasOwn(timeout.attachment, 'stderr') || Object.hasOwn(timeout, 'rendered')) process.exit(13)
    promptArtifactIDs = attachments.map(row => row.uuid)
  }
  transcriptValidated = true
}
fs.appendFileSync(${JSON.stringify(capture)}, JSON.stringify({ ...input, transcriptValidated, promptArtifactIDs, nativeDialect: codex ? 'codex' : 'claude-code' }) + '\n')
const decision = input.tool_input.command.includes('forbidden')
  ? { permissionDecision: 'deny', permissionDecisionReason: 'PACKAGE_FIXTURE_DENIED' }
  : { ...(codex || ${preapproval} ? { permissionDecision: 'allow' } : {}), updatedInput: { command: ${JSON.stringify(replacementCommand)}, description: 'Rewritten fixture' } }
console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', ...decision } }))
`)
    await run(process.execPath, ['--check', script], { env, timeout: STARTUP_MS, maxBuffer: MAX_BYTES })
    const hook = { type: 'command', command: quote(process.execPath) + ' ' + quote(script) }
    const source = JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [hook] }], ...(stopRejection ? { Stop: [{ hooks: [hook] }] } : {}), ...(prompts ? { UserPromptSubmit: [{ hooks: [hook, { ...hook, command: hook.command + ' stdout' }, { ...hook, command: hook.command + ' failure' }, { ...hook, command: hook.command + ' timeout', timeout: PROMPT_TIMEOUT_SECONDS }] }] } : {}) } })
    await writeFile(sourcePath, source)
    const selectedDialects = dialect === 'mixed' ? ['claude-code', 'codex'] : [dialect]
    const sources = selectedDialects.map(dialect => ({ id: 'fixture-' + dialect, dialect, path: sourcePath }))
    const digest = createHash('sha256').update(source).digest('hex')
    const permissionMode = preapproval ? 'default' : 'bypassPermissions'
    const hostPermission = preapproval ? 'ask' : 'allow'
    const options = { sources, reviewedDigests: Object.fromEntries(sources.map(source => [source.id, digest])), permissionMode }
    const requests = []
    let providerRequests = 0
    let correlationLeaked = false
    const tool = hostVersion === 'v1' ? 'bash' : 'shell'
    gateway = createServer(async (request, response) => {
      try {
        providerRequests++
        const chunks = []
        let bytes = 0
        for await (const chunk of request) {
          bytes += chunk.length
          if (bytes > MAX_BYTES) { response.writeHead(413); response.end(); return }
          chunks.push(chunk)
        }
        const body = JSON.parse(Buffer.concat(chunks).toString())
        const primary = body.tools?.some(entry => entry.function?.name === tool)
        if (primary) {
          if (requests.length >= MAX_REQUESTS) { response.writeHead(429); response.end(); return }
          requests.push(body)
          correlationLeaked ||= Object.keys(request.headers).some(key => key.startsWith('x-opencode-harness-'))
        }
        const index = requests.length
        const useTool = primary && index <= CONTROLLED_TOOL_CALLS
        const args = index === 1 ? { command: 'printf forbidden > ' + quote(denied), description: 'Denied fixture' } : { command: originalCommand, description: 'Original fixture' }
        const delta = useTool ? { role: 'assistant', tool_calls: [{ index: 0, id: 'call_' + index, type: 'function', function: { name: tool, arguments: JSON.stringify(args) } }] } : { role: 'assistant', content: 'PACKAGE_FIXTURE_DONE' }
        const chunk = (value, finish_reason) => ({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: value, finish_reason }] })
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end('data: ' + JSON.stringify(chunk(delta, null)) + '\n\ndata: ' + JSON.stringify({ ...chunk({}, useTool ? 'tool_calls' : 'stop'), usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }) + '\n\ndata: [DONE]\n\n')
      } catch { if (!response.headersSent) response.writeHead(500); response.end() }
    })
    await new Promise((resolve, reject) => { gateway.once('error', reject); gateway.listen(0, '127.0.0.1', resolve) })
    const baseURL = 'http://127.0.0.1:' + gateway.address().port + '/v1'
    const configData = hostVersion === 'v1'
      ? { model: 'fixture/fixture', small_model: 'fixture/fixture', enabled_providers: ['fixture'], snapshot: false, share: 'disabled', autoupdate: false, permission: hostPermission, plugin: [[pathToFileURL(entrypoint).href, options]], provider: { fixture: { npm: '@ai-sdk/openai-compatible', options: { apiKey: 'synthetic', baseURL }, models: { fixture: { name: 'Fixture', tool_call: true, limit: { context: 50000, output: 2000 } } } } } }
      : { model: 'fixture/fixture', update: 'disable', snapshots: false, share: 'disabled', warming: false, permissions: [{ action: '*', resource: '*', effect: hostPermission }], plugins: [{ package: packageDirectory, options }], providers: { fixture: { package: '@opencode/ai/providers/openai-compatible', settings: { apiKey: 'synthetic', baseURL }, models: { fixture: { name: 'Fixture', capabilities: { tools: true }, limit: { context: 50000, output: 2000 } } } } } }
    await writeFile(join(config, 'opencode.json'), JSON.stringify(configData))
    child = spawn(binary, [...(hostVersion === 'v1' ? ['--print-logs'] : []), 'serve', '--hostname', '127.0.0.1', '--port', '0'], { cwd: project, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    done = new Promise(resolve => child.once('close', resolve))
    let hostErrors = ''
    let failureObserved
    const expectedFailure = new Promise(resolve => { failureObserved = resolve })
    let noticeObserved
    const expectedNotice = new Promise(resolve => { noticeObserved = resolve })
    child.stderr.on('data', chunk => {
      for (const code of String(chunk).match(/\b(?:HOST|SOURCE|SESSION|PLUGIN|HANDLER|RUNTIME)_[A-Z_]+\b/g) ?? []) diagnosticCodes.add(code)
      if (stopRejection) {
        hostErrors = (hostErrors + chunk).slice(-MAX_BYTES)
        if (['HOST_STOP_UNSUPPORTED', 'V1', 'Stop', 'awaited-completion-decision', sourcePath, ...sources.map(source => source.id)].every(value => hostErrors.includes(value))) failureObserved()
        if (hostErrors.includes('HOST_STOP_NOTICE_SHOWN')) noticeObserved(true)
        else if (hostErrors.includes('HOST_STOP_NOTICE_FAILED')) noticeObserved(false)
      }
    })
    const ready = new Promise((resolve, reject) => {
      let output = ''
      child.once('error', reject)
      child.once('close', () => reject(new ProbeError('HOST_EXITED_BEFORE_READY')))
      child.stdout.on('data', chunk => {
        output = (output + chunk).slice(-MAX_BYTES)
        const address = /http:\/\/127\.0\.0\.1:\d+/.exec(output)?.[0]
        if (address) resolve(address)
      })
    })
    const address = await bounded(ready, STARTUP_MS, 'HOST_STARTUP_TIMEOUT')
    stage = 'prompt'
    let answer
    if (hostVersion === 'v1') {
      const headers = { 'content-type': 'application/json', authorization: 'Basic ' + Buffer.from('opencode:' + env.OPENCODE_PASSWORD).toString('base64') }
      const post = async (path, body) => {
        const response = await fetch(address + path + '?directory=' + encodeURIComponent(project), { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(CLIENT_MS) })
        if (!response.ok) throw new ProbeError('HOST_API_FAILED: ' + response.status)
        return response.json()
      }
      if (stopRejection) {
        stage = 'stop-rejection'
        await assert.rejects(async () => {
          const session = await post('/session', {})
          await post('/session/' + session.id + '/message', { model: { providerID: 'fixture', modelID: 'fixture' }, parts: [{ type: 'text', text: 'Reject the incompatible Stop configuration' }] })
        })
        await bounded(expectedFailure, CLIENT_MS, 'STOP_FAILURE_DIAGNOSTIC_MISSING')
        assert.equal(await bounded(expectedNotice, CLIENT_MS, 'STOP_FAILURE_NOTICE_MISSING'), true)
        assert.equal(hostErrors.includes('HOST_STOP_NOTICE_FAILED'), false)
        assert.equal(requests.length, 0)
        assert.equal(providerRequests, 0)
        await assert.rejects(access(capture), { code: 'ENOENT' })
        return { host: hostVersion, hostVersion: VERSIONS[hostVersion], dialect, defaultEntrypoint: true, nativeOptions: true, expectedStopLoadRejection: true, incompatibleConfigsIdentified: true, unsupportedCapabilityIdentified: true, hostErrorNoticeAccepted: true, noModelOrHookExecution: true, equivalent: false }
      }
      const session = await post('/session', {})
      if (prompts) {
        await assert.rejects(post('/session/' + session.id + '/message', { model: { providerID: 'fixture', modelID: 'fixture' }, parts: [{ type: 'text', text: 'Block the controlled prompt' }] }))
        assert.equal(requests.length, 0)
      }
      answer = await post('/session/' + session.id + '/message', { model: { providerID: 'fixture', modelID: 'fixture' }, parts: [{ type: 'text', text: 'Run the controlled package fixture' }] })
      if (prompts) answer = await post('/session/' + session.id + '/message', { model: { providerID: 'fixture', modelID: 'fixture' }, parts: [{ type: 'text', text: 'Follow-up controlled package fixture' }] })
    } else {
      if (prompts) {
        const blocked = run(binary, ['--server', address, 'run', '--format', 'json', '--model', 'fixture/fixture', 'Block the controlled prompt'], { cwd: project, env, timeout: CLIENT_MS, maxBuffer: MAX_BYTES })
        blocked.child.stdin.end()
        await assert.rejects(blocked)
        assert.equal(requests.length, 0)
      }
      const running = run(binary, ['--server', address, 'run', '--format', 'json', '--model', 'fixture/fixture', 'Run the controlled package fixture'], { cwd: project, env, timeout: CLIENT_MS, maxBuffer: MAX_BYTES })
      running.child.stdin.end()
      answer = (await running.catch(() => { throw new ProbeError('HOST_CLIENT_FAILED') })).stdout
      if (prompts) {
        const rows = (await readFile(capture, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
        const sessionID = rows.find(row => row.prompt?.includes('Run the controlled package fixture'))?.session_id
        assert.ok(sessionID)
        const follow = run(binary, ['--server', address, 'run', '--session', sessionID, '--format', 'json', '--model', 'fixture/fixture', 'Follow-up controlled package fixture'], { cwd: project, env, timeout: CLIENT_MS, maxBuffer: MAX_BYTES })
        follow.child.stdin.end()
        answer = (await follow.catch(() => { throw new ProbeError('HOST_FOLLOWUP_FAILED') })).stdout
      }
    }
    stage = 'denied-side-effect'
    await assert.rejects(access(denied))
    stage = 'replacement-side-effect'
    assert.equal(await readFile(rewritten, 'utf8'), 'rewritten')
    stage = 'native-payloads'
    const payloads = (await readFile(capture, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    const toolPayloads = payloads.filter(payload => payload.hook_event_name === 'PreToolUse')
    assert.equal(toolPayloads.length, CONTROLLED_TOOL_CALLS * sources.length)
    assert.ok(toolPayloads.every(payload => payload.tool_name === 'Bash' && typeof payload.tool_use_id === 'string' && payload.tool_use_id && payload.permission_mode === permissionMode))
    for (let index = 1; index <= CONTROLLED_TOOL_CALLS; index++) {
      const group = toolPayloads.filter(payload => payload.tool_use_id === 'call_' + index)
      assert.deepEqual(group.map(payload => payload.nativeDialect).sort(), [...selectedDialects].sort())
      assert.ok(group.every(payload => index !== CONTROLLED_TOOL_CALLS || payload.tool_input.command === originalCommand))
      for (const payload of group) {
        if (payload.nativeDialect === 'codex') assert.ok(payload.model === 'fixture' && typeof payload.turn_id === 'string' && payload.turn_id)
        else assert.equal(payload.transcriptValidated, true)
      }
    }
    if (prompts) {
      stage = 'prompt-contract'
      assert.ok(!JSON.stringify(requests).includes('PACKAGE_FAILURE_STDOUT'))
      assert.ok(!JSON.stringify(requests).includes('PACKAGE_FAILURE_STDERR'))
      assert.ok(!JSON.stringify(requests).includes('PACKAGE_TIMEOUT_STDOUT'))
      assert.ok(!JSON.stringify(requests).includes('PACKAGE_TIMEOUT_STDERR'))
      const submitted = payloads.filter(payload => payload.hook_event_name === 'UserPromptSubmit')
      assert.equal(submitted.length, PROMPT_SUBMISSIONS * PROMPT_HANDLERS * sources.length)
      assert.ok(submitted.every(payload => payload.permission_mode === permissionMode && (payload.nativeDialect !== 'codex' || payload.model === 'fixture' && typeof payload.turn_id === 'string')))
      for (const payload of submitted.filter(payload => payload.nativeDialect === 'claude-code')) {
        assert.equal(payload.promptTranscriptExists, payload.prompt.includes('Follow-up controlled package fixture'))
        assert.equal(payload.promptHistoryAttachments, payload.promptTranscriptExists)
      }
      const artifacts = toolPayloads.filter(payload => payload.nativeDialect === 'claude-code').map(payload => payload.promptArtifactIDs)
      if (artifacts.length) { assert.equal(artifacts[0].length, PROMPT_HANDLERS); assert.ok(artifacts.every(ids => JSON.stringify(ids) === JSON.stringify(artifacts[0]))) }
      assert.equal(correlationLeaked, false)
      for (const request of requests) {
        for (let index = 0; index < request.messages.length; index++) {
          const row = request.messages[index]
          if (row.role !== 'user' || !JSON.stringify(row.content).includes('controlled package fixture')) continue
          if (selectedDialects.includes('claude-code')) assert.ok(Array.isArray(row.content) && row.content[0].text === '<system-reminder>\nUserPromptSubmit hook success: PACKAGE_CLAUDE_STDOUT_CONTEXT\n</system-reminder>' && row.content[1].text === '<system-reminder>\nUserPromptSubmit hook additional context: PACKAGE_CLAUDE_PROMPT_CONTEXT\n</system-reminder>')
          if (selectedDialects.includes('codex')) assert.deepEqual(request.messages.slice(index + 1, index + 1 + CODEX_PROMPT_CONTEXTS.length), CODEX_PROMPT_CONTEXTS)
        }
      }
      assert.equal(requests.at(-1).messages.filter(row => row.role === 'user' && JSON.stringify(row.content).includes('controlled package fixture')).length, 2)
    } else assert.equal(payloads.length, toolPayloads.length)
    stage = 'model-visible-denial'
    assert.ok(JSON.stringify(requests[1].messages).includes('PACKAGE_FIXTURE_DENIED'))
    stage = 'final-answer'
    assert.ok(JSON.stringify(answer).includes('PACKAGE_FIXTURE_DONE'))
    return { host: version, dialect, defaultPackageEntrypoint: true, nativeOptions: true, deniedSideEffectAbsent: true, replacementExecuted: true, requiredPayloadMetadataObserved: true, ...(preapproval ? { nativeAllowUnderHostAsk: true } : {}), ...(prompts ? { promptBlockedBeforeModel: true, nativePromptContextRoles: true, promptContextRetainedAcrossTurns: true, correlationHeaderPrivate: true, ...(selectedDialects.includes('claude-code') ? { promptAttachmentsReadByHook: true, promptNonblockingErrorReadByHook: true, promptTimeoutReadByHook: true } : {}) } : {}), ...(selectedDialects.includes('claude-code') ? { transcriptReadByHook: true, modelDateReadByHook: true } : {}), ...(selectedDialects.includes('codex') ? { hostTurnAndModelObserved: true } : {}), ...(sources.length > 1 ? { mixedSourcesExecutedIndependently: true } : {}), fixtureDeclaredPermissionMode: true, finalAnswerVisible: true, equivalent: false }
  } catch (error) {
    if (error instanceof ProbeError) throw error
    throw new ProbeError('PACKAGE_CHECK_FAILED: ' + stage + ' ' + (error.code ?? error.name ?? 'unknown') + (diagnosticCodes.size ? ' diagnostics=' + [...diagnosticCodes].sort().join(',') : ''))
  } finally {
    await stop(child, done)
    if (gateway?.listening) { gateway.closeAllConnections(); await new Promise(resolve => gateway.close(resolve)) }
    await rm(root, { recursive: true, force: true })
  }
}

try {
  let parsed
  try { parsed = parseArgs({ options: { host: { type: 'string' }, dialect: { type: 'string' }, preapproval: { type: 'boolean' }, prompts: { type: 'boolean' }, 'stop-rejection': { type: 'boolean', short: 's' }, binary: { type: 'string', short: 'b' }, help: { type: 'boolean', short: 'h' } }, strict: true, allowPositionals: false }) } catch { throw new ProbeError('USAGE_INVALID: use --help', 2) }
  if (parsed.values.help) process.stdout.write(HELP)
  else {
    const host = parsed.values.host
    if (!Object.hasOwn(VERSIONS, host ?? '')) throw new ProbeError('USAGE_HOST: expected v1 or v2', 2)
    const dialect = parsed.values.dialect ?? 'codex'
    if (!DIALECTS.has(dialect)) throw new ProbeError('USAGE_DIALECT: expected codex, claude-code or mixed', 2)
    const preapproval = parsed.values.preapproval ?? false
    if (preapproval && dialect === 'codex') throw new ProbeError('USAGE_PREAPPROVAL: select claude-code or mixed', 2)
    const stopRejection = parsed.values['stop-rejection'] ?? false
    if (stopRejection && (host !== 'v1' || preapproval || parsed.values.prompts)) throw new ProbeError('USAGE_STOP_REJECTION: V1 only, without --preapproval or --prompts', 2)
    const binary = parsed.values.binary ?? process.env[host === 'v1' ? 'OPENCODE_V1_BINARY' : 'OPENCODE_V2_BINARY'] ?? 'opencode'
    if (!binary.trim()) throw new ProbeError('USAGE_BINARY_EMPTY', 2)
    process.stdout.write(JSON.stringify(await verify(host, binary, dialect, preapproval, parsed.values.prompts ?? false, stopRejection)) + '\n')
  }
} catch (error) {
  process.stderr.write((error instanceof ProbeError ? error.message : 'PACKAGE_PROBE_FAILED') + '\n')
  process.exitCode = error instanceof ProbeError ? error.status : 1
}
