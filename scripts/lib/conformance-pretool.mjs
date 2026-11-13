import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { access, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ConformanceError, evaluateControlObservations } from './conformance.mjs'
import { runNativeProcess } from './native-process.mjs'
import { inspectCodexTranscript, verifyCodexTranscriptReader } from './conformance-transcript.mjs'
import { createRewriteFixture, evaluateRewriteObservations, observeRewrite, REWRITE_CASES, rewriteToolResult } from './conformance-rewrite.mjs'
import { createPosttoolFixture, evaluatePosttoolObservations, observePosttool, posttoolModelView } from './conformance-posttool.mjs'

const MODEL = 'claude-sonnet-4-6'
const REASON = 'CONFORMANCE_OWNED_DENIAL_REASON'
const DONE = 'CONFORMANCE_COMPLETE'
const CONTROL_CASES = Object.freeze(['deny', 'allow'])
const DURATION_MS = 30000
const STARTUP_MS = 15000
const SHUTDOWN_MS = 3000
const MAX_BYTES = 2 * 1024 * 1024
const MAX_BUILD_BYTES = 16 * 1024 * 1024
const MAX_REQUESTS = 32
const HOOK_TIMEOUT_SECONDS = 5
const VERSION_LIMITS = Object.freeze({ durationMs: 5000, graceMs: 1000, maxBytes: 4096 })
const PROVIDER_ROUTES = Object.freeze({ '/native/api/hello': 'native-hello', '/native/v1/messages': 'native-model', '/native/v1/responses': 'codex-model', '/native/v1/messages/count_tokens': 'native-count-tokens', '/host/v1/chat/completions': 'host-model' })
export function providerRoute(path) { return PROVIDER_ROUTES[new URL(path, 'http://loopback').pathname] }
const quote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'"
const sha = value => createHash('sha256').update(value).digest('hex')
export async function fingerprintAdapter(root) {
  const paths = ['package.json', 'package-lock.json']
  const visit = async relative => {
    const entries = await readdir(join(root, relative), { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isSymbolicLink()) throw new ConformanceError('CONFORMANCE_BUILD_SYMLINK', 2)
      const path = relative + '/' + entry.name
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile() && entry.name.endsWith('.js')) paths.push(path)
    }
  }
  await visit('dist')
  const digest = createHash('sha256')
  let bytes = 0
  for (const path of paths.sort()) {
    const stat = await lstat(join(root, path))
    ensure(stat.isFile() && bytes + stat.size <= MAX_BUILD_BYTES, 'CONFORMANCE_BUILD_LIMIT')
    const content = await readFile(join(root, path))
    bytes += content.length
    ensure(bytes <= MAX_BUILD_BYTES, 'CONFORMANCE_BUILD_LIMIT')
    digest.update(path + '\0' + sha(content) + '\n')
  }
  return digest.digest('hex')
}
function ensure(condition, code) { if (!condition) throw new ConformanceError(code) }
async function bounded(promise, milliseconds, code) {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new ConformanceError(code)), milliseconds) })]) } finally { clearTimeout(timer) }
}
export async function verifyPinnedVersion(binary, name, expected) {
  let execution
  try { execution = await runNativeProcess(binary, ['--version'], '', process.cwd(), { PATH: process.env.PATH, LANG: 'C' }, VERSION_LIMITS) }
  catch (error) { throw new ConformanceError(['ENOENT', 'EACCES'].includes(error.systemCode) ? 'DEPENDENCY_UNAVAILABLE: ' + name : 'VERSION_QUERY_FAILED: ' + name, ['ENOENT', 'EACCES'].includes(error.systemCode) ? 3 : 1) }
  const actual = execution.stdout.trim().replace(/ \(Claude Code\)$/, '').replace(/^(?:opencode v|codex-cli )/, '')
  if (actual !== expected) throw new ConformanceError(name === 'opencode' ? 'HOST_VERSION_MISMATCH' : 'NATIVE_VERSION_MISMATCH', 2)
  return actual
}
function emitAnthropic(response, body, args, id, invoke) {
  const content = invoke ? [{ type: 'tool_use', id, name: 'Bash', input: args }] : [{ type: 'text', text: DONE }]
  const message = { id: 'msg_' + id, type: 'message', role: 'assistant', model: body.model, content, stop_reason: invoke ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }
  if (body.stream === false) { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(message)); return }
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  const emit = (type, value) => response.write('event: ' + type + '\ndata: ' + JSON.stringify({ type, ...value }) + '\n\n')
  emit('message_start', { message: { ...message, content: [], stop_reason: null } })
  emit('content_block_start', { index: 0, content_block: invoke ? { type: 'tool_use', id, name: 'Bash', input: {} } : { type: 'text', text: '' } })
  emit('content_block_delta', { index: 0, delta: invoke ? { type: 'input_json_delta', partial_json: JSON.stringify(args) } : { type: 'text_delta', text: DONE } })
  emit('content_block_stop', { index: 0 })
  emit('message_delta', { delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 1 } })
  emit('message_stop', {})
  response.end()
}
function emitOpenAI(response, args, id, invoke) {
  const chunk = (delta, finish_reason) => ({ id, object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason }] })
  const delta = invoke ? { role: 'assistant', tool_calls: [{ index: 0, id, type: 'function', function: { name: 'bash', arguments: JSON.stringify(args) } }] } : { role: 'assistant', content: DONE }
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  response.end('data: ' + JSON.stringify(chunk(delta, null)) + '\n\ndata: ' + JSON.stringify({ ...chunk({}, invoke ? 'tool_calls' : 'stop'), usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }) + '\n\ndata: [DONE]\n\n')
}
function emitResponses(response, args, id, invoke) {
  const item = invoke ? { id: 'fc_' + id, type: 'function_call', call_id: id, name: 'exec_command', arguments: JSON.stringify({ cmd: args.command }) } : { id: 'msg_' + id, type: 'message', role: 'assistant', content: [{ type: 'output_text', text: DONE }] }
  const events = [{ type: 'response.created', response: { id: 'response_' + id } }, { type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response: { id: 'response_' + id, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }]
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  response.end(events.map(event => 'event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n').join(''))
}
export function controlIdentityValid(input, dialect, toolUseID) {
  return typeof input?.session_id === 'string' && input.session_id.length > 0 && input.tool_use_id === toolUseID && input.permission_mode === 'bypassPermissions' && (dialect !== 'codex' || typeof input.turn_id === 'string' && input.turn_id.length > 0 && input.model === 'fixture')
}
export function controlToolResult(messages, transport, toolUseID) {
  const candidates = transport === 'responses' ? messages.filter(message => message.type === 'function_call_output') : transport === 'anthropic' ? messages.flatMap(message => Array.isArray(message.content) ? message.content.filter(part => part.type === 'tool_result') : []) : messages.filter(message => message.role === 'tool')
  const identityKey = transport === 'responses' ? 'call_id' : transport === 'anthropic' ? 'tool_use_id' : 'tool_call_id'
  const owned = candidates.filter(result => result[identityKey] === toolUseID)
  if (owned.length !== 1) return { resultOwned: false, reasonDelivered: false }
  const content = transport === 'responses' ? owned[0].output : owned[0].content
  const text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter(part => ['text', 'input_text'].includes(part?.type) && typeof part.text === 'string').map(part => part.text).join('\n') : ''
  return { resultOwned: true, reasonDelivered: text.includes(REASON) }
}
export async function stopHost(child, done) {
  if (!child || !done) return
  const signal = name => { try { if (child.pid) process.kill(-child.pid, name) } catch (error) { if (error.code !== 'ESRCH') throw error } }
  try {
    signal('SIGTERM')
    try { await bounded(done, SHUTDOWN_MS, 'HOST_SHUTDOWN_TIMEOUT') } catch { signal('SIGKILL') }
    await bounded(done, SHUTDOWN_MS, 'HOST_CLEANUP_FAILED')
  } finally { signal('SIGKILL') }
}

export const runClaudePretoolControl = options => runPretoolControl({ ...options, dialect: 'claude-code', nativeBinary: options.claudeBinary })
export const runPretoolControl = options => runToolComparison({ ...options, rewriteInput: false, posttoolEffects: false })
export const runInputRewrite = options => runToolComparison({ ...options, rewriteInput: true, posttoolEffects: false })
export const runPosttoolEffects = options => runToolComparison({ ...options, rewriteInput: false, posttoolEffects: true })
async function runToolComparison({ catalog, packageRoot, dialect, nativeBinary, opencodeBinary, rewriteInput, posttoolEffects }) {
  ensure(['claude-code', 'codex'].includes(dialect), 'CONFORMANCE_DIALECT_INVALID')
  const codex = dialect === 'codex'
  if (process.platform === 'win32') throw new ConformanceError('PLATFORM_UNAVAILABLE: POSIX process groups', 2)
  const nativeVersion = await verifyPinnedVersion(nativeBinary, codex ? 'codex' : 'claude', catalog.versions.native[dialect])
  const hostVersion = await verifyPinnedVersion(opencodeBinary, 'opencode', catalog.versions.hosts.v1)
  const entrypoint = join(packageRoot, 'dist/index.js')
  try { await access(entrypoint) } catch { throw new ConformanceError('DEPENDENCY_UNAVAILABLE: built adapter', 3) }
  const adapterBuildSha256 = await fingerprintAdapter(packageRoot)
  const root = await realpath(await mkdtemp(join(tmpdir(), 'hook-conformance-')))
  let gateway, child, done, stage = 'setup'
  const traffic = new Map(), gatewayErrors = [], hostCodes = new Set()
  let auxiliaryRequests = 0, totalRequests = 0, nativeHelloRequests = 0
  try {
    const project = join(root, 'project'), nativeHome = join(root, 'native-home'), hostHome = join(root, 'host-home')
    const trace = join(root, 'owned-hook.jsonl'), hook = join(root, 'hook.cjs'), source = join(nativeHome, 'native/hooks.json'), mcp = join(root, 'mcp.json')
    await Promise.all([project, nativeHome, hostHome].map(path => mkdir(path)))
    const nativeConfig = join(nativeHome, 'native'), hostConfig = join(hostHome, 'config/opencode')
    await Promise.all([mkdir(nativeConfig), mkdir(hostConfig, { recursive: true }), mkdir(join(nativeHome, 'tmp')), mkdir(join(hostHome, 'tmp')), writeFile(mcp, '{"mcpServers":{}}')])
    const rewrite = rewriteInput ? createRewriteFixture({ project, hook, trace, node: process.execPath }) : undefined
    const posttool = posttoolEffects ? createPosttoolFixture({ project, hook, trace, node: process.execPath, dialect }) : undefined
    const cases = posttool?.cases ?? (rewrite ? REWRITE_CASES : CONTROL_CASES)
    const hookText = posttool?.hookText ?? rewrite?.hookText ?? `const fs=require('node:fs');const p=JSON.parse(fs.readFileSync(0,'utf8'));const transcriptExists=typeof p.transcript_path==='string'&&fs.existsSync(p.transcript_path);let transcriptContentValid;if(${codex}){transcriptContentValid=false;try{if(transcriptExists&&fs.statSync(p.transcript_path).size<=${MAX_BYTES}){const rows=fs.readFileSync(p.transcript_path,'utf8').trim().split('\\n').map(line=>JSON.parse(line));const inspect=${inspectCodexTranscript.toString()};transcriptContentValid=inspect(rows,p,'CONFORMANCE_CASE:'+(p.tool_input.command.includes('CONFORMANCE_DENY')?'deny':'allow'))}}catch{}}fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify({input:p,transcriptExists,transcriptContentValid})+'\\n');if(p.tool_input.command.includes('CONFORMANCE_DENY'))console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:${JSON.stringify(REASON)}}}));`
    await writeFile(hook, hookText)
    const sourceText = posttool?.sourceText ?? rewrite?.sourceText ?? JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: [process.execPath, hook].map(quote).join(' '), timeout: HOOK_TIMEOUT_SECONDS }] }] } })
    await writeFile(source, sourceText)
    const sourceDigest = sha(sourceText), hookDigest = sha(hookText)
    const marker = id => join(project, id + '.marker')
    const command = rewrite?.command ?? (id => 'printf ' + (id === 'deny' ? 'CONFORMANCE_DENY' : 'CONFORMANCE_ALLOW') + ' > ' + quote(marker(id)))
    const toolID = (backend, id, phase) => (backend === 'native' ? 'toolu_' : 'call_') + 'conformance_' + id + (posttool ? '_' + phase : '')
    gateway = createServer(async (request, response) => {
      try {
        ensure(++totalRequests <= MAX_REQUESTS, 'GATEWAY_REQUEST_LIMIT')
        let bytes = 0
        const chunks = []
        for await (const chunk of request) { bytes += chunk.length; ensure(bytes <= MAX_BYTES, 'GATEWAY_INPUT_LIMIT'); chunks.push(chunk) }
        const route = providerRoute(request.url)
        ensure(route !== undefined, 'GATEWAY_ROUTE_INVALID')
        if (route === 'native-hello') { nativeHelloRequests++; response.writeHead(404); response.end('{}'); return }
        if (route === 'native-count-tokens') { auxiliaryRequests++; response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"input_tokens":1}'); return }
        const responses = route === 'codex-model'
        const native = route === 'native-model' || responses
        ensure(!native || responses === codex, 'GATEWAY_NATIVE_TRANSPORT_INVALID')
        const body = JSON.parse(Buffer.concat(chunks))
        const primary = body.tools?.some(tool => responses ? tool.name === 'exec_command' : native ? tool.name === 'Bash' : tool.function?.name === 'bash')
        if (responses) ensure(primary, 'GATEWAY_NATIVE_TOOL_UNAVAILABLE')
        if (!primary) { auxiliaryRequests++; if (native) emitAnthropic(response, body, {}, 'auxiliary', false); else emitOpenAI(response, {}, 'auxiliary', false); return }
        const messages = responses ? body.input : body.messages
        const id = cases.find(id => JSON.stringify(messages).includes('CONFORMANCE_CASE:' + id))
        ensure(id, 'GATEWAY_CASE_MISSING')
        const backend = native ? 'native' : 'host', key = backend + ':' + id
        const state = traffic.get(key) ?? { count: 0, reasonDelivered: false }
        state.count++
        ensure(state.count <= (posttool ? 3 : 2), 'GATEWAY_PRIMARY_LIMIT')
        const transport = responses ? 'responses' : native ? 'anthropic' : 'chat'
        if (posttool) {
          if (state.count === 1) ensure(posttool.effectTokens.every(value => !JSON.stringify(messages).includes(value)), 'GATEWAY_RESULT_CONTAMINATED')
          else {
            const phase = state.count === 2 ? 'first' : 'next'
            state[phase] = posttoolModelView(messages, transport, posttool.modelOptions(id, toolID(backend, id, 'first'), toolID(backend, id, 'next')), phase)
          }
        } else if (state.count === 1) ensure(rewrite ? [rewrite.expectedOutput(id), ...rewrite.unexpectedOutputs(id)].every(value => !JSON.stringify(messages).includes(value)) : !JSON.stringify(messages).includes(REASON), rewrite ? 'GATEWAY_RESULT_CONTAMINATED' : 'GATEWAY_REASON_CONTAMINATED')
        else Object.assign(state, rewrite ? rewriteToolResult(messages, transport, toolID(backend, id), rewrite.expectedOutput(id), rewrite.unexpectedOutputs(id)) : controlToolResult(messages, transport, toolID(backend, id)))
        traffic.set(key, state)
        const phase = state.count === 1 ? 'first' : 'next', invoke = state.count < (posttool ? 3 : 2)
        const args = { command: posttool ? posttool.command(id, phase) : command(id), description: 'Controlled conformance side effect' }, callID = toolID(backend, id, phase)
        if (responses) emitResponses(response, args, callID, invoke)
        else if (native) emitAnthropic(response, body, args, callID, invoke)
        else emitOpenAI(response, args, callID, invoke)
      } catch (error) { gatewayErrors.push(error instanceof ConformanceError ? error.message : 'GATEWAY_INVALID_REQUEST'); if (!response.headersSent) response.writeHead(500); response.end('{}') }
    })
    await new Promise((resolve, reject) => { gateway.once('error', reject); gateway.listen(0, '127.0.0.1', resolve) })
    const address = 'http://127.0.0.1:' + gateway.address().port
    const environment = home => ({ PATH: process.env.PATH, HOME: home, PWD: project, SHELL: '/bin/sh', LANG: 'C', TMPDIR: join(home, 'tmp'), XDG_CONFIG_HOME: join(home, 'config'), XDG_STATE_HOME: join(home, 'state'), XDG_DATA_HOME: join(home, 'data'), XDG_CACHE_HOME: join(home, 'cache'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_NON_ESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1' })
    const nativeEnv = codex ? { ...environment(nativeHome), CODEX_HOME: nativeConfig } : { ...environment(nativeHome), CLAUDE_CONFIG_DIR: nativeConfig, ANTHROPIC_API_KEY: 'synthetic', ANTHROPIC_BASE_URL: address + '/native' }
    const nativeArgs = codex ? ['exec', '--json', '--dangerously-bypass-hook-trust', '--skip-git-repo-check', '--model', 'fixture', '-'] : ['-p', '--output-format', 'json', '--setting-sources', '', '--strict-mcp-config', '--mcp-config', mcp, '--settings', source, '--tools', 'Bash', '--dangerously-skip-permissions', '--max-turns', '3', '--model', MODEL]
    if (codex) await writeFile(join(nativeConfig, 'config.toml'), 'model="fixture"\nmodel_provider="fixture"\napproval_policy="never"\nsandbox_mode="danger-full-access"\n[features]\nhooks=true\n[model_providers.fixture]\nname="Fixture"\nbase_url="' + address + '/native/v1"\nwire_api="responses"\nrequires_openai_auth=false\nsupports_websockets=false\n')
    const observe = async (backend, id) => {
      const lines = (await readFile(trace, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
      const row = lines[0], input = row?.input, requests = traffic.get(backend + ':' + id)
      if (posttool) return observePosttool({ fixture: posttool, id, lines, requests, project, dialect, toolIDs: ['first', 'next'].map(phase => toolID(backend, id, phase)) })
      if (rewrite) return observeRewrite({ fixture: rewrite, lines, requests, dialect, toolUseID: toolID(backend, id), project, id })
      let content = null
      try { content = await readFile(marker(id), 'utf8') } catch (error) { if (error.code !== 'ENOENT') throw error }
      if (content !== null) ensure(content === (id === 'deny' ? 'CONFORMANCE_DENY' : 'CONFORMANCE_ALLOW'), 'CONFORMANCE_SIDE_EFFECT_CONTENT')
      const artifact = codex ? { transcriptContentValid: row?.transcriptContentValid === true, nativeReaderAccepted: row?.transcriptExists === true && await verifyCodexTranscriptReader({ binary: nativeBinary, root, project, input, prompt: 'CONFORMANCE_CASE:' + id, fixtureID: backend + '-' + id, ...(backend === 'native' ? { nativeHome: nativeConfig } : {}) }) } : {}
      return { id, hookInvocations: lines.length, event: input?.hook_event_name ?? null, tool: input?.tool_name ?? null, cwdMatches: input?.cwd === project, commandMatches: input?.tool_input?.command === command(id), identityValid: controlIdentityValid(input, dialect, toolID(backend, id)), transcriptExists: row?.transcriptExists === true, resultOwned: requests?.resultOwned === true, reasonDelivered: requests?.reasonDelivered === true, sideEffect: content !== null, primaryModelCalls: requests?.count ?? 0, ...artifact }
    }
    const prepare = async id => { await writeFile(trace, ''); await Promise.all((posttool ? Object.values(posttool.records(id)).map(row => row.path) : rewrite ? Object.values(rewrite.markerPaths) : [marker(id)]).map(path => rm(path, { force: true }))) }
    const nativeControls = []
    for (const id of cases) {
      stage = 'native-' + id
      await prepare(id)
      const execution = await runNativeProcess(nativeBinary, nativeArgs, 'CONFORMANCE_CASE:' + id, project, nativeEnv)
      if (codex) {
        const results = execution.stdout.trim().split('\n').map(line => JSON.parse(line))
        ensure(results.filter(row => row.type === 'turn.completed').length === 1 && results.some(row => row.type === 'item.completed' && row.item?.type === 'agent_message' && row.item.text === DONE), 'NATIVE_RESULT_INVALID')
      } else {
        const result = JSON.parse(execution.stdout)
        ensure(result.is_error === false && result.result?.includes(DONE), 'NATIVE_RESULT_INVALID')
      }
      nativeControls.push(await observe('native', id))
    }
    stage = 'host-start'
    const password = 'synthetic-conformance-only'
    const hostEnv = { ...environment(hostHome), OPENCODE_CONFIG_DIR: hostConfig, OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_CLAUDE_CODE: '1', OPENCODE_DISABLE_DEFAULT_PLUGINS: '1', OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_EXTERNAL_SKILLS: '1', OPENCODE_PASSWORD: password }
    const options = { sources: [{ id: 'conformance', dialect, path: source }], reviewedDigests: { conformance: sourceDigest }, permissionMode: 'bypassPermissions' }
    await writeFile(join(hostConfig, 'opencode.json'), JSON.stringify({ model: 'fixture/fixture', small_model: 'fixture/fixture', enabled_providers: ['fixture'], snapshot: false, share: 'disabled', autoupdate: false, permission: 'allow', plugin: [[pathToFileURL(entrypoint).href, options]], provider: { fixture: { npm: '@ai-sdk/openai-compatible', options: { apiKey: 'synthetic', baseURL: address + '/host/v1' }, models: { fixture: { name: 'Conformance fixture', tool_call: true, limit: { context: 50000, output: 2000 } } } } } }))
    child = spawn(opencodeBinary, ['--print-logs', 'serve', '--hostname', '127.0.0.1', '--port', '0'], { cwd: project, env: hostEnv, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    done = new Promise(resolve => child.once('close', resolve))
    child.stderr.on('data', chunk => { for (const code of String(chunk).match(/\b(?:HOST|SOURCE|PLUGIN)_[A-Z_]+\b/g) ?? []) hostCodes.add(code) })
    const hostAddress = await bounded(new Promise((resolve, reject) => {
      let text = ''
      child.once('error', () => reject(new ConformanceError('HOST_START_FAILED')))
      child.once('close', () => reject(new ConformanceError('HOST_EXITED_BEFORE_READY')))
      child.stdout.on('data', chunk => { text = (text + String(chunk)).slice(-MAX_BYTES); const found = /http:\/\/127\.0\.0\.1:\d+/.exec(text)?.[0]; if (found) resolve(found) })
    }), STARTUP_MS, 'HOST_STARTUP_TIMEOUT')
    const post = async (path, body) => {
      const response = await fetch(hostAddress + path + '?directory=' + encodeURIComponent(project), { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Basic ' + Buffer.from('opencode:' + password).toString('base64') }, body: JSON.stringify(body), signal: AbortSignal.timeout(DURATION_MS) })
      ensure(response.ok, 'HOST_API_FAILED')
      return response.json()
    }
    const hostControls = []
    for (const id of cases) {
      stage = 'host-' + id
      await prepare(id)
      const session = await post('/session', {})
      const result = await post('/session/' + session.id + '/message', { model: { providerID: 'fixture', modelID: 'fixture' }, parts: [{ type: 'text', text: 'CONFORMANCE_CASE:' + id }] })
      ensure(JSON.stringify(result).includes(DONE), 'HOST_RESULT_INVALID')
      hostControls.push(await observe('host', id))
    }
    stage = 'compare'
    ensure(gatewayErrors.length === 0, 'GATEWAY_FAILED: ' + [...new Set(gatewayErrors)].join(','))
    if (!posttool) ensure(hostCodes.size === 0, 'HOST_DIAGNOSTIC_FAILURE')
    ensure(sha(await readFile(source)) === sourceDigest && sha(await readFile(hook)) === hookDigest, 'CONFORMANCE_SOURCE_CHANGED')
    ensure(await fingerprintAdapter(packageRoot) === adapterBuildSha256, 'CONFORMANCE_BUILD_CHANGED')
    const traces = [{ sourceDigest, hookDigest, controls: nativeControls }, { sourceDigest, hookDigest, controls: hostControls }]
    const outcome = posttool ? evaluatePosttoolObservations({ ...traces[0], diagnostics: [] }, { ...traces[1], diagnostics: [...hostCodes].sort() }, dialect) : rewrite ? evaluateRewriteObservations(...traces) : evaluateControlObservations(...traces, { codexTranscript: codex })
    return { caseID: (codex ? 'codex' : 'claude') + (posttool ? '.posttooluse.effects' : '.pretooluse.' + (rewrite ? 'input-rewrite' : 'control')), host: 'v1', nativeVersion, hostVersion, ...outcome, platform: process.platform, architecture: process.arch, adapterBuildSha256, auxiliaryRequests, nativeHelloRequests, isolation: { temporaryHomeAndConfig: true, loopbackProvider: true, sourceBytesUnchanged: true, nativePermissionBypass: true, nativeTrustVerified: false, machineManagedSettingsMayRemain: true, ...(codex ? { nativeHookTrustBypassed: true } : {}) }, limits: ['Specified observables only; full event payload and rendering remain unverified', 'No real-model or native trust conformance claim', ...(codex ? ['Native exec_command is observed independently as Bash hook input; other tool families remain unverified'] : ['Native api/hello receives 404 and is counted outside model requests']), 'V1 only; V2 is not exercised by this case'] }
  } catch (error) {
    if (error instanceof ConformanceError) throw error
    throw new ConformanceError('CONFORMANCE_CASE_FAILED: ' + stage)
  } finally {
    try { await stopHost(child, done) } finally {
      if (gateway) { gateway.closeAllConnections(); await new Promise(resolve => gateway.close(resolve)) }
      await rm(root, { recursive: true, force: true })
    }
  }
}
