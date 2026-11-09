#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs, promisify } from 'node:util'

const VERSION = '2.1.318'
const MODEL = 'claude-sonnet-4-6'
const ORIGINAL = 'NATIVE_TRANSCRIPT_FIXTURE: read fixture.txt and finish'
const STDOUT = 'NATIVE_TRANSCRIPT_STDOUT'
const CONTEXT = 'NATIVE_TRANSCRIPT_CONTEXT'
const WARNING = 'NATIVE_TRANSCRIPT_WARNING'
const STDERR = 'NATIVE_TRANSCRIPT_STDERR'
const FAILURE_STDOUT = 'NATIVE_FAILURE_STDOUT'
const FAILURE_STDERR = 'NATIVE_FAILURE_STDERR'
const SIGNAL_STDOUT = 'NATIVE_SIGNAL_STDOUT'
const SIGNAL_STDERR = 'NATIVE_SIGNAL_STDERR'
const TIMEOUT_STDOUT = 'NATIVE_TIMEOUT_STDOUT'
const TIMEOUT_STDERR = 'NATIVE_TIMEOUT_STDERR'
const HOOK_TIMEOUT_SECONDS = 0.5
const SECOND_MS = 1000
const CLI_MS = 30000
const GRACE_MS = 1000
const MAX_BYTES = 2 * 1024 * 1024
const MAX_REQUESTS = 12
const SLOW_HOOK_MS = 200
const run = promisify(execFile)
const HELP = `Usage: node scripts/verify-claude-transcript.mjs [-b PATH]

Verify native Claude Code ${VERSION} prompt attachments, nonblocking errors, exec
command display and repeated-command differences, then resume built transcript
projections for both host formats through the pinned native reader.

Requires Node.js 22+, POSIX, npm run build and the pinned Claude executable. Uses
isolated HOME/config/project files, synthetic credentials and a loopback provider.
No model account, OpenCode executable, installation or live config change is needed.

Options:
  -b, --binary PATH  Claude executable (CLAUDE_BINARY, then claude)
  -h, --help         Show help without requiring a binary or build

Reports use metadata-only JSON on stdout; runtime failures use stderr without
native output, commands, provider traffic or local paths. Temporary state is removed.
Exit status: 0 verified; 1 runtime/check failure; 2 usage/version/platform;
3 dependency; 4 required native reader fidelity differs (JSON is preserved).
This covers supported synthetic attachments, not full native artifact equivalence.
`
class ProbeError extends Error { constructor(code, status = 1) { super(code); this.status = status } }

async function native(binary, args, text, cwd, env) {
  const child = spawn(binary, args, { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
  let output = ''
  let bytes = 0
  let failure
  let escalation
  const kill = signal => { try { if (child.pid) process.kill(-child.pid, signal) } catch {} }
  const stop = code => { if (failure) return; failure = code; kill('SIGTERM'); escalation = setTimeout(() => kill('SIGKILL'), GRACE_MS) }
  const timer = setTimeout(() => stop('NATIVE_TIMEOUT'), CLI_MS)
  child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > MAX_BYTES) stop('NATIVE_OUTPUT_LIMIT'); else output += chunk })
  child.stderr.on('data', chunk => { bytes += chunk.length; if (bytes > MAX_BYTES) stop('NATIVE_OUTPUT_LIMIT') })
  child.stdin.on('error', () => {})
  child.stdin.end(text)
  try {
    const status = await new Promise((resolve, reject) => { child.once('error', () => reject(new ProbeError('NATIVE_START_FAILED'))); child.once('close', resolve) })
    if (failure) throw new ProbeError(failure)
    if (status !== 0) throw new ProbeError('NATIVE_EXECUTION_FAILED')
    const result = JSON.parse(output)
    assert.equal(result.is_error, false)
  } finally { clearTimeout(timer); clearTimeout(escalation); kill('SIGKILL') }
}

function attachments(rows) {
  return rows.filter(row => row.type === 'attachment' && row.attachment?.hookEvent === 'UserPromptSubmit')
}
function validate(rows, commands) {
  const found = attachments(rows)
  const errors = found.filter(row => row.attachment.type === 'hook_non_blocking_error').sort((a, b) => a.attachment.command.localeCompare(b.attachment.command))
  const timeouts = found.filter(row => row.attachment.type === 'hook_cancelled')
  const successful = found.filter(row => !['hook_non_blocking_error', 'hook_cancelled'].includes(row.attachment.type))
  assert.deepEqual(successful.map(row => row.attachment.type), ['hook_success', 'hook_system_message', 'hook_additional_context', 'hook_system_message', 'hook_additional_context', 'hook_system_message', 'hook_additional_context', 'hook_additional_context'])
  const failureCases = [
    ['failure', FAILURE_STDOUT + '\n', 'Failed with non-blocking status code: ' + FAILURE_STDERR, 1],
    ['empty-failure', '', 'Failed with non-blocking status code: No stderr output', 3],
    ['shell-signal', SIGNAL_STDOUT + '\n', 'Failed with non-blocking status code: ' + SIGNAL_STDERR, 1],
    ...['SIGTERM', 'SIGINT', 'SIGKILL'].map(signal => ['signal-' + signal, SIGNAL_STDOUT + '\n', 'Failed with non-blocking status code: ' + SIGNAL_STDERR, 1]),
  ]
  assert.equal(errors.length, failureCases.length)
  for (const [mode, stdout, stderr, exitCode] of failureCases) {
    const row = errors.find(row => row.attachment.command === commands[mode])
    assert.ok(row)
    assert.deepEqual([row.attachment.stdout, row.attachment.stderr, row.attachment.exitCode], [stdout, stderr, exitCode])
    assert.ok(!Object.hasOwn(row, 'rendered') && !Object.hasOwn(row, 'renderedRole') && !Object.hasOwn(row.attachment, 'content'))
    assert.ok(Number.isFinite(row.attachment.durationMs) && row.attachment.durationMs >= 0)
  }
  assert.equal(timeouts.length, 1)
  assert.equal(timeouts[0].attachment.command, commands.timeout)
  assert.equal(timeouts[0].attachment.timedOut, true)
  assert.equal(timeouts[0].attachment.timeoutMs, HOOK_TIMEOUT_SECONDS * SECOND_MS)
  assert.ok(Number.isFinite(timeouts[0].attachment.durationMs) && timeouts[0].attachment.durationMs >= 0)
  for (const field of ['stdout', 'stderr', 'exitCode', 'content']) assert.ok(!Object.hasOwn(timeouts[0].attachment, field))
  assert.ok(!Object.hasOwn(timeouts[0], 'rendered') && !Object.hasOwn(timeouts[0], 'renderedRole'))
  const shared = found.filter(row => row.attachment.type !== 'hook_additional_context').map(row => row.attachment.toolUseID)
  assert.equal(new Set(shared).size, 1)
  const additional = found.filter(row => row.attachment.type === 'hook_additional_context').map(row => row.attachment.toolUseID)
  assert.equal(new Set(additional).size, additional.length)
  assert.ok(additional.every(id => /^hook-/.test(id)))
  const normalized = [...successful, ...errors, ...timeouts].map(row => {
    const { toolUseID: _identity, durationMs, ...body } = row.attachment
    assert.ok(!Number.isNaN(Date.parse(row.timestamp)))
    if (body.type === 'hook_success') {
      assert.ok(Number.isFinite(durationMs) && durationMs >= 0)
      assert.equal(body.command, commands.stdout)
    }
    return { attachment: body, ...(row.rendered ? { rendered: row.rendered, renderedRole: row.renderedRole } : {}) }
  })
  return normalized
}
function modelContext(messages, expected = [
  `<system-reminder>\nUserPromptSubmit hook success: ${STDOUT}\n</system-reminder>`,
  `<system-reminder>\nUserPromptSubmit hook additional context: ${CONTEXT}\n</system-reminder>`,
  `<system-reminder>\nUserPromptSubmit hook additional context: ${CONTEXT}\n</system-reminder>`,
  `<system-reminder>\nUserPromptSubmit hook additional context: ${CONTEXT}\n</system-reminder>`,
  `<system-reminder>\nUserPromptSubmit hook additional context: ${CONTEXT}\n</system-reminder>`,
]) {
  const parts = messages.flatMap(message => (typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content).filter(part => part.type === 'text').map(part => ({ role: message.role, text: part.text })))
  const contexts = parts.filter(part => part.text.includes(STDOUT) || part.text.includes(CONTEXT))
  assert.deepEqual(contexts.map(row => row.role), ['user', 'user', 'user', 'user', 'user'])
  if (expected) assert.deepEqual(contexts.map(row => row.text), expected)
  const original = parts.findIndex(part => part.text.includes(ORIGINAL))
  assert.ok(original > parts.indexOf(contexts.at(-1)))
  assert.ok(!JSON.stringify(messages).includes(WARNING))
  assert.ok(!JSON.stringify(messages).includes(STDERR))
  assert.ok(!JSON.stringify(messages).includes(FAILURE_STDOUT))
  assert.ok(!JSON.stringify(messages).includes(FAILURE_STDERR))
  for (const output of [SIGNAL_STDOUT, SIGNAL_STDERR, TIMEOUT_STDOUT, TIMEOUT_STDERR]) assert.ok(!JSON.stringify(messages).includes(output))
  return contexts.map(row => row.text)
}

function modelDate(rows) {
  const dates = rows.filter(row => row.attachment?.type === 'date')
  assert.equal(dates.length, 1)
  const row = dates[0]
  const time = new Date(row.timestamp)
  const localDate = [time.getFullYear(), String(time.getMonth() + 1).padStart(2, '0'), String(time.getDate()).padStart(2, '0')].join('-')
  assert.equal(row.attachment.date, localDate)
  assert.equal(row.renderedRole, 'system')
  assert.deepEqual(row.rendered, [{ content: `<system-reminder>\nToday's date is ${localDate}.\n</system-reminder>` }])
  assert.ok(rows.indexOf(row) > rows.indexOf(attachments(rows).at(-1)))
  assert.ok(rows.indexOf(row) < rows.findIndex(row => row.type === 'assistant'))
}

async function verify(binary) {
  if (process.platform === 'win32') throw new ProbeError('PLATFORM_UNAVAILABLE: POSIX process groups', 2)
  let version
  try { version = (await run(binary, ['--version'], { timeout: CLI_MS, maxBuffer: MAX_BYTES })).stdout.trim() } catch (error) { throw new ProbeError(error.code === 'ENOENT' || error.code === 'EACCES' ? 'DEPENDENCY_UNAVAILABLE: Claude Code' : 'DEPENDENCY_QUERY_FAILED: Claude Code', error.code === 'ENOENT' || error.code === 'EACCES' ? 3 : 1) }
  if (!version.startsWith(VERSION + ' ') && version !== VERSION) throw new ProbeError('NATIVE_VERSION_MISMATCH', 2)
  let core
  try { await access(new URL('../dist/core.js', import.meta.url)); core = await import('../dist/core.js') } catch { throw new ProbeError('DEPENDENCY_UNAVAILABLE: built package', 3) }
  const root = await realpath(await mkdtemp(join(tmpdir(), 'harness-claude-transcript-')))
  let gateway
  let runtime
  let stage = 'setup'
  try {
    const project = join(root, 'project')
    const home = join(root, 'home')
    const config = join(root, 'config')
    await Promise.all([mkdir(project), mkdir(home), mkdir(config)])
    const capture = join(root, 'native.jsonl')
    const hook = join(root, 'hook.cjs')
    const invocations = join(root, 'invocations.jsonl')
    await writeFile(hook, `const fs=require('node:fs');const input=JSON.parse(fs.readFileSync(0,'utf8'));if(input.hook_event_name==='PreToolUse'){fs.writeFileSync(process.env.ARTIFACT_CAPTURE,fs.readFileSync(input.transcript_path));fs.writeFileSync(process.env.ARTIFACT_CAPTURE+'.path',input.transcript_path);return}const mode=process.argv[2];fs.appendFileSync(process.env.ARTIFACT_INVOCATIONS,JSON.stringify({phase:process.env.FIXTURE_PHASE,mode})+'\\n');setTimeout(()=>{if(mode==='timeout'){process.stdout.write(${JSON.stringify(TIMEOUT_STDOUT + '\n')});process.stderr.write(${JSON.stringify(TIMEOUT_STDERR + '\n')});setInterval(()=>{},1000);return}if(mode==='signal-json'){console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'UserPromptSubmit',additionalContext:${JSON.stringify(CONTEXT)}}}));process.kill(process.pid,'SIGTERM');return}if(mode.startsWith('signal-')){process.stdout.write(${JSON.stringify(SIGNAL_STDOUT + '\n')});process.stderr.write(${JSON.stringify(SIGNAL_STDERR + '\n')});process.kill(process.pid,mode.slice(7));return}if(mode==='failure'){process.stdout.write(${JSON.stringify(FAILURE_STDOUT + '\n')});process.stderr.write(${JSON.stringify(' \n ' + FAILURE_STDERR + ' \t\n')});process.exit(1)}if(mode==='empty-failure'){process.stderr.write(' \\t\\n');process.exit(3)}if(mode==='stdout'){process.stdout.write(${JSON.stringify(STDOUT + '\n')});process.stderr.write(${JSON.stringify(STDERR + '\n')})}else {console.log(JSON.stringify({systemMessage:${JSON.stringify(WARNING)},hookSpecificOutput:{hookEventName:'UserPromptSubmit',additionalContext:${JSON.stringify(CONTEXT)}}}));if(mode==='nonzero-json')process.exitCode=5}},mode==='stdout'||mode==='timeout'?0:mode==='signal-json'?${SLOW_HOOK_MS * 3}:mode==='nonzero-json'?${SLOW_HOOK_MS * 2}:${SLOW_HOOK_MS})`)
    const handler = mode => mode === 'shell-signal' ? { type: 'command', command: "printf '" + SIGNAL_STDOUT + "\\n'; printf '" + SIGNAL_STDERR + "\\n' >&2; kill -TERM $$", timeout: 3 } : { type: 'command', command: process.execPath, args: [hook, mode, "literal space 'quote'"], timeout: mode === 'timeout' ? HOOK_TIMEOUT_SECONDS : 3 }
    const sourceFor = (modes, blockTimeout = false) => JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: modes.map(mode => ({ ...handler(mode), ...(blockTimeout && mode === 'timeout' ? { onFailure: 'block' } : {}) })) }], PreToolUse: [{ hooks: [handler('capture')] }] } })
    const source = sourceFor(['additional-a', 'stdout', 'additional-b', 'failure', 'empty-failure', 'nonzero-json', 'timeout', 'signal-SIGTERM', 'signal-SIGINT', 'signal-SIGKILL', 'signal-json', 'shell-signal'])
    const repeatedSource = sourceFor(['additional', 'stdout', 'additional', 'failure', 'empty-failure', 'nonzero-json', 'timeout', 'signal-SIGTERM', 'signal-SIGINT', 'signal-SIGKILL', 'signal-json', 'shell-signal'])
    const settings = join(root, 'settings.json')
    const empty = join(root, 'empty.json')
    const mcp = join(root, 'mcp.json')
    const repeatedSettings = join(root, 'repeated.json')
    const blockedSettings = join(root, 'blocked.json')
    await Promise.all([writeFile(settings, source), writeFile(repeatedSettings, repeatedSource), writeFile(blockedSettings, sourceFor(['timeout'], true)), writeFile(empty, '{}'), writeFile(mcp, '{"mcpServers":{}}'), writeFile(join(project, 'fixture.txt'), 'Fixture data')])
    const requests = new Map()
    let phase = 'native'
    let sent = false
    gateway = createServer(async (request, response) => {
      try {
        const chunks = []
        let bytes = 0
        for await (const chunk of request) { bytes += chunk.length; if (bytes > MAX_BYTES) throw new Error(); chunks.push(chunk) }
        if (request.url.includes('/count_tokens')) { response.setHeader('content-type', 'application/json'); response.end('{"input_tokens":1}'); return }
        if (!request.url.includes('/messages')) { response.writeHead(404); response.end('{}'); return }
        const body = JSON.parse(Buffer.concat(chunks).toString())
        const history = requests.get(phase) ?? []
        if (history.length >= MAX_REQUESTS) throw new Error()
        history.push(body.messages); requests.set(phase, history)
        const tool = phase.startsWith('native') && !sent
        sent ||= tool
        const block = tool ? { type: 'tool_use', id: 'fixture-read', name: 'Read', input: { file_path: join(project, 'fixture.txt') } } : { type: 'text', text: 'Fixture done' }
        const stop = tool ? 'tool_use' : 'end_turn'
        const message = { id: 'fixture-message', type: 'message', role: 'assistant', content: [block], model: body.model, stop_reason: stop, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }
        if (!body.stream) { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(message)); return }
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        const emit = (type, value) => response.write('event: ' + type + '\ndata: ' + JSON.stringify({ type, ...value }) + '\n\n')
        emit('message_start', { message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } })
        emit('content_block_start', { index: 0, content_block: tool ? { ...block, input: {} } : { type: 'text', text: '' } })
        emit('content_block_delta', { index: 0, delta: tool ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } : { type: 'text_delta', text: block.text } })
        emit('content_block_stop', { index: 0 })
        emit('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 1 } })
        emit('message_stop', {}); response.end()
      } catch { response.writeHead(500); response.end('{}') }
    })
    await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve))
    const env = { PATH: process.env.PATH, SHELL: '/bin/sh', TZ: process.env.TZ, HOME: home, CLAUDE_CONFIG_DIR: config, ARTIFACT_CAPTURE: capture, ARTIFACT_INVOCATIONS: invocations, FIXTURE_PHASE: 'native', ANTHROPIC_API_KEY: 'synthetic', ANTHROPIC_BASE_URL: 'http://127.0.0.1:' + gateway.address().port, DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_NON_ESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1' }
    const args = ['-p', '--output-format', 'json', '--setting-sources', '', '--strict-mcp-config', '--mcp-config', mcp, '--model', MODEL]
    stage = 'native-capture'
    await native(binary, [...args, '--settings', settings, '--tools', 'Read', '--allowedTools', 'Read'], ORIGINAL, project, env)
    const rows = (await readFile(capture, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    const commands = Object.fromEntries(['stdout', 'failure', 'empty-failure', 'timeout', 'signal-SIGTERM', 'signal-SIGINT', 'signal-SIGKILL', 'shell-signal'].map(mode => { const command = handler(mode); return [mode, [command.command, ...(command.args ?? [])].join(' ')] }))
    const expected = validate(rows, commands)
    modelDate(rows)
    assert.ok(requests.get('native')?.length)
    for (const messages of requests.get('native')) modelContext(messages)
    stage = 'native-reader-reference'
    const nativePath = await readFile(capture + '.path', 'utf8')
    assert.ok(nativePath.startsWith(config + '/'))
    phase = 'reader-native'
    await native(binary, [...args, '--settings', empty, '--resume', nativePath, '--tools', ''], 'Follow up', project, env)
    assert.ok(requests.get(phase)?.length)
    const readerTexts = modelContext(requests.get(phase)[0], null)
    for (const messages of requests.get(phase)) modelContext(messages, readerTexts)
    stage = 'native-blocked-timeout'
    phase = 'blocked-timeout'
    await native(binary, [...args, '--settings', blockedSettings, '--tools', 'Read', '--allowedTools', 'Read'], ORIGINAL, project, { ...env, FIXTURE_PHASE: phase })
    assert.equal(requests.has(phase), false)
    const blockedCalls = (await readFile(invocations, 'utf8')).trim().split('\n').map(line => JSON.parse(line)).filter(row => row.phase === phase && row.mode === 'timeout')
    assert.equal(blockedCalls.length, 1)
    stage = 'native-repeated-command'
    phase = 'native-repeated'
    sent = false
    await native(binary, [...args, '--settings', repeatedSettings, '--tools', 'Read', '--allowedTools', 'Read'], ORIGINAL, project, { ...env, FIXTURE_PHASE: phase })
    const calls = async () => (await readFile(invocations, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    const nativeRepeated = (await calls()).filter(row => row.phase === phase && row.mode === 'additional').length
    assert.equal(nativeRepeated, 1)
    const generated = {}
    for (const host of ['v1', 'v2']) {
      stage = 'projection-' + host
      let history = []
      const transcripts = new core.ClaudeTranscript({ host, directory: project, temporaryParent: root, history: async () => ({ id: 'session', messages: history }) })
      runtime = await core.createRuntime(host, project, { sources: [{ id: 'fixture', dialect: 'claude-code', path: repeatedSettings }], reviewedDigests: { fixture: createHash('sha256').update(repeatedSource).digest('hex') }, permissionMode: 'default' }, { transcripts, host: { environment: { ...env, FIXTURE_PHASE: host } }, report: () => {}, dispatchDiagnostic: () => {} })
      runtime.sessions.prompt('session', 'turn', MODEL)
      const prompt = { host, event: 'UserPromptSubmit', sessionID: 'session', messageID: 'turn', prompt: ORIGINAL, signal: runtime.sessions.get('session').turnSignal }
      runtime.admitPrompt(prompt, await runtime.prompt(prompt))
      runtime.observeModel({ host, sessionID: 'session', messageID: 'turn', signal: runtime.sessions.get('session').turnSignal })
      const bridgeRepeated = (await calls()).filter(row => row.phase === host && row.mode === 'additional').length
      assert.equal(bridgeRepeated, 2)
      const created = Date.now()
      history = host === 'v1' ? [
        { info: { role: 'user', id: 'turn', sessionID: 'session', time: { created } }, parts: [{ type: 'text', text: ORIGINAL }] },
        { info: { role: 'assistant', id: 'answer', parentID: 'turn', sessionID: 'session', modelID: MODEL, time: { created } }, parts: [{ type: 'text', text: 'Bridge answer' }] },
      ] : [
        { type: 'user', id: 'turn', text: ORIGINAL, time: { created } },
        { type: 'assistant', id: 'answer', model: { id: MODEL }, time: { created }, content: [{ type: 'text', text: 'Bridge answer' }] },
      ]
      runtime.sessions.prompt('session', 'next', MODEL)
      const path = await transcripts.prepare({ ...prompt, messageID: 'next', prompt: 'Follow up', signal: runtime.sessions.get('session').turnSignal }, runtime.sessions.get('session'), runtime.sessions.get('session').turnSignal)
      const text = await readFile(path, 'utf8')
      assert.deepEqual(validate(text.trim().split('\n').map(line => JSON.parse(line)), commands), expected)
      modelDate(text.trim().split('\n').map(line => JSON.parse(line)))
      const seed = join(root, host + '.jsonl')
      await writeFile(seed, text, { mode: 0o600 })
      await runtime.dispose(); runtime = undefined
      phase = 'reader-' + host
      stage = phase
      await native(binary, [...args, '--settings', empty, '--resume', seed, '--tools', ''], 'Follow up', project, env)
      assert.ok(requests.get(phase)?.length)
      const contextTextEquivalent = requests.get(phase).every(messages => JSON.stringify(modelContext(messages, null)) === JSON.stringify(readerTexts))
      generated[host] = { nativeAttachmentShape: true, nativeNonblockingErrorShape: true, nativeTimeoutShape: true, nativeSignalExits: true, nonzeroStructuredContextPreserved: true, observedLocalDateAttachment: true, nativeReaderAccepted: true, nativeContextRolesAndOrder: true, nativeContextTextEquivalent: contextTextEquivalent, duplicateContextPreserved: true, privateExecutionFieldsAbsentFromModel: true, repeatedCommandExecutions: bridgeRepeated }
    }
    const requiredFailures = Object.entries(generated).filter(([_host, value]) => !value.nativeContextTextEquivalent).map(([host]) => ({ host, code: 'NATIVE_READER_CONTEXT_TEXT_DIFFERENCE' }))
    return { claude: VERSION, nativePromptAttachments: true, nativeNonblockingErrors: true, nativeTimeoutArtifacts: true, nativeTimeoutFailurePolicy: true, nativeSignalArtifacts: true, nativeCompletionOrder: true, nativeExecCommandDisplay: true, nativeReaderReference: true, nativeRepeatedCommandExecutions: nativeRepeated, approvedNoDeduplicationDifference: true, generated, requiredFailures, equivalent: false }
  } catch (error) { if (error instanceof ProbeError) throw error; throw new ProbeError('TRANSCRIPT_CHECK_FAILED: ' + stage) } finally {
    try { await runtime?.dispose() } finally {
      if (gateway) { gateway.closeAllConnections(); await new Promise(resolve => gateway.close(resolve)) }
      await rm(root, { recursive: true, force: true })
    }
  }
}

try {
  let parsed
  try { parsed = parseArgs({ options: { binary: { type: 'string', short: 'b' }, help: { type: 'boolean', short: 'h' } }, strict: true, allowPositionals: false }) } catch { throw new ProbeError('USAGE_INVALID: use --help', 2) }
  if (parsed.values.help) process.stdout.write(HELP)
  else {
    const binary = parsed.values.binary ?? process.env.CLAUDE_BINARY ?? 'claude'
    if (!binary.trim()) throw new ProbeError('USAGE_BINARY_EMPTY', 2)
    const result = await verify(binary)
    process.stdout.write(JSON.stringify(result) + '\n')
    if (result.requiredFailures.length) process.exitCode = 4
  }
} catch (error) { process.stderr.write((error instanceof ProbeError ? error.message : 'TRANSCRIPT_PROBE_FAILED') + '\n'); process.exitCode = error instanceof ProbeError ? error.status : 1 }
