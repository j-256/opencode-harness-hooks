#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { parseArgs, promisify } from 'node:util'
import { NativeProbeError as ProbeError, NATIVE_PROCESS_LIMITS as LIMITS, nativeCheckError, runNativeProcess } from './lib/native-process.mjs'
import { createStopAggregationFixture, stopAggregationCases, validateStopAggregation } from './lib/native-stop-aggregation.mjs'
import { createStopOutputFixture, stopOutputCases, validateStopOutput } from './lib/native-stop-outputs.mjs'

const VERSIONS = Object.freeze({ 'claude-code': '2.1.318', codex: '0.167.0' })
const FIXTURES = Object.freeze({ DEFAULT: 'default', AGGREGATION: 'aggregation', OUTPUTS: 'outputs' })
const MODES = Object.freeze(['block-json', 'block-stderr', 'failure-policy', 'stop-output'])
const CONTINUATIONS = new Set(['block-json', 'block-stderr'])
const MODEL = 'claude-sonnet-4-6'
const PROMPT = 'NATIVE_STOP_FIXTURE: finish the synthetic task'
const FEEDBACK = 'NATIVE_STOP_FEEDBACK'
const FAILURE = 'NATIVE_STOP_FAILURE'
const REASON = 'NATIVE_STOP_REASON'
const DELAY_MS = 200
const HOOK_TIMEOUT_SECONDS = 10
const MAX_REQUESTS = 4
const run = promisify(execFile)
const quote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'"
const HELP = `Usage: node scripts/verify-native-stop.mjs [-d claude-code|codex] [-b PATH] [--aggregation|--outputs]

Verify native Stop payloads, awaited decisions, continuation input and artifacts.
Requires Node.js 22+, POSIX and the selected pinned executable: Claude Code
${VERSIONS['claude-code']} or Codex ${VERSIONS.codex}. No package build or model account is needed.
Uses isolated temporary HOME/config/project state and a loopback provider.
Codex hook trust is explicitly bypassed for this synthetic fixture; this does
not verify native trust. Machine-managed native settings can remain active.

Options:
  -d, --dialect NAME  claude-code (default) or codex
  -b, --binary PATH   Executable (CLAUDE_BINARY/CODEX_BINARY, then claude/codex)
      --aggregation  Exercise competing Stop outputs and native ordering
      --outputs      Exercise Claude command output, error and timeout artifacts
  -h, --help          Show help without binaries or dependencies

Metadata-only JSON goes to stdout; diagnostics go to stderr without native
output, commands, environment values, provider traffic or local paths.
Exit status: 0 native checks pass; 1 runtime/check failure;
2 usage/version/platform precondition; 3 missing executable.
Temporary state is removed. No installation or live configuration changes.
Bridge Stop comparison is separate and equivalent remains false.
`

function records(text) { return text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) }
async function readRecords(path) {
  const bytes = await readFile(path)
  if (bytes.length > LIMITS.maxBytes) throw new ProbeError('NATIVE_ARTIFACT_LIMIT')
  return records(bytes.toString('utf8'))
}
function texts(message) {
  return typeof message.content === 'string' ? [message.content] : message.content.filter(part => ['text', 'input_text', 'output_text'].includes(part.type)).map(part => part.text)
}
function validate(dialect, mode, trace, rows, requests, execution, command, sourcePath, project) {
  const expected = CONTINUATIONS.has(mode) ? 2 : 1
  const starts = trace.filter(row => row.phase === 'start'), ends = trace.filter(row => row.phase === 'end')
  assert.equal(starts.length, expected)
  assert.equal(ends.length, expected)
  assert.equal(requests.length, expected)
  assert.deepEqual(starts.map(row => row.input.stop_hook_active), expected === 2 ? [false, true] : [false])
  assert.deepEqual(starts.map(row => row.input.last_assistant_message), starts.map((_, index) => 'NATIVE_STOP_ANSWER_' + (index + 1)))
  assert.ok(starts.every(row => row.input.hook_event_name === 'Stop' && row.transcriptExists))
  assert.ok(starts.every(row => typeof row.input.session_id === 'string' && row.input.session_id && typeof (row.input.turn_id ?? row.input.prompt_id) === 'string' && (row.input.turn_id ?? row.input.prompt_id) && isAbsolute(row.input.transcript_path) && row.input.cwd === project))
  assert.equal(new Set(starts.map(row => row.input.session_id)).size, 1)
  assert.equal(new Set(starts.map(row => row.input.transcript_path)).size, 1)
  assert.equal(new Set(starts.map(row => row.input.turn_id ?? row.input.prompt_id)).size, 1)
  assert.ok(starts.every((row, index) => ends[index].time >= row.time + DELAY_MS))
  assert.ok(starts.every((row, index) => requests[index].time <= row.time))
  assert.ok(execution.completedAt >= ends.at(-1).time)
  if (expected === 2) assert.ok(requests[1].time >= ends[0].time)
  let additionalNativeHandlers = 0, nativeDiagnosticItems = 0
  if (dialect === 'claude-code') {
    const result = JSON.parse(execution.stdout)
    assert.equal(result.is_error, false)
    assert.equal(result.result, 'NATIVE_STOP_ANSWER_' + expected)
    assert.ok(starts.every(row => Array.isArray(row.input.background_tasks) && Array.isArray(row.input.session_crons)))
    const summaries = rows.filter(row => row.type === 'system' && row.subtype === 'stop_hook_summary')
    assert.equal(summaries.length, expected)
    const stopRows = rows.filter(row => row.attachment?.hookEvent === 'Stop')
    const owned = stopRows.filter(row => row.attachment.command === command || row.attachment.blockingError?.command === command)
    const feedback = mode === 'block-stderr' ? '[' + command + ']: ' + FEEDBACK : FEEDBACK
    for (const [index, summary] of summaries.entries()) {
      const own = summary.hookInfos.filter(info => info.command === command)
      assert.equal(own.length, 1)
      assert.equal(Object.hasOwn(own[0], 'durationMs'), !(index === 0 && CONTINUATIONS.has(mode)))
      if (Object.hasOwn(own[0], 'durationMs')) assert.ok(Number.isFinite(own[0].durationMs) && own[0].durationMs >= 0)
      assert.equal(summary.hookCount, summary.hookInfos.length)
      additionalNativeHandlers = Math.max(additionalNativeHandlers, summary.hookCount - own.length)
      assert.deepEqual(summary.hookErrors, index ? [] : mode === 'failure-policy' ? ['Failed with non-blocking status code: ' + FAILURE] : CONTINUATIONS.has(mode) ? [feedback] : [])
      assert.deepEqual(summary.hookAdditionalContext, [])
      assert.equal(summary.preventedContinuation, mode === 'stop-output')
      assert.equal(summary.stopReason, mode === 'stop-output' ? REASON : '')
      assert.equal(summary.hasOutput, index === 0)
    }
    const expectedTypes = mode === 'block-json' ? ['hook_blocking_error'] : mode === 'block-stderr' ? [] : mode === 'failure-policy' ? ['hook_non_blocking_error'] : ['hook_success']
    assert.deepEqual(owned.map(row => row.attachment.type), expectedTypes)
    if (owned.length) assert.equal(owned[0].attachment.toolUseID, summaries[0].toolUseID)
    if (mode === 'block-json') {
      const attachment = owned[0]
      const reminder = `<system-reminder>\nStop hook blocking error from command: "${command}": ${FEEDBACK}\n</system-reminder>`
      assert.deepEqual(attachment.attachment.blockingError, { blockingError: FEEDBACK, command })
      assert.deepEqual(attachment.rendered, [{ content: reminder }])
      assert.equal(attachment.renderedRole, 'system')
      const delivered = requests[1].body.messages.filter(message => texts(message).some(text => text.includes(FEEDBACK)))
      assert.equal(delivered.length, 1)
      assert.equal(delivered[0].role, 'user')
      assert.deepEqual(texts(delivered[0]), [reminder + '\n', 'Stop hook feedback:\n' + FEEDBACK])
    }
    if (mode === 'block-stderr') {
      const delivered = requests[1].body.messages.filter(message => texts(message).some(text => text.includes(FEEDBACK)))
      assert.equal(delivered.length, 1)
      assert.equal(delivered[0].role, 'user')
      assert.deepEqual(texts(delivered[0]), ['Stop hook feedback:\n' + feedback])
    }
    const meta = rows.filter(row => row.type === 'user' && row.isMeta === true && row.message.content === 'Stop hook feedback:\n' + feedback)
    assert.equal(meta.length, CONTINUATIONS.has(mode) ? 1 : 0)
    const firstAnswer = rows.findIndex(row => row.type === 'assistant' && texts(row.message).includes('NATIVE_STOP_ANSWER_1'))
    assert.ok(firstAnswer >= 0 && firstAnswer < rows.indexOf(summaries[0]))
    if (meta.length) {
      assert.ok(firstAnswer < rows.indexOf(meta[0]) && rows.indexOf(meta[0]) < rows.indexOf(summaries[0]))
      assert.ok(rows.indexOf(summaries[0]) < rows.findIndex(row => row.type === 'assistant' && texts(row.message).includes('NATIVE_STOP_ANSWER_2')))
      if (mode === 'block-json') assert.ok(rows.indexOf(meta[0]) < rows.indexOf(owned[0]))
      const messages = requests[1].body.messages
      assert.ok(messages.findIndex(message => message.role === 'assistant' && texts(message).includes('NATIVE_STOP_ANSWER_1')) < messages.findIndex(message => texts(message).some(text => text.includes(FEEDBACK))))
    }
    if (mode === 'failure-policy') {
      assert.equal(owned[0].attachment.stderr, 'Failed with non-blocking status code: ' + FAILURE)
      assert.equal(owned[0].attachment.exitCode, 1)
      assert.equal(owned[0].attachment.stdout, '')
      assert.equal(Object.hasOwn(owned[0], 'rendered'), false)
    }
    if (mode === 'stop-output') {
      const stopped = stopRows.filter(row => row.attachment.type === 'hook_stopped_continuation')
      assert.equal(stopped.length, 1)
      assert.equal(stopped[0].attachment.message, REASON)
      assert.equal(stopped[0].attachment.toolUseID, owned[0].attachment.toolUseID)
      assert.deepEqual(stopped[0].rendered, [{ content: `<system-reminder>\nStop hook stopped continuation: ${REASON}\n</system-reminder>` }])
      assert.equal(owned[0].attachment.content, '')
      assert.equal(owned[0].attachment.exitCode, 0)
      assert.equal(owned[0].attachment.stdout, JSON.stringify({ continue: false, stopReason: REASON }) + '\n')
      assert.equal(owned[0].attachment.stderr, '')
      assert.equal(Object.hasOwn(owned[0], 'rendered'), false)
      assert.ok(rows.indexOf(stopped[0]) < rows.indexOf(owned[0]) && rows.indexOf(owned[0]) < rows.indexOf(summaries[0]))
    }
  } else {
    const output = records(execution.stdout)
    assert.equal(output.filter(row => row.type === 'turn.started').length, 1)
    assert.equal(output.filter(row => row.type === 'turn.completed').length, 1)
    const diagnostics = output.filter(row => row.item?.type === 'error')
    nativeDiagnosticItems = diagnostics.length
    assert.ok(diagnostics.every(row => output.indexOf(row) < output.findIndex(item => item.type === 'turn.started')))
    assert.deepEqual(output.filter(row => row.item?.type === 'agent_message').map(row => row.item.text), starts.map((_, index) => 'NATIVE_STOP_ANSWER_' + (index + 1)))
    assert.ok(starts.every(row => row.input.model === 'fixture' && typeof row.input.turn_id === 'string' && typeof row.input.permission_mode === 'string'))
    const hookPrompts = rows.filter(row => row.type === 'event_msg' && row.payload.type === 'item_completed' && row.payload.item.type === 'HookPrompt')
    assert.equal(hookPrompts.length, CONTINUATIONS.has(mode) ? 1 : 0)
    if (hookPrompts.length) {
      const prompt = hookPrompts[0].payload, fragments = prompt.item.fragments
      assert.equal(fragments.length, 1)
      assert.equal(fragments[0].text, FEEDBACK)
      const runID = fragments[0].hookRunId
      assert.ok(/^stop:\d+:/.test(runID) && runID.endsWith(':' + sourcePath))
      assert.equal(prompt.turn_id, starts[0].input.turn_id)
      const response = rows.find(row => row.type === 'response_item' && row.payload.id === prompt.item.id)
      const wrapper = `<hook_prompt hook_run_id="${runID}">${FEEDBACK}</hook_prompt>`
      assert.equal(response.payload.role, 'user')
      assert.deepEqual(texts(response.payload), [wrapper])
      assert.equal(response.payload.internal_chat_message_metadata_passthrough.turn_id, prompt.turn_id)
      assert.deepEqual(response.payload.internal_chat_message_metadata_passthrough.content_item_metadata, [{ provenance: { type: 'harness', hook: true } }])
      assert.ok(rows.findIndex(row => row.type === 'response_item' && row.payload.role === 'assistant' && texts(row.payload).includes('NATIVE_STOP_ANSWER_1')) < rows.indexOf(response))
      assert.ok(rows.indexOf(response) < rows.indexOf(hookPrompts[0]) && rows.indexOf(hookPrompts[0]) < rows.findIndex(row => row.type === 'response_item' && row.payload.role === 'assistant' && texts(row.payload).includes('NATIVE_STOP_ANSWER_2')))
      const delivered = requests[1].body.input.filter(message => message.type === 'message' && texts(message).some(text => text.includes(FEEDBACK)))
      assert.equal(delivered.length, 1)
      assert.equal(delivered[0].role, 'user')
      assert.deepEqual(texts(delivered[0]), [wrapper])
      assert.ok(requests[1].body.input.findIndex(message => message.type === 'message' && message.role === 'assistant' && texts(message).includes('NATIVE_STOP_ANSWER_1')) < requests[1].body.input.indexOf(delivered[0]))
    }
  }
  return { mode, awaitedCompletion: true, modelRequests: expected, stopInvocations: expected, stableTurnIdentity: true, continuationActiveFlag: expected === 2, additionalNativeHandlers, nativeDiagnosticItems }
}

async function verify(dialect, binary, fixture) {
  if (process.platform === 'win32') throw new ProbeError('PLATFORM_UNAVAILABLE: POSIX process groups', 2)
  let version
  try { version = (await run(binary, ['--version'], { timeout: LIMITS.durationMs, maxBuffer: LIMITS.maxBytes })).stdout.trim().replace(/^codex-cli /, '') } catch (error) { throw new ProbeError(error.code === 'ENOENT' || error.code === 'EACCES' ? 'DEPENDENCY_UNAVAILABLE: ' + dialect : 'DEPENDENCY_QUERY_FAILED: ' + dialect, error.code === 'ENOENT' || error.code === 'EACCES' ? 3 : 1) }
  if (version !== VERSIONS[dialect] && !(dialect === 'claude-code' && version.startsWith(VERSIONS[dialect] + ' '))) throw new ProbeError('NATIVE_VERSION_MISMATCH', 2)
  const root = await realpath(await mkdtemp(join(tmpdir(), 'harness-native-stop-')))
  let gateway, stage = 'setup', mode
  const requests = [], cases = []
  const aggregation = fixture === FIXTURES.AGGREGATION, outputs = fixture === FIXTURES.OUTPUTS
  try {
    gateway = createServer(async (request, response) => {
      try {
        const chunks = []; let bytes = 0
        for await (const chunk of request) { bytes += chunk.length; if (bytes > LIMITS.maxBytes) throw new Error(); chunks.push(chunk) }
        if (request.url.includes('/count_tokens')) { response.setHeader('content-type', 'application/json'); response.end('{"input_tokens":1}'); return }
        if (!request.url.includes(dialect === 'codex' ? '/responses' : '/messages')) { response.writeHead(404); response.end('{}'); return }
        const body = JSON.parse(Buffer.concat(chunks).toString())
        const count = requests.filter(row => row.mode === mode).length + 1
        if (count > MAX_REQUESTS) throw new Error()
        requests.push({ mode, time: Date.now(), body })
        const text = 'NATIVE_STOP_ANSWER_' + count, id = 'native-stop-' + count
        if (dialect === 'codex') {
          const events = [{ type: 'response.created', response: { id } }, { type: 'response.output_item.done', item: { type: 'message', role: 'assistant', id: id + '-message', content: [{ type: 'output_text', text }] } }, { type: 'response.completed', response: { id, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }]
          response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end(events.map(event => 'event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n').join('')); return
        }
        const message = { id, type: 'message', role: 'assistant', content: [{ type: 'text', text }], model: body.model, stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }
        if (!body.stream) { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(message)); return }
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        const emit = (type, value) => response.write('event: ' + type + '\ndata: ' + JSON.stringify({ type, ...value }) + '\n\n')
        emit('message_start', { message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } })
        emit('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }); emit('content_block_delta', { index: 0, delta: { type: 'text_delta', text } })
        emit('content_block_stop', { index: 0 }); emit('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }); emit('message_stop', {}); response.end()
      } catch { if (!response.headersSent) response.writeHead(500); response.end('{}') }
    })
    await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve))
    for (const scenario of outputs ? await stopOutputCases() : aggregation ? await stopAggregationCases(dialect) : MODES.map(name => ({ name }))) {
      mode = scenario.name
      stage = mode
      const state = join(root, mode), project = join(state, 'project'), home = join(state, 'home'), config = join(state, 'config')
      await Promise.all([project, home, config].map(path => mkdir(path, { recursive: true })))
      const trace = join(state, 'hooks.jsonl'), hook = join(state, 'hook.cjs'), settings = join(state, 'settings.json'), mcp = join(state, 'mcp.json')
      if (!aggregation && !outputs) await writeFile(hook, `const fs=require('node:fs');const input=JSON.parse(fs.readFileSync(0,'utf8'));const path=${JSON.stringify(trace)};const rows=fs.existsSync(path)?fs.readFileSync(path,'utf8').trim().split('\\n').filter(Boolean).map(JSON.parse):[];const ordinal=rows.filter(row=>row.phase==='start').length;if(ordinal>=${MAX_REQUESTS})process.exit(9);const transcriptExists=typeof input.transcript_path==='string'&&fs.existsSync(input.transcript_path);const log=phase=>fs.appendFileSync(path,JSON.stringify({phase,ordinal,input,transcriptExists,time:Date.now()})+'\\n');log('start');setTimeout(()=>{log('end');if(ordinal)return;if(${JSON.stringify(mode)}==='block-json')console.log(JSON.stringify({decision:'block',reason:${JSON.stringify(FEEDBACK)}}));else if(${JSON.stringify(mode)}==='block-stderr'){process.stderr.write(${JSON.stringify(FEEDBACK)});process.exit(2)}else if(${JSON.stringify(mode)}==='failure-policy'){process.stderr.write(${JSON.stringify(FAILURE)});process.exit(1)}else console.log(JSON.stringify({continue:false,stopReason:${JSON.stringify(REASON)}}))},${DELAY_MS})`)
      const command = { type: 'command', command: dialect === 'claude-code' ? process.execPath : [process.execPath, hook].map(quote).join(' '), ...(dialect === 'claude-code' ? { args: [hook] } : {}), timeout: HOOK_TIMEOUT_SECONDS, ...(mode === 'failure-policy' ? { onFailure: 'block' } : {}) }
      const commands = outputs ? await createStopOutputFixture(scenario, trace, hook) : aggregation ? await createStopAggregationFixture(scenario, trace, hook, dialect) : [command]
      await run(process.execPath, ['--check', hook], { timeout: LIMITS.durationMs, maxBuffer: LIMITS.maxBytes })
      await writeFile(settings, JSON.stringify({ hooks: { Stop: [{ hooks: commands }] } })); await writeFile(mcp, '{"mcpServers":{}}')
      const env = { PATH: process.env.PATH, HOME: home, SHELL: '/bin/sh', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_NON_ESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1' }
      let args, sourcePath = settings
      if (dialect === 'claude-code') {
        Object.assign(env, { CLAUDE_CONFIG_DIR: config, ANTHROPIC_API_KEY: 'synthetic', ANTHROPIC_BASE_URL: 'http://127.0.0.1:' + gateway.address().port })
        args = ['-p', '--output-format', 'json', '--setting-sources', '', '--strict-mcp-config', '--mcp-config', mcp, '--settings', settings, '--tools', '', '--model', MODEL]
      } else {
        Object.assign(env, { CODEX_HOME: config })
        await writeFile(join(config, 'config.toml'), 'model="fixture"\nmodel_provider="fixture"\n[features]\nhooks=true\n[model_providers.fixture]\nname="Fixture"\nbase_url="http://127.0.0.1:' + gateway.address().port + '/v1"\nwire_api="responses"\nrequires_openai_auth=false\nsupports_websockets=false\n')
        sourcePath = join(config, 'hooks.json'); await writeFile(sourcePath, await readFile(settings))
        args = ['exec', '--json', '--dangerously-bypass-hook-trust', '--skip-git-repo-check', '--model', 'fixture', '-']
      }
      const sourceSnapshot = await readFile(sourcePath), commandSnapshot = await readFile(hook)
      const execution = await runNativeProcess(binary, args, PROMPT, project, env)
      assert.deepEqual(await readFile(sourcePath), sourceSnapshot)
      assert.deepEqual(await readFile(hook), commandSnapshot)
      const events = await readRecords(trace)
      const nativeRows = await readRecords(events[0].input.transcript_path), nativeRequests = requests.filter(row => row.mode === mode)
      cases.push(outputs ? validateStopOutput(scenario, events, nativeRows, nativeRequests, execution, [process.execPath, hook].join(' '), project) : aggregation ? validateStopAggregation(dialect, scenario, events, nativeRows, nativeRequests, execution, commands.map((_, index) => [process.execPath, hook, String(index)].join(' ')), sourcePath, project) : validate(dialect, mode, events, nativeRows, nativeRequests, execution, [process.execPath, hook].join(' '), sourcePath, project))
    }
    return { dialect, version: VERSIONS[dialect], cases, codexTrustBypassed: dialect === 'codex', fixtureSourceUnchanged: true, nativeContinuationInputAndArtifacts: true, bridgeStopComparison: 'not-implemented', equivalent: false }
  } catch (error) { throw nativeCheckError('NATIVE_STOP_CHECK_FAILED', stage, error, import.meta.url) } finally {
    if (gateway) { gateway.closeAllConnections(); await new Promise(resolve => gateway.close(resolve)) }
    await rm(root, { recursive: true, force: true })
  }
}

try {
  let parsed
  try { parsed = parseArgs({ options: { dialect: { type: 'string', short: 'd' }, binary: { type: 'string', short: 'b' }, aggregation: { type: 'boolean' }, outputs: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } }, strict: true, allowPositionals: false }) } catch { throw new ProbeError('USAGE_INVALID: use --help', 2) }
  if (parsed.values.help) process.stdout.write(HELP)
  else {
    const dialect = parsed.values.dialect ?? 'claude-code'
    if (!Object.hasOwn(VERSIONS, dialect)) throw new ProbeError('USAGE_DIALECT: expected claude-code or codex', 2)
    if (parsed.values.outputs && (parsed.values.aggregation || dialect !== 'claude-code')) throw new ProbeError('USAGE_OUTPUT_FIXTURE: --outputs requires claude-code without --aggregation', 2)
    const binary = parsed.values.binary ?? process.env[dialect === 'claude-code' ? 'CLAUDE_BINARY' : 'CODEX_BINARY'] ?? (dialect === 'claude-code' ? 'claude' : 'codex')
    if (!binary.trim()) throw new ProbeError('USAGE_BINARY_EMPTY', 2)
    const fixture = parsed.values.outputs ? FIXTURES.OUTPUTS : parsed.values.aggregation ? FIXTURES.AGGREGATION : FIXTURES.DEFAULT
    process.stdout.write(JSON.stringify(await verify(dialect, binary, fixture)) + '\n')
  }
} catch (error) { process.stderr.write((error instanceof ProbeError ? error.message : 'NATIVE_STOP_PROBE_FAILED') + '\n'); process.exitCode = error instanceof ProbeError ? error.status : 1 }
