import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { watch } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { ConformanceError } from './conformance.mjs'
import { fingerprintAdapter, initializeHost, stopHost, verifyPinnedVersion } from './conformance-pretool.mjs'

const INITIAL = 'REWAKE_GENUINE', FUTURE = 'REWAKE_FUTURE', MARKER = 'REWAKE_BOUNDARY_SIGNAL', CONTEXT = 'REWAKE_CALLBACK', DONE = 'REWAKE_DONE'
const TOOL_IDS = Object.freeze(['toolu_rewake_one', 'toolu_rewake_two'])
const MAX_BYTES = 2 * 1024 * 1024, MAX_REQUESTS = 20, DEADLINE_MS = 30000, START_MS = 15000
const READBACK_INTERVAL_MS = 25
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const hash = value => createHash('sha256').update(value).digest('hex')
const quote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'"
const ensure = (value, code) => { if (!value) throw new ConformanceError(code) }

function expected(delivery) {
  return { delivery, done: true, modelCalls: 3, sourceCalls: 6, notificationCallbacks: 1, backgroundEmissions: 1, sessionOwned: true, promptOwned: true, rawPrompt: true, artifactsOwned: true, historyOwned: true, originalResults: true, modelViews: [{ carrier: 'none', notification: false, context: false, ordered: true, copies: 0 }, ...Array.from({ length: 2 }, () => ({ carrier: delivery === 'active' ? 'tool:one' : 'system:user', notification: true, context: true, ordered: true, copies: 1 }))] }
}
export function compareRewakeEvidence(delivery, native, host) {
  const match = ['active', 'idle'].includes(delivery) && isDeepStrictEqual(native, expected(delivery)) && isDeepStrictEqual(host, expected(delivery))
  return { status: match ? 'passed' : 'failed', comparison: { match, native, host, ...(!match ? { failure: 'CONFORMANCE_REWAKE_MISMATCH' } : {}) } }
}
export function rewakeModelEvidence(rows, literal) {
  const carriers = []
  for (const row of rows) {
    if (row.role === 'tool') carriers.push({ carrier: row.tool_call_id === TOOL_IDS[0] ? 'tool:one' : 'tool:other', text: row.content })
    if (row.role === 'user') {
      const parts = Array.isArray(row.content) ? row.content : [{ type: 'text', text: row.content }]
      const plain = parts.filter(part => part.type === 'text').map(part => part.text).join('\n')
      if (plain.includes(MARKER) || plain.includes(CONTEXT)) carriers.push({ carrier: 'system:user', text: plain })
      for (const part of parts.filter(part => part.type === 'tool_result')) carriers.push({ carrier: part.tool_use_id === TOOL_IDS[0] ? 'tool:one' : 'tool:other', text: typeof part.content === 'string' ? part.content : part.content?.map(value => value.text ?? '').join('\n') })
    }
    if (row.role !== 'tool' && row.role !== 'user' && JSON.stringify(row).includes(MARKER)) carriers.push({ carrier: 'unowned', text: JSON.stringify(row) })
  }
  const visible = carriers.filter(row => typeof row.text === 'string' && (row.text.includes(MARKER) || row.text.includes(CONTEXT)))
  if (!visible.length) return { carrier: 'none', notification: false, context: false, ordered: true, copies: 0 }
  const row = visible[0], notification = row.text.indexOf(literal), context = row.text.indexOf(CONTEXT)
  return { carrier: visible.length === 1 ? row.carrier : 'multiple', notification: notification >= 0, context: context >= 0, ordered: notification >= 0 && context >= 0 && (row.carrier === 'system:user' ? context < notification : context > notification), copies: carriers.reduce((count, row) => count + (typeof row.text === 'string' ? row.text.split(MARKER).length - 1 : 0), 0) }
}
function environment(home, project) {
  return { PATH: process.env.PATH, HOME: home, PWD: project, SHELL: '/bin/sh', LANG: 'C', TMPDIR: join(home, 'tmp'), XDG_CONFIG_HOME: join(home, 'config'), XDG_STATE_HOME: join(home, 'state'), XDG_DATA_HOME: join(home, 'data'), XDG_CACHE_HOME: join(home, 'cache'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_NON_ESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1' }
}
async function rows(path) {
  const text = await readFile(path, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error })
  ensure(Buffer.byteLength(text) <= MAX_BYTES, 'REWAKE_TRACE_LIMIT')
  return text.trim() ? text.trim().split('\n').map(line => JSON.parse(line)) : []
}
async function waitFile(path, signal) {
  await new Promise((resolve, reject) => {
    let finished = false
    const finish = error => { if (finished) return; finished = true; observer.close(); signal.removeEventListener('abort', aborted); error ? reject(error) : resolve() }
    const check = () => { void readFile(path).then(() => finish(), error => { if (error.code !== 'ENOENT') finish(error) }) }
    const aborted = () => finish(new ConformanceError('REWAKE_WAIT_CANCELLED'))
    const observer = watch(join(path, '..'), check); observer.on('error', finish)
    signal.addEventListener('abort', aborted, { once: true }); if (signal.aborted) aborted(); else check()
  })
}
export function createRewakeHelper(root, prompt) {
  return `const fs=require('node:fs'),path=require('node:path'),base=${JSON.stringify(root)},initial=${JSON.stringify(INITIAL)},marker=${JSON.stringify(MARKER)}
const p=JSON.parse(fs.readFileSync(0,'utf8')),purpose=process.argv[2],notification=p.prompt===${JSON.stringify(prompt)}
const journal=typeof p.transcript_path==='string'&&fs.existsSync(p.transcript_path)?fs.readFileSync(p.transcript_path,'utf8'):''
if(Buffer.byteLength(journal)>${MAX_BYTES})throw Error('REWAKE_TRACE_LIMIT')
const entries=journal.trim()?journal.trim().split('\\n').map(JSON.parse):[]
fs.appendFileSync(path.join(base,'trace.jsonl'),JSON.stringify({purpose,event:p.hook_event_name,prompt:p.prompt??null,promptID:p.prompt_id??null,session:p.session_id,file:p.transcript_path??null,ready:entries.some(row=>row.message?.content?.some?.(part=>part.type==='tool_result'&&part.tool_use_id===${JSON.stringify(TOOL_IDS[0])}))})+'\\n')
if(purpose==='record'){if(notification)process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'UserPromptSubmit',additionalContext:${JSON.stringify(CONTEXT)}}}));return}
if(p.prompt!==initial)return
const finish=()=>{fs.writeSync(2,marker);fs.writeFileSync(path.join(base,'completed'),'done');process.exit(2)}
if(fs.existsSync(path.join(base,'release')))finish()
else{const observer=fs.watch(base,()=>{if(fs.existsSync(path.join(base,'release'))){observer.close();finish()}});if(fs.existsSync(path.join(base,'release'))){observer.close();finish()}}
`
}
function anthropic(response, body, tool, command, id) {
  const content = tool ? [{ type: 'tool_use', id, name: 'Bash', input: { command, description: 'Owned wake comparison' } }] : [{ type: 'text', text: DONE }]
  const message = { id: 'msg_rewake', type: 'message', role: 'assistant', model: body.model, content, stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }
  if (body.stream === false) { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(message)); return }
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  const emit = (type, value) => response.write('event: ' + type + '\ndata: ' + JSON.stringify({ type, ...value }) + '\n\n')
  emit('message_start', { message: { ...message, content: [], stop_reason: null } }); emit('content_block_start', { index: 0, content_block: tool ? { ...content[0], input: {} } : { type: 'text', text: '' } }); emit('content_block_delta', { index: 0, delta: tool ? { type: 'input_json_delta', partial_json: JSON.stringify(content[0].input) } : { type: 'text_delta', text: DONE } }); emit('content_block_stop', { index: 0 }); emit('message_delta', { delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 1 } }); emit('message_stop', {}); response.end()
}
function chat(response, tool, command, id) {
  const chunk = (delta, finish) => ({ id: 'chatcmpl_rewake', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason: finish }] })
  const delta = tool ? { tool_calls: [{ index: 0, id, type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command, description: 'Owned wake comparison' }) } }] } : { content: DONE }
  response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end('data: ' + JSON.stringify(chunk({ role: 'assistant', ...delta }, null)) + '\n\ndata: ' + JSON.stringify({ ...chunk({}, tool ? 'tool_calls' : 'stop'), usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }) + '\n\ndata: [DONE]\n\n')
}
async function nativeConversation(binary, args, project, env, release, delivery) {
  const child = spawn(binary, args, { cwd: project, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
  const closed = new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject) })
  let pending = '', bytes = 0, count = 0, failed = false
  const timer = setTimeout(() => { failed = true; try { process.kill(-child.pid, 'SIGKILL') } catch {} }, DEADLINE_MS)
  child.stdin.on('error', () => {})
  child.stderr.on('data', chunk => { bytes += chunk.length; if (bytes > MAX_BYTES) { failed = true; child.kill('SIGKILL') } })
  const send = text => child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: '' }) + '\n')
  child.stdout.on('data', chunk => {
    bytes += chunk.length; if (bytes > MAX_BYTES) { failed = true; child.kill('SIGKILL'); return }
    pending += String(chunk)
    try {
      while (pending.includes('\n')) {
        const at = pending.indexOf('\n'), line = pending.slice(0, at); pending = pending.slice(at + 1)
        if (!line.trim()) continue
        const row = JSON.parse(line); if (row.type !== 'result') continue
        ensure(row.is_error === false && row.result === DONE, 'REWAKE_NATIVE_RESULT_INVALID'); count++
        if (delivery === 'active' && count === 1) child.stdin.end()
        else if (count === 1) void writeFile(release, '').catch(() => { failed = true; child.kill('SIGKILL') })
        else if (count === 2) send(FUTURE)
        else if (count === 3) child.stdin.end()
        else throw new ConformanceError('REWAKE_NATIVE_RESULT_INVALID')
      }
    } catch { failed = true; child.kill('SIGKILL') }
  })
  send(INITIAL)
  try { ensure(await closed === 0 && !failed && count === (delivery === 'active' ? 1 : 3) && !pending.trim(), 'REWAKE_NATIVE_CONVERSATION_FAILED') }
  finally { clearTimeout(timer); await stopHost(child, closed) }
}
export function rewakeArtifactEvidence(journal, delivery, oracle, notification) {
  const sameOrigin = value => isDeepStrictEqual(value, { kind: 'task-notification', producer: 'session-task' })
  if (delivery === 'active') {
    const entries = journal.filter(row => row.attachment?.type === 'queued_command' && row.attachment.prompt === oracle.prompt)
    if (entries.length !== 1) return false
    const row = entries[0], item = row.attachment
    const visited = new Set([row.uuid]); let parent = journal.find(value => value.uuid === row.parentUuid)
    while (parent?.type === 'attachment' && !visited.has(parent.uuid)) { visited.add(parent.uuid); parent = journal.find(value => value.uuid === parent.parentUuid) }
    const owned = !visited.has(parent?.uuid) && parent?.type === 'user' && parent.message?.content?.some?.(part => part.type === 'tool_result' && part.tool_use_id === TOOL_IDS[0]) === true
    return owned && item.commandMode === 'task-notification' && sameOrigin(item.origin) && UUID.test(item.source_uuid) && UUID.test(item.delivery_id) && Number.isFinite(Date.parse(item.timestamp)) && row.renderedRole === 'system' && isDeepStrictEqual(row.rendered, [{ content: oracle.model }]) && isDeepStrictEqual(row.renderedInHumanTurn, [{ content: oracle.modelInHumanTurn }])
  }
  const entries = journal.filter(row => row.type === 'user' && row.message?.content === oracle.prompt)
  return entries.length === 1 && entries[0].promptId === notification?.promptID && sameOrigin(entries[0].origin) && entries[0].promptSource === 'system' && entries[0].turnOrigin === 'task_notification' && entries[0].queueSkipAttachments === true && entries[0].turnPosition?.promptIndex === 0 && entries[0].turnPosition?.turnIndex === 2
}

export async function runRewakeComparison({ catalog, packageRoot, nativeBinary, opencodeBinary, delivery }) {
  ensure(['active', 'idle'].includes(delivery), 'REWAKE_DELIVERY_INVALID')
  if (process.platform === 'win32') throw new ConformanceError('PLATFORM_UNAVAILABLE: POSIX process groups', 2)
  const nativeVersion = await verifyPinnedVersion(nativeBinary, 'claude', catalog.versions.native['claude-code']), hostVersion = await verifyPinnedVersion(opencodeBinary, 'opencode', catalog.versions.hosts.v1)
  const adapterBuildSha256 = await fingerprintAdapter(packageRoot), root = await realpath(await mkdtemp(join(tmpdir(), 'rewake-conformance-')))
  const project = join(root, 'project'), nativeHome = join(root, 'native-home'), nativeConfig = join(nativeHome, 'native'), hostHome = join(root, 'host-home'), hostConfig = join(hostHome, 'config/opencode')
  const trace = join(root, 'trace.jsonl'), release = join(root, 'release'), completed = join(root, 'completed'), source = join(root, 'hooks.json'), helper = join(root, 'helper.cjs'), mcp = join(root, 'mcp.json')
  const traffic = { native: [], host: [] }, errors = [], diagnostics = new Set(), effects = [join(project, 'one'), join(project, 'two')]
  let gateway, child, closed, timer, stage = 'setup', native, host, requests = 0
  try {
    await Promise.all([mkdir(project), mkdir(nativeConfig, { recursive: true }), mkdir(hostConfig, { recursive: true }), mkdir(join(nativeHome, 'tmp'), { recursive: true }), mkdir(join(hostHome, 'tmp'), { recursive: true })])
    const oracle = JSON.parse(await readFile(join(packageRoot, 'test/fixtures/claude-wake-oracle.json'), 'utf8')).cases.find(row => row.name === 'plain')
    ensure(oracle?.text === MARKER, 'REWAKE_ORACLE_INVALID')
    const helperText = createRewakeHelper(root, oracle.prompt), command = purpose => ({ type: 'command', command: [process.execPath, helper, purpose].map(quote).join(' '), timeout: 10, ...(purpose === 'wake' ? { asyncRewake: true } : {}) })
    const sourceText = JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [command('record'), command('wake')] }], ...(delivery === 'active' ? { PreToolUse: [{ hooks: [command('record')] }] } : {}) } }), sourceDigest = hash(sourceText)
    await Promise.all([writeFile(source, sourceText), writeFile(helper, helperText), writeFile(mcp, '{"mcpServers":{}}')])
    gateway = createServer(async (request, response) => {
      try {
        ensure(++requests <= MAX_REQUESTS, 'REWAKE_REQUEST_LIMIT')
        const path = new URL(request.url, 'http://loopback').pathname
        if (path.endsWith('/hello')) { response.writeHead(404); response.end('{}'); return }
        if (path.endsWith('/count_tokens')) { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"input_tokens":1}'); return }
        const chunks = []; let bytes = 0
        for await (const chunk of request) { bytes += chunk.length; ensure(bytes <= MAX_BYTES, 'REWAKE_INPUT_LIMIT'); chunks.push(chunk) }
        const body = JSON.parse(Buffer.concat(chunks)), backend = path === '/native/v1/messages' ? 'native' : path === '/host/v1/chat/completions' ? 'host' : undefined
        ensure(backend, 'REWAKE_ROUTE_INVALID')
        const messages = body.messages ?? [], tools = body.tools?.map(tool => backend === 'host' ? tool.function?.name : tool.name) ?? [], parent = JSON.stringify(messages).includes(INITIAL) && tools.includes(backend === 'host' ? 'bash' : 'Bash')
        let ordinal = 0
        if (parent) { traffic[backend].push(rewakeModelEvidence(messages, oracle.model)); ordinal = traffic[backend].length; ensure(ordinal <= 3, 'REWAKE_PARENT_LIMIT') }
        const tool = parent && delivery === 'active' && ordinal < 3
        if (tool && ordinal === 1) await writeFile(release, '')
        const index = ordinal - 1, toolCommand = tool ? 'sleep 0.3; printf ' + quote('REWAKE_RESULT_' + (index + 1)) + '; printf ' + quote(index ? 'two' : 'one') + ' > ' + quote(effects[index]) : undefined
        if (backend === 'native') anthropic(response, body, tool, toolCommand, TOOL_IDS[index]); else chat(response, tool, toolCommand, TOOL_IDS[index])
        if (tool && ordinal === 1) await waitFile(completed, AbortSignal.timeout(START_MS))
        if (parent && delivery === 'idle' && ordinal === 2) await writeFile(join(root, 'wake-model'), '')
      } catch (error) { errors.push(error instanceof ConformanceError ? error.message : 'REWAKE_GATEWAY_INVALID'); if (!response.headersSent) response.writeHead(500); response.end('{}') }
    })
    await new Promise((resolve, reject) => { gateway.once('error', reject); gateway.listen(0, '127.0.0.1', resolve) })
    const address = 'http://127.0.0.1:' + gateway.address().port
    const prepare = () => Promise.all([trace, release, completed, join(root, 'wake-model'), ...effects].map(path => rm(path, { force: true })))
    const observe = async (backend, done, rawHistory) => {
      const calls = await rows(trace), first = calls.find(row => row.purpose === 'record' && row.prompt === INITIAL), notification = calls.filter(row => row.purpose === 'record' && row.prompt === oracle.prompt), callback = notification[0], last = calls.at(-1)
      const journal = last?.file ? await rows(last.file) : [], genuine = journal.filter(row => row.type === 'user' && [INITIAL, FUTURE].includes(typeof row.message?.content === 'string' ? row.message.content : row.message?.content?.filter?.(part => part.type === 'text').map(part => part.text).join('')))
      const hostUsers = rawHistory?.filter(row => row.info?.role === 'user'), expectedPrompts = delivery === 'active' ? [INITIAL] : [INITIAL, FUTURE]
      const genuineTexts = rawHistory ? hostUsers.filter(row => row.parts.map(part => part.text ?? '').join('') !== oracle.prompt).map(row => row.parts.map(part => part.text ?? '').join('')) : genuine.map(row => typeof row.message.content === 'string' ? row.message.content : row.message.content.filter(part => part.type === 'text').map(part => part.text).join(''))
      const rawResults = rawHistory ? rawHistory.flatMap(row => row.parts?.filter(part => part.type === 'tool').map(part => part.state?.output) ?? []) : journal.flatMap(row => Array.isArray(row.message?.content) ? row.message.content.filter(part => part.type === 'tool_result').map(part => part.content) : [])
      const values = await Promise.all(effects.map(path => readFile(path, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error })))
      return { delivery, done, modelCalls: traffic[backend].length, sourceCalls: calls.length, notificationCallbacks: notification.length, backgroundEmissions: calls.filter(row => row.purpose === 'wake' && row.prompt === INITIAL).length, sessionOwned: !!first?.session && calls.every(row => row.session === first.session), promptOwned: !!first?.promptID && !!callback?.promptID && (delivery === 'active' ? callback.promptID === first.promptID && callback.ready : callback.promptID !== first.promptID), rawPrompt: callback?.prompt === oracle.prompt, artifactsOwned: rewakeArtifactEvidence(journal, delivery, oracle, callback), historyOwned: isDeepStrictEqual(genuineTexts, expectedPrompts) && (hostUsers === undefined || hostUsers.length === (delivery === 'active' ? 1 : 3) && hostUsers.every(row => row.parts?.every(part => part.type === 'text') && (row.parts.map(part => part.text).join('') !== oracle.prompt || row.parts.every(part => part.synthetic === true)))), originalResults: delivery === 'idle' ? values.every(value => value === null) : values[0] === 'one' && values[1] === 'two' && ['REWAKE_RESULT_1', 'REWAKE_RESULT_2'].every(token => rawResults.some(value => typeof value === 'string' && value.includes(token) && !value.includes(MARKER))), modelViews: traffic[backend] }
    }
    stage = 'native'; await prepare()
    const args = ['-p', '--setting-sources', '', '--strict-mcp-config', '--mcp-config', mcp, '--settings', source, '--tools', 'Bash', '--dangerously-skip-permissions', '--max-turns', '4', '--model', 'claude-sonnet-4-6']
    const nativeEnv = { ...environment(nativeHome, project), CLAUDE_CONFIG_DIR: nativeConfig, ANTHROPIC_API_KEY: 'synthetic', ANTHROPIC_BASE_URL: address + '/native' }
    await nativeConversation(nativeBinary, [...args, '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'], project, nativeEnv, release, delivery)
    native = await observe('native', true)
    stage = 'host-start'; await prepare()
    const password = 'synthetic-rewake', options = { sources: [{ id: 'native', dialect: 'claude-code', path: source }], reviewedDigests: { native: sourceDigest }, permissionMode: 'bypassPermissions' }
    await writeFile(join(hostConfig, 'opencode.json'), JSON.stringify({ model: 'fixture/fixture', small_model: 'fixture/fixture', snapshot: false, share: 'disabled', autoupdate: false, permission: 'allow', plugin: [[pathToFileURL(join(packageRoot, 'dist/index.js')).href, options]], provider: { fixture: { npm: '@ai-sdk/openai-compatible', options: { apiKey: 'synthetic', baseURL: address + '/host/v1' }, models: { fixture: { name: 'Wake fixture', limit: { context: 100000, output: 2000 } } } } } }))
    const port = createServer(); await new Promise(resolve => port.listen(0, '127.0.0.1', resolve)); const number = port.address().port; await new Promise(resolve => port.close(resolve))
    child = spawn(opencodeBinary, ['--print-logs', 'serve', '--hostname', '127.0.0.1', '--port', String(number)], { cwd: project, env: { ...environment(hostHome, project), OPENCODE_CONFIG_DIR: hostConfig, OPENCODE_DISABLE_CLAUDE_CODE: '1', OPENCODE_DISABLE_DEFAULT_PLUGINS: '1', OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_EXTERNAL_SKILLS: '1', OPENCODE_SERVER_PASSWORD: password }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    closed = new Promise(resolve => child.once('close', resolve)); child.stderr.on('data', chunk => { for (const code of String(chunk).match(/\b(?:HOST|WAKE|TRANSCRIPT|SOURCE|SESSION_STORE)_[A-Z_]+\b/g) ?? []) diagnostics.add(code) })
    const hostAddress = await Promise.race([new Promise((resolve, reject) => { let text = ''; child.once('error', () => reject(new ConformanceError('REWAKE_HOST_START_FAILED'))); child.once('close', () => reject(new ConformanceError('REWAKE_HOST_EXITED'))); child.stdout.on('data', chunk => { text = (text + String(chunk)).slice(-MAX_BYTES); const found = /http:\/\/127\.0\.0\.1:\d+/.exec(text)?.[0]; if (found) resolve(found) }) }), new Promise((_, reject) => { timer = setTimeout(() => reject(new ConformanceError('REWAKE_HOST_START_TIMEOUT')), START_MS) })]); clearTimeout(timer)
    await initializeHost(hostAddress, project, password)
    const request = async (method, path, body, signal = AbortSignal.timeout(DEADLINE_MS)) => {
      const response = await fetch(hostAddress + path + '?directory=' + encodeURIComponent(project), { method, headers: { 'content-type': 'application/json', authorization: 'Basic ' + Buffer.from('opencode:' + password).toString('base64') }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal })
      ensure(response.ok, 'REWAKE_HOST_REQUEST_FAILED'); return response.json()
    }
    stage = 'host'; const session = await request('POST', '/session', {}); ensure(typeof session.id === 'string', 'REWAKE_HOST_SESSION_INVALID')
    const prompt = text => request('POST', '/session/' + session.id + '/message', { model: { providerID: 'fixture', modelID: 'fixture' }, parts: [{ type: 'text', text }] })
    const first = await prompt(INITIAL)
    let futureDone = true
    if (delivery === 'idle') {
      await writeFile(release, '')
      const signal = AbortSignal.timeout(START_MS)
      await waitFile(join(root, 'wake-model'), signal)
      while (true) {
        const saved = await request('GET', '/session/' + session.id + '/message', undefined, signal)
        const notification = saved.find(row => row.info?.role === 'user' && row.parts?.map(part => part.text ?? '').join('') === oracle.prompt)
        if (notification && saved.some(row => row.info?.role === 'assistant' && row.info.parentID === notification.info.id && Number.isFinite(row.info.time?.completed) && row.parts?.some(part => part.type === 'text' && part.text === DONE))) break
        await delay(READBACK_INTERVAL_MS, undefined, { signal })
      }
      const future = await prompt(FUTURE)
      futureDone = future.parts?.some(part => part.type === 'text' && part.text === DONE) === true
      while ((await rows(trace)).length < expected(delivery).sourceCalls) await delay(READBACK_INTERVAL_MS, undefined, { signal })
    }
    const rawHistory = await request('GET', '/session/' + session.id + '/message')
    host = await observe('host', futureDone && first.parts?.some(part => part.type === 'text' && part.text === DONE) === true, rawHistory)
    ensure(await request('DELETE', '/session/' + session.id), 'REWAKE_HOST_DELETE_FAILED')
    ensure(!errors.length, 'REWAKE_GATEWAY_FAILED: ' + [...new Set(errors)].join(','))
    ensure(hash(await readFile(source)) === sourceDigest && hash(await readFile(helper)) === hash(helperText), 'CONFORMANCE_SOURCE_CHANGED')
    ensure(await fingerprintAdapter(packageRoot) === adapterBuildSha256, 'CONFORMANCE_BUILD_CHANGED')
    return { caseID: 'claude.rewake.' + delivery, host: 'v1', nativeVersion, hostVersion, adapterBuildSha256, ...compareRewakeEvidence(delivery, native, host), diagnostics: [...diagnostics].sort(), platform: process.platform, architecture: process.arch, isolation: { temporaryHomeAndConfig: true, loopbackProvider: true, sourceBytesUnchanged: true, nativeTrustVerified: false, nativePermissionBypass: true, machineManagedSettingsMayRemain: true }, limits: ['Selected Claude asyncRewake exit-2 context delivery at an active tool or from idle; callbacks and exact literal notification text are checked', 'Native artifact fields and raw history are checked separately from model carriers; no real model account is used', 'Concurrent queued-human emulation, callback handler families, full UI, other providers and V2 retain separate implementation/proof obligations'] }
  } catch (error) { throw new ConformanceError('CONFORMANCE_REWAKE_FAILED: ' + delivery + '/' + stage + ' code=' + (error instanceof ConformanceError ? error.message : 'UNKNOWN') + ' modelCalls=' + JSON.stringify({ native: traffic.native.length, host: traffic.host.length }) + ' observations=' + JSON.stringify({ native, host }) + ' diagnostics=' + [...diagnostics].sort().join(',')) }
  finally { clearTimeout(timer); try { await stopHost(child, closed) } finally { if (gateway) { gateway.closeAllConnections(); await new Promise(resolve => gateway.close(resolve)) }; await rm(root, { recursive: true, force: true }) } }
}
