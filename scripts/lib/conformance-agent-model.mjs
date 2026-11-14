import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { access, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ConformanceError } from './conformance.mjs'
import { fingerprintAdapter, initializeHost, stopHost, verifyPinnedVersion } from './conformance-pretool.mjs'
import { runNativeProcess } from './native-process.mjs'

const CASES = Object.freeze(['read', 'deny', 'write-denied', 'write-allowed', 'invalid', 'incomplete', 'timeout', 'api-error', 'turn-limit'])
const MODEL = 'claude-sonnet-4-6'
const HOOK = 'OWNED_AGENT_HOOK_CONDITION'
const DONE = 'OWNED_AGENT_COMPARISON_COMPLETE'
const READ_RESULT = 'OWNED_AGENT_FILE_CONTENT'
const CALLER_RULE = 'OWNED_AGENT_CALLER_INSTRUCTION'
const MAX_BYTES = 2 * 1024 * 1024
const MAX_REQUESTS = 400
const REQUEST_MS = 90000
const START_MS = 15000
const quote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'"
const digest = value => createHash('sha256').update(value).digest('hex')
function ensure(value, code) { if (!value) throw new ConformanceError(code) }

function valid(row) {
  if (!row || !CASES.includes(row.mode) || row.hookCalls !== (['invalid', 'turn-limit'].includes(row.mode) ? 50 : row.mode === 'api-error' ? 4 : row.mode === 'timeout' ? 1 : 2) || row.parentCalls !== (row.mode === 'deny' ? 0 : 2) || row.done !== (row.mode !== 'deny') || row.sideEffect !== (row.mode !== 'deny') || row.evaluatorWrite !== (row.mode === 'write-allowed') || row.isolated !== true || row.inputRetained !== true || row.childRemoved !== true || row.mode !== 'deny' && row.callerInstructionObserved !== true || !Array.isArray(row.artifacts) || row.artifacts.length || !Array.isArray(row.tools)) return false
  if (['read', 'deny', 'invalid', 'turn-limit'].includes(row.mode) && row.readResult !== true) return false
  if (row.mode === 'deny' ? row.parentContext !== null : row.parentContext?.permissionMode !== 'bypassPermissions' || row.parentContext?.transcriptExists !== true || row.parentContext?.evaluatorIDsAbsent !== true) return false
  const expected = ['timeout', 'api-error', 'incomplete'].includes(row.mode) ? [] : row.mode === 'turn-limit' ? Array.from({ length: 49 }, () => [['PreToolUse', 'Read'], ['PostToolUse', 'Read']]).flat() : [['PreToolUse', row.mode.startsWith('write') ? 'Bash' : 'Read'], ...(row.mode !== 'write-denied' ? [['PostToolUse', row.mode.startsWith('write') ? 'Bash' : 'Read']] : []), ...(row.mode !== 'invalid' ? [['PreToolUse', 'StructuredOutput'], ['PostToolUse', 'StructuredOutput']] : [])]
  if (row.tools.length !== expected.length) return false
  const calls = new Set()
  for (const [index, tool] of row.tools.entries()) {
    if (!tool || tool.event !== expected[index][0] || tool.tool !== expected[index][1] || tool.parentIdentity !== true || tool.permissionMode !== 'dontAsk' || tool.transcriptExists !== false || typeof tool.callID !== 'string' || !tool.callID) return false
    if (tool.event === 'PreToolUse') { if (calls.has(tool.callID)) return false; calls.add(tool.callID) }
    else if (row.tools[index - 1]?.callID !== tool.callID) return false
  }
  return true
}
export function compareAgentModelEvidence(native, host) {
  const complete = rows => Array.isArray(rows) && rows.length === CASES.length && new Set(rows.map(row => row.mode)).size === CASES.length && rows.every(valid)
  const match = complete(native) && complete(host)
  return { status: match ? 'passed' : 'failed', comparison: { match, native, host, ...(!match ? { failure: 'CONFORMANCE_AGENT_MODEL_MISMATCH' } : {}) } }
}

function anthropic(response, body, content) {
  const invoke = content.some(part => part.type === 'tool_use')
  const message = { id: 'msg_agent_comparison', type: 'message', role: 'assistant', model: body.model, content, stop_reason: invoke ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }
  if (body.stream === false) { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(message)); return }
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  const event = (type, data) => response.write('event: ' + type + '\ndata: ' + JSON.stringify({ type, ...data }) + '\n\n')
  event('message_start', { message: { ...message, content: [], stop_reason: null } })
  for (const [index, part] of content.entries()) {
    event('content_block_start', { index, content_block: part.type === 'tool_use' ? { ...part, input: {} } : { ...part, text: '' } })
    event('content_block_delta', { index, delta: part.type === 'tool_use' ? { type: 'input_json_delta', partial_json: JSON.stringify(part.input) } : { type: 'text_delta', text: part.text } })
    event('content_block_stop', { index })
  }
  event('message_delta', { delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 1 } }); event('message_stop', {}); response.end()
}
function chat(response, name, input, id, text) {
  const chunk = (delta, finish) => ({ id: 'chatcmpl_agent_comparison', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason: finish }] })
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  const delta = name ? { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(input) } }] } : { content: text }
  response.end('data: ' + JSON.stringify(chunk({ role: 'assistant', ...delta }, null)) + '\n\ndata: ' + JSON.stringify({ ...chunk({}, name ? 'tool_calls' : 'stop'), usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }) + '\n\ndata: [DONE]\n\n')
}
function environment(home, project) {
  return { PATH: process.env.PATH, HOME: home, PWD: project, SHELL: '/bin/sh', LANG: 'C', TMPDIR: join(home, 'tmp'), XDG_CONFIG_HOME: join(home, 'config'), XDG_STATE_HOME: join(home, 'state'), XDG_DATA_HOME: join(home, 'data'), XDG_CACHE_HOME: join(home, 'cache'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_NON_ESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1' }
}
async function availablePort() { const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port }

export async function runAgentModelComparison({ catalog, packageRoot, nativeBinary, opencodeBinary }) {
  if (process.platform === 'win32') throw new ConformanceError('PLATFORM_UNAVAILABLE: POSIX process groups', 2)
  const nativeVersion = await verifyPinnedVersion(nativeBinary, 'claude', catalog.versions.native['claude-code'])
  const hostVersion = await verifyPinnedVersion(opencodeBinary, 'opencode', catalog.versions.hosts.v1)
  const entrypoint = join(packageRoot, 'dist/index.js')
  try { await access(entrypoint) } catch { throw new ConformanceError('DEPENDENCY_UNAVAILABLE: built adapter', 3) }
  const adapterBuildSha256 = await fingerprintAdapter(packageRoot), root = await realpath(await mkdtemp(join(tmpdir(), 'agent-model-conformance-')))
  let gateway, child, closed, timer, stage = 'setup', requests = 0
  const traffic = new Map(), errors = [], codes = new Set(), sourceDigests = new Map()
  try {
    const project = join(root, 'project'), nativeHome = join(root, 'native-home'), hostHome = join(root, 'host-home'), nativeConfig = join(nativeHome, 'native'), hostConfig = join(hostHome, 'config/opencode')
    await Promise.all([mkdir(project), mkdir(nativeConfig, { recursive: true }), mkdir(hostConfig, { recursive: true }), mkdir(join(nativeHome, 'tmp'), { recursive: true }), mkdir(join(hostHome, 'tmp'), { recursive: true })])
    const recorder = join(root, 'record.cjs'), trace = join(root, 'trace.jsonl'), marker = join(project, 'parent.marker'), denied = join(project, 'agent-denied.marker'), approved = join(project, 'agent-approved.marker'), mcp = join(root, 'mcp.json'), readPath = join(project, 'read.txt')
    const recorderText = `const fs=require('node:fs');const p=JSON.parse(fs.readFileSync(0,'utf8'));const exists=typeof p.transcript_path==='string'&&fs.existsSync(p.transcript_path);const text=exists?fs.readFileSync(p.transcript_path,'utf8'):'';if(Buffer.byteLength(text)>${MAX_BYTES})process.exit(1);const rows=text.trim()?text.trim().split('\\n').map(line=>JSON.parse(line)):[];fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify({payload:p,exists,evaluatorIDsAbsent:!text.includes('toolu_agent_')&&!text.includes('call_agent_'),artifacts:rows.filter(row=>row.type==='attachment'&&row.attachment?.hookEvent==='UserPromptSubmit').map(row=>row.attachment)})+'\\n');if(p.hook_event_name==='PreToolUse'&&p.tool_name==='Bash'&&p.tool_input?.command?.includes('agent-approved.marker'))console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'allow'}}));`
    const command = { type: 'command', command: [process.execPath, recorder].map(quote).join(' '), timeout: 5 }
    for (const timeout of [60, 1]) {
      const text = JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [command, { type: 'agent', prompt: HOOK + ' $ARGUMENTS', model: MODEL, timeout }] }], PreToolUse: [{ hooks: [command] }, { matcher: 'Read|StructuredOutput', hooks: [{ type: 'prompt', prompt: 'MODEL_RECURSION_FORBIDDEN' }, { type: 'agent', prompt: 'AGENT_RECURSION_FORBIDDEN' }] }], PostToolUse: [{ hooks: [command] }, { matcher: 'Read|StructuredOutput', hooks: [{ type: 'prompt', prompt: 'MODEL_RECURSION_FORBIDDEN' }, { type: 'agent', prompt: 'AGENT_RECURSION_FORBIDDEN' }] }] } })
      const path = join(root, 'hooks-' + timeout + '.json'); await writeFile(path, text); sourceDigests.set(path, digest(text))
    }
    await Promise.all([writeFile(recorder, recorderText), writeFile(mcp, '{"mcpServers":{}}'), writeFile(readPath, READ_RESULT), ...['AGENTS.md', 'CLAUDE.md'].map(name => writeFile(join(project, name), CALLER_RULE + '\n'))])
    gateway = createServer(async (request, response) => {
      try {
        ensure(++requests <= MAX_REQUESTS, 'GATEWAY_REQUEST_LIMIT')
        const path = new URL(request.url, 'http://loopback').pathname
        if (path.endsWith('/api/hello')) { response.writeHead(404); response.end('{}'); return }
        if (path.endsWith('/messages/count_tokens')) { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"input_tokens":1}'); return }
        let bytes = 0; const chunks = []
        for await (const chunk of request) { bytes += chunk.length; ensure(bytes <= MAX_BYTES, 'GATEWAY_INPUT_LIMIT'); chunks.push(chunk) }
        const body = JSON.parse(Buffer.concat(chunks)), native = path === '/native/v1/messages', host = path === '/host/v1/chat/completions'
        ensure(native || host, 'GATEWAY_ROUTE_INVALID')
        const tools = body.tools?.map(tool => native ? tool.name : tool.function?.name) ?? [], messages = JSON.stringify(body.messages), evaluator = messages.includes(HOOK), parent = !evaluator && messages.includes('AGENT_MODEL_CASE:') && tools.includes(native ? 'Bash' : 'bash')
        const mode = CASES.find(value => messages.includes('AGENT_MODEL_CASE:' + value)), send = (name, input, id, text = DONE) => native ? anthropic(response, body, name ? [{ type: 'tool_use', name, input, id }] : [{ type: 'text', text }]) : chat(response, name, input, id, text)
        ensure(!messages.includes('RECURSION_FORBIDDEN'), 'GATEWAY_RECURSION')
        if (!mode || !evaluator && !parent) { send(); return }
        const key = (native ? 'native:' : 'host:') + mode, state = traffic.get(key) ?? { hookCalls: 0, parentCalls: 0, isolated: true, inputRetained: true, readResult: false, callerInstructionObserved: false }
        traffic.set(key, state)
        if (evaluator) {
          const index = state.hookCalls++
          state.isolated &&= !JSON.stringify(body).includes(CALLER_RULE)
          state.inputRetained &&= messages.includes('hook_event_name') && messages.includes('UserPromptSubmit') && tools.includes(native ? 'StructuredOutput' : 'harness_hook_verdict')
          state.readResult ||= messages.includes(READ_RESULT)
          ensure(body.model === (native ? MODEL : 'fixture'), 'GATEWAY_MODEL_SELECTION')
          if (mode === 'timeout') return
          if (mode === 'api-error') { response.writeHead(400, { 'content-type': 'application/json' }); response.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'OWNED_AGENT_API_ERROR' } })); return }
          if (mode === 'incomplete') { send(undefined, undefined, undefined, 'No verdict'); return }
          if (index === 0 || mode === 'turn-limit') {
            const write = mode.startsWith('write'), name = write ? native ? 'Bash' : 'bash' : native ? 'Read' : 'read'
            const input = write ? { command: 'printf OWNED_AGENT_WRITE > ' + quote(mode === 'write-allowed' ? approved : denied), description: 'Owned agent effect' } : { [native ? 'file_path' : 'filePath']: readPath }
            send(name, input, (native ? 'toolu_agent_' : 'call_agent_') + index); return
          }
          send(native ? 'StructuredOutput' : 'harness_hook_verdict', mode === 'invalid' ? { ok: 'wrong' } : mode === 'deny' ? { ok: false, reason: 'OWNED_AGENT_DENIAL' } : { ok: true }, (native ? 'toolu_agent_' : 'call_agent_') + index); return
        }
        state.callerInstructionObserved ||= JSON.stringify(body).includes(CALLER_RULE)
        state.parentCalls++; ensure(state.parentCalls <= 2, 'GATEWAY_PARENT_LIMIT')
        if (state.parentCalls === 1) send(native ? 'Bash' : 'bash', { command: 'printf OWNED_PARENT_EFFECT > ' + quote(marker), description: 'Owned parent effect' }, native ? 'toolu_parent_effect' : 'call_parent_effect')
        else send()
      } catch (error) { errors.push(error instanceof ConformanceError ? error.message : 'GATEWAY_INVALID_REQUEST'); if (!response.headersSent) response.writeHead(500); response.end('{}') }
    })
    await new Promise((resolve, reject) => { gateway.once('error', reject); gateway.listen(0, '127.0.0.1', resolve) })
    const address = 'http://127.0.0.1:' + gateway.address().port
    const prepare = async () => { await Promise.all([trace, marker, denied, approved].map(path => rm(path, { force: true }))) }
    const observe = async (backend, mode, done, childRemoved = true) => {
      const state = traffic.get(backend + ':' + mode)
      const text = await readFile(trace, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error }); ensure(Buffer.byteLength(text) <= MAX_BYTES, 'TRACE_LIMIT')
      const rows = text.trim() ? text.trim().split('\n').map(line => JSON.parse(line)) : [], initial = rows.find(row => row.payload.hook_event_name === 'UserPromptSubmit'), parent = rows.find(row => row.payload.tool_use_id?.endsWith('_parent_effect'))
      const exists = async path => { try { await access(path); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error } }
      return { mode, ...state, sideEffect: await exists(marker), evaluatorWrite: await exists(denied) || await exists(approved), done, childRemoved, artifacts: parent?.artifacts ?? [], tools: rows.filter(row => row.payload.tool_use_id?.startsWith('toolu_agent_') || row.payload.tool_use_id?.startsWith('call_agent_')).map(row => ({ event: row.payload.hook_event_name, tool: row.payload.tool_name, callID: row.payload.tool_use_id, parentIdentity: !!initial && row.payload.session_id === initial.payload.session_id, permissionMode: row.payload.permission_mode, transcriptExists: row.exists })), parentContext: parent ? { permissionMode: parent.payload.permission_mode, transcriptExists: parent.exists, evaluatorIDsAbsent: parent.evaluatorIDsAbsent } : null }
    }
    const nativeControls = [], hostControls = []
    for (const mode of CASES) {
      stage = 'native-' + mode; await prepare()
      const source = join(root, 'hooks-' + (mode === 'timeout' ? 1 : 60) + '.json')
      const result = await runNativeProcess(nativeBinary, ['-p', '--output-format', 'json', '--setting-sources', '', '--strict-mcp-config', '--mcp-config', mcp, '--settings', source, '--dangerously-skip-permissions', '--append-system-prompt', CALLER_RULE, '--max-turns', '3', '--model', MODEL], 'AGENT_MODEL_CASE:' + mode, project, { ...environment(nativeHome, project), CLAUDE_CONFIG_DIR: nativeConfig, ANTHROPIC_API_KEY: 'synthetic', ANTHROPIC_BASE_URL: address + '/native' }, { durationMs: REQUEST_MS, graceMs: 1000, maxBytes: MAX_BYTES })
      const output = JSON.parse(result.stdout); nativeControls.push(await observe('native', mode, output.is_error === false && typeof output.result === 'string' && output.result.includes(DONE)))
    }
    const password = 'synthetic-agent-conformance'
    for (const group of [CASES.filter(mode => mode !== 'timeout'), ['timeout']]) {
      const source = join(root, 'hooks-' + (group[0] === 'timeout' ? 1 : 60) + '.json'), options = { sources: [{ id: 'native', dialect: 'claude-code', path: source }], reviewedDigests: { native: sourceDigests.get(source) }, permissionMode: 'bypassPermissions', modelAliases: { [MODEL]: 'fixture/fixture' } }
      await writeFile(join(hostConfig, 'opencode.json'), JSON.stringify({ model: 'fixture/fixture', small_model: 'fixture/fixture', snapshot: false, share: 'disabled', autoupdate: false, permission: 'allow', agent: { build: { prompt: CALLER_RULE } }, plugin: [[pathToFileURL(entrypoint).href, options]], provider: { fixture: { npm: '@ai-sdk/openai-compatible', options: { apiKey: 'synthetic', baseURL: address + '/host/v1' }, models: { fixture: { name: 'Agent conformance', limit: { context: 100000, output: 2000 } } } } } }))
      stage = 'host-start'
      child = spawn(opencodeBinary, ['--print-logs', 'serve', '--hostname', '127.0.0.1', '--port', String(await availablePort())], { cwd: project, env: { ...environment(hostHome, project), OPENCODE_CONFIG_DIR: hostConfig, OPENCODE_DISABLE_CLAUDE_CODE: '1', OPENCODE_DISABLE_DEFAULT_PLUGINS: '1', OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_EXTERNAL_SKILLS: '1', OPENCODE_SERVER_PASSWORD: password }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
      closed = new Promise(resolve => child.once('close', resolve))
      child.stderr.on('data', chunk => { for (const code of String(chunk).match(/\b(?:HOST|TRANSCRIPT|SESSION_STORE|MODEL|SOURCE|PLUGIN|AGENT)_[A-Z_]+\b/g) ?? []) codes.add(code) })
      const hostAddress = await Promise.race([new Promise((resolve, reject) => { let text = ''; child.once('error', () => reject(new ConformanceError('HOST_START_FAILED'))); child.once('close', () => reject(new ConformanceError('HOST_START_EXITED'))); child.stdout.on('data', chunk => { text = (text + String(chunk)).slice(-MAX_BYTES); const found = /http:\/\/127\.0\.0\.1:\d+/.exec(text)?.[0]; if (found) resolve(found) }) }), new Promise((_, reject) => { timer = setTimeout(() => reject(new ConformanceError('HOST_START_TIMEOUT')), START_MS) })])
      clearTimeout(timer); await initializeHost(hostAddress, project, password)
      const request = async (method, path, body) => { const response = await fetch(hostAddress + path + '?directory=' + encodeURIComponent(project), { method, headers: { 'content-type': 'application/json', authorization: 'Basic ' + Buffer.from('opencode:' + password).toString('base64') }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(REQUEST_MS) }); return { ok: response.ok, data: await response.json() } }
      for (const mode of group) {
        stage = 'host-' + mode; await prepare()
        const session = await request('POST', '/session', {}); ensure(session.ok && typeof session.data?.id === 'string', 'HOST_CREATE_FAILED')
        const result = await request('POST', '/session/' + session.data.id + '/message', { model: { providerID: 'fixture', modelID: 'fixture' }, parts: [{ type: 'text', text: 'AGENT_MODEL_CASE:' + mode }] })
        const children = await request('GET', '/session/' + session.data.id + '/children')
        hostControls.push(await observe('host', mode, result.ok && Array.isArray(result.data?.parts) && result.data.parts.some(part => part.type === 'text' && part.text.includes(DONE)), children.ok && Array.isArray(children.data) && children.data.length === 0))
        await request('DELETE', '/session/' + session.data.id)
      }
      await stopHost(child, closed); child = undefined; closed = undefined
    }
    ensure(!errors.length, 'GATEWAY_FAILED: ' + [...new Set(errors)].join(','))
    for (const [path, expected] of sourceDigests) ensure(digest(await readFile(path)) === expected, 'CONFORMANCE_SOURCE_CHANGED')
    ensure(digest(await readFile(recorder)) === digest(recorderText), 'CONFORMANCE_HOOK_CHANGED')
    ensure(await fingerprintAdapter(packageRoot) === adapterBuildSha256, 'CONFORMANCE_BUILD_CHANGED')
    return { caseID: 'claude.userpromptsubmit.agent-model', host: 'v1', nativeVersion, hostVersion, adapterBuildSha256, ...compareAgentModelEvidence(nativeControls, hostControls), platform: process.platform, architecture: process.arch, diagnostics: [...codes].sort(), isolation: { temporaryHomeAndConfig: true, loopbackProvider: true, sourceBytesUnchanged: true, nativeTrustVerified: false, nativePermissionBypass: true, machineManagedSettingsMayRemain: true }, limits: ['Agent UserPromptSubmit and named nested tool controls only', 'Explicit model alias and synthetic providers do not establish real-model or cross-provider equivalence', 'Broader shell classification, permission precedence, rendering, other events, V2 and native trust remain unverified'] }
  } catch (error) {
    if (error instanceof ConformanceError) throw error
    const code = typeof error?.code === 'string' && /^[A-Z][A-Z_0-9]{1,47}$/.test(error.code) ? error.code : 'UNKNOWN'
    throw new ConformanceError('CONFORMANCE_AGENT_MODEL_FAILED: ' + stage + ' system=' + code + ' codes=' + [...codes].sort().join(','))
  } finally {
    clearTimeout(timer)
    try { await stopHost(child, closed) } finally { try { if (gateway) { gateway.closeAllConnections(); await new Promise(resolve => gateway.close(resolve)) } } finally { await rm(root, { recursive: true, force: true }) } }
  }
}
