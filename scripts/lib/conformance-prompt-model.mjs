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

const CASES = Object.freeze(['allow', 'deny', 'invalid', 'timeout'])
const MODEL = 'claude-sonnet-4-6'
const HOOK = 'OWNED_HOOK_CONDITION'
const PROMPT = HOOK + ' $ARGUMENTS'
const DONE = 'OWNED_PROMPT_MODEL_COMPLETE'
const INVALID = 'MALFORMED_DECISION'
const MAX_BYTES = 2 * 1024 * 1024
const MAX_REQUESTS = 64
const REQUEST_MS = 30000
const START_MS = 15000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const quote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'"
const digest = value => createHash('sha256').update(value).digest('hex')
function ensure(value, code) { if (!value) throw new ConformanceError(code) }

function valid(row, prompt) {
  if (!row || !CASES.includes(row.mode) || row.hookCalls !== 1 || row.parentCalls !== (row.mode === 'deny' ? 0 : 2) || row.sideEffect !== (row.mode !== 'deny') || row.done !== (row.mode !== 'deny') || row.isolated !== true || row.inputRetained !== true || row.childRemoved !== true || !Array.isArray(row.artifacts)) return false
  if (row.mode !== 'invalid') return row.artifacts.length === 0
  const item = row.artifacts[0]
  return row.artifacts.length === 1 && item?.type === 'hook_non_blocking_error' && item.hookName === 'UserPromptSubmit' && item.hookEvent === 'UserPromptSubmit' && typeof item.toolUseID === 'string' && UUID.test(item.toolUseID) && item.stdout === INVALID && item.stderr === 'JSON validation failed' && item.exitCode === 1 && item.command === prompt && Number.isFinite(item.durationMs) && item.durationMs >= 0
}
export function comparePromptModelEvidence(native, host, prompt = PROMPT) {
  const complete = rows => Array.isArray(rows) && rows.length === CASES.length && new Set(rows.map(row => row.mode)).size === CASES.length && rows.every(row => valid(row, prompt))
  const match = complete(native) && complete(host)
  return { status: match ? 'passed' : 'failed', comparison: { match, native, host, ...(!match ? { failure: 'CONFORMANCE_PROMPT_MODEL_MISMATCH' } : {}) } }
}

function anthropic(response, body, content, invoke) {
  const message = { id: 'msg_owned_model', type: 'message', role: 'assistant', model: body.model, content, stop_reason: invoke ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }
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
function chat(response, delta, invoke) {
  const chunk = (data, finish) => ({ id: 'chatcmpl_owned_model', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: data, finish_reason: finish }] })
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  response.end('data: ' + JSON.stringify(chunk({ role: 'assistant', ...delta }, null)) + '\n\ndata: ' + JSON.stringify({ ...chunk({}, invoke ? 'tool_calls' : 'stop'), usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }) + '\n\ndata: [DONE]\n\n')
}
function environment(home, project) {
  return { PATH: process.env.PATH, HOME: home, PWD: project, SHELL: '/bin/sh', LANG: 'C', TMPDIR: join(home, 'tmp'), XDG_CONFIG_HOME: join(home, 'config'), XDG_STATE_HOME: join(home, 'state'), XDG_DATA_HOME: join(home, 'data'), XDG_CACHE_HOME: join(home, 'cache'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_NON_ESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1' }
}

export async function runPromptModelComparison({ catalog, packageRoot, nativeBinary, opencodeBinary }) {
  if (process.platform === 'win32') throw new ConformanceError('PLATFORM_UNAVAILABLE: POSIX process groups', 2)
  const nativeVersion = await verifyPinnedVersion(nativeBinary, 'claude', catalog.versions.native['claude-code'])
  const hostVersion = await verifyPinnedVersion(opencodeBinary, 'opencode', catalog.versions.hosts.v1)
  const entrypoint = join(packageRoot, 'dist/index.js')
  try { await access(entrypoint) } catch { throw new ConformanceError('DEPENDENCY_UNAVAILABLE: built adapter', 3) }
  const adapterBuildSha256 = await fingerprintAdapter(packageRoot), root = await realpath(await mkdtemp(join(tmpdir(), 'prompt-model-conformance-')))
  let gateway, child, closed, stage = 'setup', timer, requests = 0
  const traffic = new Map(), errors = [], codes = new Set()
  try {
    const project = join(root, 'project'), nativeHome = join(root, 'native-home'), hostHome = join(root, 'host-home'), nativeConfig = join(nativeHome, 'native'), hostConfig = join(hostHome, 'config/opencode')
    await Promise.all([mkdir(project), mkdir(nativeConfig, { recursive: true }), mkdir(hostConfig, { recursive: true }), mkdir(join(nativeHome, 'tmp'), { recursive: true }), mkdir(join(hostHome, 'tmp'), { recursive: true })])
    const source = join(root, 'hooks.json'), recorder = join(root, 'record.cjs'), trace = join(root, 'trace.json'), marker = join(project, 'owned.marker'), mcp = join(root, 'mcp.json')
    const recorderText = `const fs=require('node:fs');const p=JSON.parse(fs.readFileSync(0,'utf8'));const text=fs.readFileSync(p.transcript_path,'utf8');if(Buffer.byteLength(text)>${MAX_BYTES})process.exit(1);const rows=text.trim().split('\\n').map(line=>JSON.parse(line));fs.writeFileSync(${JSON.stringify(trace)},JSON.stringify(rows.filter(row=>row.type==='attachment'&&row.attachment?.hookEvent==='UserPromptSubmit').map(row=>row.attachment)));`
    const sourceText = JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'prompt', prompt: PROMPT, model: MODEL, timeout: 2 }] }], PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: [process.execPath, recorder].map(quote).join(' '), timeout: 5 }] }] } })
    await Promise.all([writeFile(source, sourceText), writeFile(recorder, recorderText), writeFile(mcp, '{"mcpServers":{}}'), writeFile(join(project, 'AGENTS.md'), 'UNRELATED_PROJECT_MODEL_INSTRUCTION\n')])
    const sourceDigest = digest(sourceText), hookDigest = digest(recorderText)
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
        const evaluator = native ? !!body.output_config?.format && tools.length === 0 : tools.length === 1 && tools[0] === 'StructuredOutput'
        const parent = tools.includes(native ? 'Bash' : 'bash')
        const mode = CASES.find(value => messages.includes('PROMPT_MODEL_CASE:' + value))
        if (!mode || !evaluator && !parent) { if (native) anthropic(response, body, [{ type: 'text', text: DONE }], false); else chat(response, { content: DONE }, false); return }
        const backend = native ? 'native' : 'host', key = backend + ':' + mode, state = traffic.get(key) ?? { hookCalls: 0, parentCalls: 0, isolated: true, inputRetained: true }
        traffic.set(key, state)
        if (evaluator) {
          state.hookCalls++
          state.inputRetained &&= messages.includes(HOOK) && messages.includes('hook_event_name') && messages.includes('UserPromptSubmit') && messages.includes('PROMPT_MODEL_CASE:' + mode)
          state.isolated &&= !JSON.stringify(body.system ?? body.messages.filter(row => row.role === 'system' || row.role === 'developer')).includes('UNRELATED_PROJECT_MODEL_INSTRUCTION')
          ensure(body.model === (native ? MODEL : 'fixture'), 'GATEWAY_MODEL_SELECTION_INVALID')
          if (mode === 'timeout') return
          const text = mode === 'invalid' ? INVALID : JSON.stringify(mode === 'deny' ? { ok: false, reason: 'OWNED_PROMPT_MODEL_DENIAL' } : { ok: true })
          if (native) anthropic(response, body, [{ type: 'text', text }], false)
          else if (mode === 'invalid') chat(response, { content: text }, false)
          else chat(response, { tool_calls: [{ index: 0, id: 'call_owned_model', type: 'function', function: { name: 'StructuredOutput', arguments: text } }] }, true)
          return
        }
        state.parentCalls++
        ensure(state.parentCalls <= 2, 'GATEWAY_PARENT_LIMIT')
        const invoke = state.parentCalls === 1, input = { command: 'printf OWNED_MODEL_SIDE_EFFECT > ' + quote(marker), description: 'Owned prompt hook conformance effect' }
        if (native) anthropic(response, body, invoke ? [{ type: 'tool_use', id: 'toolu_owned_model_parent', name: 'Bash', input }] : [{ type: 'text', text: DONE }], invoke)
        else chat(response, invoke ? { tool_calls: [{ index: 0, id: 'call_owned_model_parent', type: 'function', function: { name: 'bash', arguments: JSON.stringify(input) } }] } : { content: DONE }, invoke)
      } catch (error) { errors.push(error instanceof ConformanceError ? error.message : 'GATEWAY_INVALID_REQUEST'); if (!response.headersSent) response.writeHead(500); response.end('{}') }
    })
    await new Promise((resolve, reject) => { gateway.once('error', reject); gateway.listen(0, '127.0.0.1', resolve) })
    const address = 'http://127.0.0.1:' + gateway.address().port
    const prepare = async () => { await Promise.all([rm(trace, { force: true }), rm(marker, { force: true })]) }
    const observe = async (backend, mode, done, childRemoved = true) => {
      const state = traffic.get(backend + ':' + mode)
      let sideEffect = false, artifacts = []
      try { sideEffect = await readFile(marker, 'utf8') === 'OWNED_MODEL_SIDE_EFFECT' } catch (error) { if (error.code !== 'ENOENT') throw error }
      try { artifacts = JSON.parse(await readFile(trace, 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error }
      return { mode, ...state, sideEffect, artifacts, done, childRemoved }
    }
    const nativeControls = [], hostControls = []
    for (const mode of CASES) {
      stage = 'native-' + mode; await prepare()
      const result = await runNativeProcess(nativeBinary, ['-p', '--output-format', 'json', '--setting-sources', '', '--strict-mcp-config', '--mcp-config', mcp, '--settings', source, '--tools', 'Bash', '--dangerously-skip-permissions', '--max-turns', '3', '--model', MODEL], 'PROMPT_MODEL_CASE:' + mode, project, { ...environment(nativeHome, project), CLAUDE_CONFIG_DIR: nativeConfig, ANTHROPIC_API_KEY: 'synthetic', ANTHROPIC_BASE_URL: address + '/native' })
      const output = JSON.parse(result.stdout)
      nativeControls.push(await observe('native', mode, output.is_error === false && typeof output.result === 'string' && output.result.includes(DONE)))
    }
    const options = { sources: [{ id: 'native', dialect: 'claude-code', path: source }], reviewedDigests: { native: sourceDigest }, permissionMode: 'bypassPermissions', modelAliases: { [MODEL]: 'fixture/fixture' } }
    await writeFile(join(hostConfig, 'opencode.json'), JSON.stringify({ model: 'fixture/fixture', small_model: 'fixture/fixture', snapshot: false, share: 'disabled', autoupdate: false, permission: 'allow', plugin: [[pathToFileURL(entrypoint).href, options]], provider: { fixture: { npm: '@ai-sdk/openai-compatible', options: { apiKey: 'synthetic', baseURL: address + '/host/v1' }, models: { fixture: { name: 'Prompt conformance', limit: { context: 50000, output: 2000 } } } } } }))
    stage = 'host-start'
    const password = 'synthetic-model-conformance'
    child = spawn(opencodeBinary, ['--print-logs', 'serve', '--hostname', '127.0.0.1', '--port', '0'], { cwd: project, env: { ...environment(hostHome, project), OPENCODE_CONFIG_DIR: hostConfig, OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_CLAUDE_CODE: '1', OPENCODE_DISABLE_DEFAULT_PLUGINS: '1', OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_EXTERNAL_SKILLS: '1', OPENCODE_PASSWORD: password }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    closed = new Promise(resolve => child.once('close', resolve))
    child.stderr.on('data', chunk => { for (const code of String(chunk).match(/\b(?:HOST|TRANSCRIPT|SESSION_STORE|MODEL|SOURCE|PLUGIN)_[A-Z_]+\b/g) ?? []) codes.add(code) })
    const hostAddress = await Promise.race([new Promise((resolve, reject) => { let text = ''; child.once('error', () => reject(new ConformanceError('HOST_START_FAILED'))); child.once('close', () => reject(new ConformanceError('HOST_START_EXITED'))); child.stdout.on('data', chunk => { text = (text + String(chunk)).slice(-MAX_BYTES); const found = /http:\/\/127\.0\.0\.1:\d+/.exec(text)?.[0]; if (found) resolve(found) }) }), new Promise((_, reject) => { timer = setTimeout(() => reject(new ConformanceError('HOST_START_TIMEOUT')), START_MS) })])
    clearTimeout(timer)
    const hostInitializationMs = await initializeHost(hostAddress, project, password)
    const request = async (method, path, body) => {
      const response = await fetch(hostAddress + path + '?directory=' + encodeURIComponent(project), { method, headers: { 'content-type': 'application/json', authorization: 'Basic ' + Buffer.from('opencode:' + password).toString('base64') }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(REQUEST_MS) })
      const data = await response.json()
      return { ok: response.ok, data }
    }
    for (const mode of CASES) {
      stage = 'host-' + mode; await prepare()
      const session = await request('POST', '/session', {})
      ensure(session.ok && typeof session.data?.id === 'string', 'HOST_CREATE_FAILED')
      const result = await request('POST', '/session/' + session.data.id + '/message', { model: { providerID: 'fixture', modelID: 'fixture' }, parts: [{ type: 'text', text: 'PROMPT_MODEL_CASE:' + mode }] })
      if (mode !== 'deny') ensure(result.ok, 'HOST_PROMPT_FAILED')
      const children = await request('GET', '/session/' + session.data.id + '/children')
      hostControls.push(await observe('host', mode, result.ok && Array.isArray(result.data?.parts) && result.data.parts.some(part => part.type === 'text' && part.text.includes(DONE)), children.ok && Array.isArray(children.data) && children.data.length === 0))
      await request('DELETE', '/session/' + session.data.id)
    }
    ensure(!errors.length, 'GATEWAY_FAILED: ' + [...new Set(errors)].join(','))
    ensure(digest(await readFile(source)) === sourceDigest && digest(await readFile(recorder)) === hookDigest, 'CONFORMANCE_SOURCE_CHANGED')
    ensure(await fingerprintAdapter(packageRoot) === adapterBuildSha256, 'CONFORMANCE_BUILD_CHANGED')
    return { caseID: 'claude.userpromptsubmit.prompt-model', host: 'v1', nativeVersion, hostVersion, adapterBuildSha256, ...comparePromptModelEvidence(nativeControls, hostControls), platform: process.platform, architecture: process.arch, hostInitializationMs, diagnostics: [...codes].sort(), isolation: { temporaryHomeAndConfig: true, loopbackProvider: true, sourceBytesUnchanged: true, nativeTrustVerified: false, nativePermissionBypass: true, machineManagedSettingsMayRemain: true }, limits: ['Prompt UserPromptSubmit controls and specified artifacts only', 'Explicit native-to-host model alias; no real-model or cross-provider equivalence claim', 'API retry/error policies, other events, agent handlers, V2 and native trust remain unverified'] }
  } catch (error) {
    if (error instanceof ConformanceError) throw error
    const code = typeof error?.code === 'string' && /^[A-Z][A-Z_0-9]{1,47}$/.test(error.code) ? error.code : 'UNKNOWN'
    throw new ConformanceError('CONFORMANCE_PROMPT_MODEL_FAILED: ' + stage + ' system=' + code + ' codes=' + [...codes].sort().join(','))
  } finally {
    clearTimeout(timer)
    try { await stopHost(child, closed) } finally { try { if (gateway) { gateway.closeAllConnections(); await new Promise(resolve => gateway.close(resolve)) } } finally { await rm(root, { recursive: true, force: true }) } }
  }
}
