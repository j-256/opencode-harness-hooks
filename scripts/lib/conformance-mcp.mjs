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

const CASES = Object.freeze(['allow', 'deny', 'error', 'multiple', 'empty', 'invalid', 'timeout'])
const MODEL = 'claude-sonnet-4-6'
const DONE = 'OWNED_MCP_COMPARISON_COMPLETE'
const DENIAL = 'OWNED_MCP_DENIAL'
const ARGUMENT = 'OWNED_MCP_ARGUMENT'
const MAX_BYTES = 2 * 1024 * 1024
const MAX_REQUESTS = 100
const REQUEST_MS = 30000
const START_MS = 15000
const quote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'"
const digest = value => createHash('sha256').update(value).digest('hex')
function ensure(value, code) { if (!value) throw new ConformanceError(code) }
function valid(row) {
  const denied = ['deny', 'multiple'].includes(row?.mode)
  return !!row && CASES.includes(row.mode) && row.done === true && row.parentCalls === 2 && row.sideEffect === !denied && row.hookCalls === 1 && row.exactArguments === true && row.feedback === denied && row.noRecursion === true && row.parentIdentity === true && row.transcriptIsolated === true && row.childRemoved === true && row.internalNetwork === 0 && row.before === 1 && row.after === (denied ? 0 : 1)
}
export function compareMcpEvidence(native, host) {
  const complete = rows => Array.isArray(rows) && rows.length === CASES.length && new Set(rows.map(row => row.mode)).size === CASES.length && rows.every(valid)
  const match = complete(native) && complete(host)
  return { status: match ? 'passed' : 'failed', comparison: { match, native, host, ...(!match ? { failure: 'CONFORMANCE_MCP_MISMATCH' } : {}) } }
}
function anthropic(response, body, content) {
  const invoke = content.some(part => part.type === 'tool_use')
  const message = { id: 'msg_mcp_comparison', type: 'message', role: 'assistant', model: body.model, content, stop_reason: invoke ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }
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
function chat(response, name, input, text = DONE) {
  const chunk = (delta, finish) => ({ id: 'chatcmpl_mcp_comparison', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason: finish }] })
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  const delta = name ? { tool_calls: [{ index: 0, id: 'call_parent_mcp', type: 'function', function: { name, arguments: JSON.stringify(input) } }] } : { content: text }
  response.end('data: ' + JSON.stringify(chunk({ role: 'assistant', ...delta }, null)) + '\n\ndata: ' + JSON.stringify({ ...chunk({}, name ? 'tool_calls' : 'stop'), usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }) + '\n\ndata: [DONE]\n\n')
}
function environment(home, project) {
  return { PATH: process.env.PATH, HOME: home, PWD: project, SHELL: '/bin/sh', LANG: 'C', TMPDIR: join(home, 'tmp'), XDG_CONFIG_HOME: join(home, 'config'), XDG_STATE_HOME: join(home, 'state'), XDG_DATA_HOME: join(home, 'data'), XDG_CACHE_HOME: join(home, 'cache'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_NON_ESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1' }
}
async function availablePort() { const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port }

export async function runMcpComparison({ catalog, packageRoot, nativeBinary, opencodeBinary }) {
  if (process.platform === 'win32') throw new ConformanceError('PLATFORM_UNAVAILABLE: POSIX process groups', 2)
  const nativeVersion = await verifyPinnedVersion(nativeBinary, 'claude', catalog.versions.native['claude-code'])
  const hostVersion = await verifyPinnedVersion(opencodeBinary, 'opencode', catalog.versions.hosts.v1)
  const entrypoint = join(packageRoot, 'dist/index.js')
  try { await access(entrypoint) } catch { throw new ConformanceError('DEPENDENCY_UNAVAILABLE: built adapter', 3) }
  const adapterBuildSha256 = await fingerprintAdapter(packageRoot), root = await realpath(await mkdtemp(join(tmpdir(), 'mcp-conformance-')))
  let gateway, child, closed, timer, stage = 'setup', requests = 0
  const traffic = new Map(), errors = [], codes = new Set(), sourceDigests = new Map()
  try {
    const project = join(root, 'project'), nativeHome = join(root, 'native-home'), hostHome = join(root, 'host-home'), nativeConfig = join(nativeHome, 'native'), hostConfig = join(hostHome, 'config/opencode')
    await Promise.all([mkdir(project), mkdir(nativeConfig, { recursive: true }), mkdir(hostConfig, { recursive: true }), mkdir(join(nativeHome, 'tmp'), { recursive: true }), mkdir(join(hostHome, 'tmp'), { recursive: true })])
    const recorder = join(root, 'record.cjs'), trace = join(root, 'trace.jsonl'), calls = join(root, 'calls.jsonl'), marker = join(project, 'parent.marker'), mcp = join(root, 'mcp.json'), server = join(root, 'server.cjs')
    const commandFor = mode => 'printf ' + quote('MCP_CASE:' + mode) + ' > ' + quote(marker)
    const recorderText = `const fs=require('node:fs');const p=JSON.parse(fs.readFileSync(0,'utf8'));const text=typeof p.transcript_path==='string'&&fs.existsSync(p.transcript_path)?fs.readFileSync(p.transcript_path,'utf8'):'';if(Buffer.byteLength(text)>${MAX_BYTES})process.exit(1);fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify({event:p.hook_event_name,tool:p.tool_name,sessionID:p.session_id,callID:p.tool_use_id,permission:p.permission_mode,transcriptIsolated:!text.includes('call_mcp_')&&!text.includes('opencode-harness-hooks-mcp')})+'\\n');`
    const deniedText = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: DENIAL } })
    const serverText = `const fs=require('node:fs');const readline=require('node:readline');readline.createInterface({input:process.stdin}).on('line',line=>{const p=JSON.parse(line);if(p.id===undefined)return;let result;if(p.method==='initialize')result={protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'Fixture',version:'1.0.0'}};else if(p.method==='tools/list')result={tools:[{name:'check',description:'Owned fixture',inputSchema:{type:'object',properties:{value:{type:'string'},command:{type:'string'}},required:['value','command']}}]};else if(p.method==='tools/call'){fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(p.params)+'\\n');const mode=/MCP_CASE:([a-z]+)/.exec(p.params.arguments.command)?.[1];const deny=${JSON.stringify(deniedText)};result=mode==='error'?{isError:true,content:[{type:'text',text:deny}]}:mode==='empty'?{content:[]}:mode==='invalid'?{content:[{type:'text',text:'{invalid'}]}:mode==='multiple'?{content:[{type:'text',text:deny.slice(0,1)},{type:'text',text:deny.slice(1)}]}:{content:[{type:'text',text:mode==='deny'?deny:'{}'}]};if(mode==='timeout'){setTimeout(()=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:p.id,result:{content:[{type:'text',text:deny}]}})+'\\n'),3500);return}}else result={};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:p.id,result})+'\\n')})`
    const command = { type: 'command', command: [process.execPath, recorder].map(quote).join(' '), timeout: 5 }
    for (const timeout of [10, 1]) {
      const text = JSON.stringify({ hooks: { PreToolUse: [{ hooks: [command] }, { matcher: 'Bash', hooks: [{ type: 'mcp_tool', server: 'fixture', tool: 'check', input: { value: ARGUMENT, command: '${tool_input.command}' }, timeout }] }], PostToolUse: [{ hooks: [command] }] } })
      const path = join(root, 'hooks-' + timeout + '.json'); await writeFile(path, text); sourceDigests.set(path, digest(text))
    }
    await Promise.all([writeFile(recorder, recorderText), writeFile(server, serverText), writeFile(mcp, JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: [server] } } }))])
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
        const tools = body.tools?.map(tool => native ? tool.name : tool.function?.name) ?? [], messages = JSON.stringify(body.messages)
        const mode = CASES.find(value => messages.includes('MCP_CASE:' + value)), parent = !!mode && tools.includes(native ? 'Bash' : 'bash')
        const send = (name, input) => native ? anthropic(response, body, name ? [{ type: 'tool_use', name, input, id: 'toolu_parent_mcp' }] : [{ type: 'text', text: DONE }]) : chat(response, name, input)
        if (!parent) { ensure(!messages.includes('Execute the reviewed MCP call'), 'GATEWAY_INTERNAL_MCP_REQUEST'); send(); return }
        const key = (native ? 'native:' : 'host:') + mode, state = traffic.get(key) ?? { parentCalls: 0, feedback: false, internalNetwork: 0 }
        traffic.set(key, state); state.feedback ||= messages.includes(DENIAL); ensure(++state.parentCalls <= 2, 'GATEWAY_PARENT_LIMIT')
        if (state.parentCalls === 1) send(native ? 'Bash' : 'bash', { command: commandFor(mode), description: 'Owned MCP parent effect' }); else send()
      } catch (error) { errors.push(error instanceof ConformanceError ? error.message : 'GATEWAY_INVALID_REQUEST'); if (!response.headersSent) response.writeHead(500); response.end('{}') }
    })
    await new Promise((resolve, reject) => { gateway.once('error', reject); gateway.listen(0, '127.0.0.1', resolve) })
    const address = 'http://127.0.0.1:' + gateway.address().port
    const prepare = async () => { await Promise.all([trace, calls, marker].map(path => rm(path, { force: true }))) }
    const readRows = async path => { const text = await readFile(path, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error }); ensure(Buffer.byteLength(text) <= MAX_BYTES, 'TRACE_LIMIT'); return text.trim() ? text.trim().split('\n').map(line => JSON.parse(line)) : [] }
    const observe = async (backend, mode, done, childRemoved = true) => {
      const rows = await readRows(trace), invocations = await readRows(calls), before = rows.filter(row => row.event === 'PreToolUse'), after = rows.filter(row => row.event === 'PostToolUse')
      let sideEffect = false; try { sideEffect = await readFile(marker, 'utf8') === 'MCP_CASE:' + mode } catch (error) { if (error.code !== 'ENOENT') throw error }
      return { mode, ...traffic.get(backend + ':' + mode), done, sideEffect, hookCalls: invocations.length, exactArguments: invocations.length === 1 && invocations[0].name === 'check' && JSON.stringify(invocations[0].arguments) === JSON.stringify({ value: ARGUMENT, command: commandFor(mode) }), noRecursion: rows.every(row => row.tool === 'Bash'), parentIdentity: before.length === 1 && rows.every(row => row.sessionID === before[0].sessionID && row.callID === before[0].callID && row.permission === 'bypassPermissions'), transcriptIsolated: rows.every(row => row.transcriptIsolated === true), childRemoved, before: before.length, after: after.length }
    }
    const nativeControls = [], hostControls = []
    for (const mode of CASES) {
      stage = 'native-' + mode; await prepare()
      const source = join(root, 'hooks-' + (mode === 'timeout' ? 1 : 10) + '.json')
      const result = await runNativeProcess(nativeBinary, ['-p', '--output-format', 'json', '--setting-sources', '', '--strict-mcp-config', '--mcp-config', mcp, '--settings', source, '--tools', 'Bash', '--dangerously-skip-permissions', '--max-turns', '3', '--model', MODEL], 'MCP_CASE:' + mode, project, { ...environment(nativeHome, project), CLAUDE_CONFIG_DIR: nativeConfig, ANTHROPIC_API_KEY: 'synthetic', ANTHROPIC_BASE_URL: address + '/native' }, { durationMs: REQUEST_MS, graceMs: 1000, maxBytes: MAX_BYTES })
      const output = JSON.parse(result.stdout); nativeControls.push(await observe('native', mode, output.is_error === false && typeof output.result === 'string' && output.result.includes(DONE)))
    }
    const password = 'synthetic-mcp-conformance'
    for (const group of [CASES.filter(mode => mode !== 'timeout'), ['timeout']]) {
      const source = join(root, 'hooks-' + (group[0] === 'timeout' ? 1 : 10) + '.json'), options = { sources: [{ id: 'native', dialect: 'claude-code', path: source }], reviewedDigests: { native: sourceDigests.get(source) }, permissionMode: 'bypassPermissions' }
      await writeFile(join(hostConfig, 'opencode.json'), JSON.stringify({ model: 'fixture/fixture', small_model: 'fixture/fixture', enabled_providers: ['fixture'], snapshot: false, share: 'disabled', autoupdate: false, permission: 'allow', mcp: { fixture: { type: 'local', command: [process.execPath, server], enabled: true } }, plugin: [[pathToFileURL(entrypoint).href, options]], provider: { fixture: { npm: '@ai-sdk/openai-compatible', options: { apiKey: 'synthetic', baseURL: address + '/host/v1' }, models: { fixture: { name: 'MCP conformance', limit: { context: 100000, output: 2000 } } } } } }))
      stage = 'host-start'
      child = spawn(opencodeBinary, ['--print-logs', 'serve', '--hostname', '127.0.0.1', '--port', String(await availablePort())], { cwd: project, env: { ...environment(hostHome, project), OPENCODE_CONFIG_DIR: hostConfig, OPENCODE_DISABLE_CLAUDE_CODE: '1', OPENCODE_DISABLE_DEFAULT_PLUGINS: '1', OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_EXTERNAL_SKILLS: '1', OPENCODE_SERVER_PASSWORD: password }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
      closed = new Promise(resolve => child.once('close', resolve))
      child.stderr.on('data', chunk => { for (const code of String(chunk).match(/\b(?:HOST|TRANSCRIPT|SESSION_STORE|MODEL|SOURCE|PLUGIN|MCP)_[A-Z_]+\b/g) ?? []) codes.add(code) })
      const hostAddress = await Promise.race([new Promise((resolve, reject) => { let text = ''; child.once('error', () => reject(new ConformanceError('HOST_START_FAILED'))); child.once('close', () => reject(new ConformanceError('HOST_START_EXITED'))); child.stdout.on('data', chunk => { text = (text + String(chunk)).slice(-MAX_BYTES); const found = /http:\/\/127\.0\.0\.1:\d+/.exec(text)?.[0]; if (found) resolve(found) }) }), new Promise((_, reject) => { timer = setTimeout(() => reject(new ConformanceError('HOST_START_TIMEOUT')), START_MS) })])
      clearTimeout(timer); await initializeHost(hostAddress, project, password)
      const request = async (method, path, body) => { const response = await fetch(hostAddress + path + '?directory=' + encodeURIComponent(project), { method, headers: { 'content-type': 'application/json', authorization: 'Basic ' + Buffer.from('opencode:' + password).toString('base64') }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(REQUEST_MS) }); return { ok: response.ok, data: await response.json() } }
      for (const mode of group) {
        stage = 'host-' + mode; await prepare()
        const session = await request('POST', '/session', {}); ensure(session.ok && typeof session.data?.id === 'string', 'HOST_CREATE_FAILED')
        const result = await request('POST', '/session/' + session.data.id + '/message', { model: { providerID: 'fixture', modelID: 'fixture' }, parts: [{ type: 'text', text: 'MCP_CASE:' + mode }] })
        let children = await request('GET', '/session/' + session.data.id + '/children')
        const deadline = performance.now() + 5000
        while (children.ok && Array.isArray(children.data) && children.data.length && performance.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 100)); children = await request('GET', '/session/' + session.data.id + '/children') }
        hostControls.push(await observe('host', mode, result.ok && Array.isArray(result.data?.parts) && result.data.parts.some(part => part.type === 'text' && part.text.includes(DONE)), children.ok && Array.isArray(children.data) && children.data.length === 0))
        await request('DELETE', '/session/' + session.data.id)
      }
      stage = 'host-stop'
      await stopHost(child, closed); child = undefined; closed = undefined
    }
    stage = 'integrity'
    ensure(!errors.length, 'GATEWAY_FAILED: ' + [...new Set(errors)].join(','))
    for (const [path, expected] of sourceDigests) ensure(digest(await readFile(path)) === expected, 'CONFORMANCE_SOURCE_CHANGED')
    ensure(digest(await readFile(recorder)) === digest(recorderText) && digest(await readFile(server)) === digest(serverText), 'CONFORMANCE_HOOK_CHANGED')
    ensure(await fingerprintAdapter(packageRoot) === adapterBuildSha256, 'CONFORMANCE_BUILD_CHANGED')
    return { caseID: 'claude.pretooluse.mcp', host: 'v1', nativeVersion, hostVersion, adapterBuildSha256, ...compareMcpEvidence(nativeControls, hostControls), platform: process.platform, architecture: process.arch, diagnostics: [...codes].sort(), isolation: { temporaryHomeAndConfig: true, loopbackProvider: true, sourceBytesUnchanged: true, nativeTrustVerified: false, nativePermissionBypass: true, machineManagedSettingsMayRemain: true }, limits: ['Claude PreToolUse configured local MCP text controls only', 'No real model account is used; raw identity, structured-output and native metadata incompatibilities remain explicit', 'Connection/authentication/elicitation, rendering, other events, V2 and native trust need separate proof'] }
  } catch (error) {
    if (error instanceof ConformanceError) throw error
    const code = typeof error?.code === 'string' && /^[A-Z][A-Z_0-9]{1,47}$/.test(error.code) ? error.code : 'UNKNOWN'
    throw new ConformanceError('CONFORMANCE_MCP_FAILED: ' + stage + ' system=' + code + ' codes=' + [...codes].sort().join(','))
  } finally {
    clearTimeout(timer)
    try { await stopHost(child, closed) } finally { try { if (gateway) { gateway.closeAllConnections(); await new Promise(resolve => gateway.close(resolve)) } } finally { await rm(root, { recursive: true, force: true }) } }
  }
}
