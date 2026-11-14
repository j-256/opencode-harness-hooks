import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { watch } from 'node:fs'
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { ConformanceError } from './conformance.mjs'
import { fingerprintAdapter, initializeHost, stopHost, verifyPinnedVersion } from './conformance-pretool.mjs'
import { runNativeGatedConversation, runNativeProcess } from './native-process.mjs'

const MODES = Object.freeze(['context', 'nonzero', 'control', 'invalid', 'empty'])
const SYSTEM = 'BACKGROUND_SYSTEM', CONTEXT = 'BACKGROUND_CONTEXT', CONTROL = 'BACKGROUND_IGNORED_CONTROL'
const STDERR = 'BACKGROUND_STDERR', DONE = 'BACKGROUND_COMPARISON_DONE'
const SOURCE_MARKERS = Object.freeze([SYSTEM, CONTEXT, CONTROL])
const TOOL_IDS = Object.freeze(['toolu_background_one', 'toolu_background_two'])
const HOST_MODEL = 'fixture'
const IDLE_WINDOW_MS = 150
const IDLE_PROMPTS = Object.freeze(['BG_CASE:context', 'BG_CASE:context BG_NEXT:two', 'BG_CASE:context BG_NEXT:three'])
const MAX_BYTES = 2 * 1024 * 1024, MAX_REQUESTS = 100, REQUEST_MS = 30000, START_MS = 15000
const quote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'"
const hash = value => createHash('sha256').update(value).digest('hex')
const reminders = () => [SYSTEM, CONTEXT].map(text => `<system-reminder>\n${text}\n</system-reminder>`)
export function backgroundUiMessage(value) { return typeof value === 'string' && SOURCE_MARKERS.some(marker => value.includes(marker)) ? value : undefined }
function ensure(value, code) { if (!value) throw new ConformanceError(code) }
function output(dialect, mode) {
  const info = mode === 'context' || mode === 'nonzero'
  const response = info ? { continue: false, decision: 'block', reason: CONTROL, systemMessage: SYSTEM, hookSpecificOutput: { hookEventName: dialect === 'claude-code' ? 'UserPromptSubmit' : 'PreToolUse', additionalContext: CONTEXT } } : { continue: false, stopReason: CONTROL, suppressOutput: true }
  return { stdout: mode === 'empty' ? '{}' : mode === 'invalid' ? 'invalid background output' : JSON.stringify(response), stderr: mode === 'nonzero' ? STDERR : '', exitCode: mode === 'nonzero' ? 1 : 0, response: info || mode === 'control' ? response : null }
}
function expected(dialect, mode) {
  const value = output(dialect, mode), info = mode === 'context' || mode === 'nonzero', visible = info && (dialect === 'claude-code' || mode !== 'nonzero')
  const hooks = visible ? [{ carrier: dialect === 'claude-code' ? 'tool:one' : 'developer:tool:one', text: dialect === 'claude-code' ? reminders().join('\n\n') : CONTEXT }] : []
  return { mode, done: true, modelCalls: 3, models: [[], hooks, hooks], ignoredControlVisible: false, ui: dialect === 'codex' && mode === 'context' ? [SYSTEM] : [], effects: ['one', 'two'], originalResults: true, hookCalls: dialect === 'claude-code' ? 3 : 4, ownedIdentity: true, backgroundEmissions: 1, artifacts: dialect === 'claude-code' && value.response ? [{ type: 'async_hook_response', hookEvent: 'UserPromptSubmit', hookName: 'UserPromptSubmit', response: value.response, stdout: value.stdout, stderr: value.stderr, exitCode: value.exitCode, rendered: info ? reminders() : [], renderedRole: info ? 'system' : null, processOwned: true, carrier: 'tool:one' }] : [], rollout: dialect === 'codex' && visible ? [{ text: CONTEXT, role: 'developer', kinds: ['hooks.additional_context'], provenance: [{ provenance: { type: 'harness', hook: true } }], ownedTurn: true, carrier: 'tool:one' }] : [] }
}
export function compareBackgroundEvidence(dialect, native, host) {
  const valid = rows => ['claude-code', 'codex'].includes(dialect) && Array.isArray(rows) && rows.length === MODES.length && new Set(rows.map(row => row?.mode)).size === MODES.length && rows.every(row => MODES.includes(row?.mode) && isDeepStrictEqual(row, expected(dialect, row.mode)))
  const match = valid(native) && valid(host)
  return { status: match ? 'passed' : 'failed', comparison: { match, native, host, ...(!match ? { failure: 'CONFORMANCE_BACKGROUND_MISMATCH' } : {}) } }
}
export function compareBackgroundIdleEvidence(native, host) {
  const { effects, originalResults, ...row } = expected('claude-code', 'context')
  row.models = [[], ...Array.from({ length: 2 }, () => [{ carrier: 'prompt:two', parts: [reminders()[0], reminders()[1] + '\n', IDLE_PROMPTS[1]] }])]
  row.hookCalls = 6; row.artifacts[0].carrier = 'prompt:two'
  const value = [{ ...row, idleWake: false, originalPrompts: true }], match = isDeepStrictEqual(native, value) && isDeepStrictEqual(host, value)
  return { status: match ? 'passed' : 'failed', comparison: { match, native, host, ...(!match ? { failure: 'CONFORMANCE_BACKGROUND_IDLE_MISMATCH' } : {}) } }
}
function environment(home, project) {
  return { PATH: process.env.PATH, HOME: home, PWD: project, SHELL: '/bin/sh', LANG: 'C', TMPDIR: join(home, 'tmp'), XDG_CONFIG_HOME: join(home, 'config'), XDG_STATE_HOME: join(home, 'state'), XDG_DATA_HOME: join(home, 'data'), XDG_CACHE_HOME: join(home, 'cache'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_NON_ESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1' }
}
async function readRows(path) { const text = await readFile(path, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error }); ensure(Buffer.byteLength(text) <= MAX_BYTES, 'BACKGROUND_TRACE_LIMIT'); return text.trim() ? text.trim().split('\n').map(line => JSON.parse(line)) : [] }
async function waitFile(path, signal) {
  if (signal.aborted) throw signal.reason
  await new Promise((resolve, reject) => {
    let settled = false
    const finish = error => { if (settled) return; settled = true; watcher.close(); signal.removeEventListener('abort', aborted); error ? reject(error) : resolve() }
    let checking = false, again = false
    const check = async () => { if (checking) { again = true; return }; checking = true; try { await access(path); finish() } catch (error) { if (error.code !== 'ENOENT') finish(error) } finally { checking = false; if (again && !settled) { again = false; void check() } } }
    const aborted = () => finish(new ConformanceError('BACKGROUND_WAIT_CANCELLED'))
    const watcher = watch(dirname(path), () => { void check() }); watcher.on('error', finish)
    signal.addEventListener('abort', aborted, { once: true }); if (signal.aborted) aborted(); else void check()
  })
}
function anthropic(response, body, name, input, id) {
  const invoke = !!name, content = invoke ? [{ type: 'tool_use', id, name, input }] : [{ type: 'text', text: DONE }]
  const message = { id: 'msg_background', type: 'message', role: 'assistant', model: body.model, content, stop_reason: invoke ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }
  if (body.stream === false) { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(message)); return }
  response.writeHead(200, { 'content-type': 'text/event-stream' }); const event = (type, data) => response.write('event: ' + type + '\ndata: ' + JSON.stringify({ type, ...data }) + '\n\n')
  event('message_start', { message: { ...message, content: [], stop_reason: null } }); event('content_block_start', { index: 0, content_block: invoke ? { ...content[0], input: {} } : { type: 'text', text: '' } }); event('content_block_delta', { index: 0, delta: invoke ? { type: 'input_json_delta', partial_json: JSON.stringify(input) } : { type: 'text_delta', text: DONE } }); event('content_block_stop', { index: 0 }); event('message_delta', { delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 1 } }); event('message_stop', {}); response.end()
}
function chat(response, name, input, id) {
  const chunk = (delta, finish) => ({ id: 'chatcmpl_background', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason: finish }] })
  response.writeHead(200, { 'content-type': 'text/event-stream' }); const delta = name ? { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(input) } }] } : { content: DONE }
  response.end('data: ' + JSON.stringify(chunk({ role: 'assistant', ...delta }, null)) + '\n\ndata: ' + JSON.stringify({ ...chunk({}, name ? 'tool_calls' : 'stop'), usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }) + '\n\ndata: [DONE]\n\n')
}
function responses(response, name, input, id) {
  const item = name ? { id: 'fc_' + id, type: 'function_call', call_id: id, name, arguments: JSON.stringify(input) } : { id: 'msg_background', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: DONE }] }
  const events = [{ type: 'response.created', response: { id: 'response_background' } }, { type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response: { id: 'response_background', usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }]
  response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end(events.map(event => 'event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n').join(''))
}
export function backgroundModelEvidence(rows, idle = false) {
  const found = [], blocks = reminders()
  let lastTool
  for (const row of rows) {
    const id = row.type === 'function_call_output' ? row.call_id : row.role === 'tool' ? row.tool_call_id : undefined
    const tools = id ? [{ id, text: row.output ?? row.content }] : row.role === 'user' && Array.isArray(row.content) ? row.content.filter(part => part.type === 'tool_result').map(part => ({ id: part.tool_use_id, text: part.content })) : []
    for (const tool of tools) {
      lastTool = TOOL_IDS.indexOf(tool.id) === 0 ? 'tool:one' : TOOL_IDS.indexOf(tool.id) === 1 ? 'tool:two' : 'unknown'
      const text = typeof tool.text === 'string' ? tool.text : JSON.stringify(tool.text) ?? '', first = text.indexOf(blocks[0])
      if (backgroundUiMessage(text)) found.push({ carrier: lastTool, text: first >= 0 ? text.slice(first) : text })
    }
    if (row.role === 'developer') {
      const content = typeof row.content === 'string' ? row.content : row.content?.map(part => part.text).join('')
      if (backgroundUiMessage(content)) found.push({ carrier: 'developer:' + lastTool, text: content })
    }
    if (row.role !== 'developer' && !tools.length && backgroundUiMessage(JSON.stringify(row.content))) {
      if (idle && row.role === 'user' && Array.isArray(row.content) && row.content.every(part => part.type === 'text' && typeof part.text === 'string')) found.push({ carrier: row.content.at(-1).text === IDLE_PROMPTS[1] ? 'prompt:two' : 'unexpected', parts: row.content.map(part => part.text).filter(text => text.includes(SYSTEM) || text.includes(CONTEXT) || text === IDLE_PROMPTS[1]) })
      else found.push({ carrier: row.role + ':unexpected', text: 'Unexpected context carrier' })
    }
  }
  return found
}
export function createBackgroundHelper(root, dialect) {
  const table = Object.fromEntries(MODES.map(mode => [mode, output(dialect, mode)]))
  return `const fs = require('node:fs'), path = require('node:path')
const purpose = process.argv[2], base = ${JSON.stringify(root)}, dialect = ${JSON.stringify(dialect)}, table = ${JSON.stringify(table)}
const p = JSON.parse(fs.readFileSync(0, 'utf8')), text = p.prompt ?? p.tool_input?.command ?? ''
const mode = /BG_CASE:([a-z]+)/.exec(text)?.[1] ?? 'context'
const first = purpose === 'background' && (dialect === 'claude-code' ? !text.includes('BG_NEXT:') : text.includes('BG_TOOL_ONE')), all = []
if (typeof p.transcript_path === 'string' && fs.existsSync(p.transcript_path)) {
  const source = fs.readFileSync(p.transcript_path, 'utf8')
  if (Buffer.byteLength(source) > ${MAX_BYTES}) process.exit(1)
  for (const line of source.trim().split('\\n')) {
    if (!line) continue
    const row = JSON.parse(line)
    if (dialect === 'claude-code' && row.type === 'attachment' && row.attachment?.type === 'async_hook_response') {
      let child = row, index = all.length - 1, chain = true
      while (index >= 0) {
        const previous = all[index].body ?? all[index]
        if (child.parentUuid !== previous.uuid || !previous.uuid) chain = false
        if (previous.type !== 'attachment') break
        child = previous; index--
      }
      const previous = all[index]?.body ?? all[index]
      const owned = chain && previous?.message?.content?.some?.(part => part.type === 'tool_result' && part.tool_use_id === ${JSON.stringify(TOOL_IDS[0])})
      const content = previous?.message?.content, prompt = typeof content === 'string' ? content : content?.filter?.(part => part.type === 'text').map(part => part.text).join('')
      all.push({ body: row, carrier: owned ? 'tool:one' : chain && previous?.message?.role === 'user' && prompt === ${JSON.stringify(IDLE_PROMPTS[1])} ? 'prompt:two' : 'unexpected' })
    } else all.push(row)
  }
}
const prompts = all.filter(row => row.type === 'user' && row.message?.role === 'user').map(row => typeof row.message.content === 'string' ? row.message.content : row.message.content?.filter?.(part => part.type === 'text').map(part => part.text).join('')).filter(text => text?.includes('BG_CASE:'))
const trace = { purpose, event: p.hook_event_name, session: p.session_id, turn: p.turn_id ?? null, pid: process.pid, ppid: process.ppid, first, prompts, rows: all.filter(row => dialect === 'claude-code' ? row.body : row.type === 'response_item' && (row.payload?.type === 'function_call_output' || row.payload?.role === 'developer') && (!row.payload.content || JSON.stringify(row.payload.content).includes(${JSON.stringify(CONTEXT)}))) }
fs.appendFileSync(path.join(base, 'trace.jsonl'), JSON.stringify(trace) + '\\n')
if (purpose !== 'background') return
if (!first) { fs.writeSync(1, '{}'); if (dialect === 'claude-code') fs.writeFileSync(path.join(base, text.includes('BG_NEXT:two') ? 'ready-two' : 'ready-three'), 'completed'); return }
const emit = () => { const value = table[mode]; fs.writeSync(1, value.stdout); if (value.stderr) fs.writeSync(2, value.stderr); fs.writeFileSync(path.join(base, 'completed'), String(process.pid)); process.exit(value.exitCode) }
if (fs.existsSync(path.join(base, 'release'))) emit()
else {
  const watcher = fs.watch(base, () => { if (fs.existsSync(path.join(base, 'release'))) { watcher.close(); emit() } })
  if (fs.existsSync(path.join(base, 'release'))) { watcher.close(); emit() }
}`
}

async function availablePort() {
  const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port
}
async function observeEvents(address, project, password, signal, warnings) {
  const response = await fetch(address + '/event?directory=' + encodeURIComponent(project), { headers: { authorization: 'Basic ' + Buffer.from('opencode:' + password).toString('base64') }, signal })
  ensure(response.ok && response.body, 'BACKGROUND_EVENTS_UNAVAILABLE')
  const reader = response.body.getReader(), decoder = new TextDecoder()
  let pending = '', bytes = 0
  const done = (async () => {
    try {
      while (true) {
        const part = await reader.read(); if (part.done) break
        bytes += part.value.byteLength; ensure(bytes <= MAX_BYTES, 'BACKGROUND_EVENTS_LIMIT'); pending += decoder.decode(part.value, { stream: true })
        while (pending.includes('\n\n')) {
          const at = pending.indexOf('\n\n'), block = pending.slice(0, at); pending = pending.slice(at + 2)
          for (const line of block.split('\n')) if (line.startsWith('data: ')) {
            const event = JSON.parse(line.slice(6))
            if (event.type === 'tui.toast.show' && backgroundUiMessage(event.properties?.message)) warnings.push(event.properties.message)
          }
        }
      }
    } catch (error) { if (!signal.aborted) throw error } finally { reader.releaseLock() }
  })()
  void done.catch(() => {})
  return { done }
}
function toolOutputs(rows) {
  return rows.flatMap(row => row.type === 'function_call_output' ? [{ id: row.call_id, text: row.output }] : row.role === 'tool' ? [{ id: row.tool_call_id, text: row.content }] : row.role === 'user' && Array.isArray(row.content) ? row.content.filter(part => part.type === 'tool_result').map(part => ({ id: part.tool_use_id, text: part.content })) : [])
}
function artifactEvidence(rows, first) {
  return rows.map(({ body, carrier }) => {
    const artifact = body.attachment, pid = /^async_hook_(\d+)$/.exec(artifact.processId)?.[1]
    return { type: artifact.type, hookEvent: artifact.hookEvent, hookName: artifact.hookName, response: artifact.response, stdout: artifact.stdout, stderr: artifact.stderr, exitCode: artifact.exitCode, rendered: body.rendered?.map(part => part.content) ?? [], renderedRole: body.renderedRole ?? null, processOwned: !!pid && [first?.pid, first?.ppid].includes(Number(pid)), carrier }
  })
}
function rolloutEvidence(rows, turn) {
  const result = []; let previous
  for (const row of rows) {
    const payload = row.payload
    if (payload?.role === 'developer') {
      const metadata = payload.internal_chat_message_metadata_passthrough
      result.push({ text: payload.content?.map(part => part.text).join(''), role: payload.role, kinds: metadata?.content_item_kinds, provenance: metadata?.content_item_metadata, ownedTurn: typeof turn === 'string' && metadata?.turn_id === turn, carrier: previous?.type === 'function_call_output' && previous.call_id === TOOL_IDS[0] ? 'tool:one' : 'unexpected' })
    }
    previous = payload
  }
  return result
}

export async function runBackgroundComparison({ catalog, packageRoot, dialect, nativeBinary, opencodeBinary, delivery = 'active' }) {
  ensure(['claude-code', 'codex'].includes(dialect), 'BACKGROUND_DIALECT_INVALID')
  ensure(delivery === 'active' || delivery === 'idle' && dialect === 'claude-code', 'BACKGROUND_DELIVERY_INVALID')
  const idle = delivery === 'idle', modes = idle ? ['context'] : MODES
  if (process.platform === 'win32') throw new ConformanceError('PLATFORM_UNAVAILABLE: POSIX process groups', 2)
  const nativeVersion = await verifyPinnedVersion(nativeBinary, dialect === 'claude-code' ? 'claude' : 'codex', catalog.versions.native[dialect])
  const hostVersion = await verifyPinnedVersion(opencodeBinary, 'opencode', catalog.versions.hosts.v1)
  const entrypoint = join(packageRoot, 'dist/index.js')
  try { await access(entrypoint) } catch { throw new ConformanceError('DEPENDENCY_UNAVAILABLE: built adapter', 3) }
  const adapterBuildSha256 = await fingerprintAdapter(packageRoot), root = await realpath(await mkdtemp(join(tmpdir(), 'background-conformance-')))
  let gateway, child, closed, timer, eventController, eventsDone, stage = 'setup', requests = 0
  const traffic = new Map(), errors = [], codes = new Set(), warnings = []
  try {
    const project = join(root, 'project'), nativeHome = join(root, 'native-home'), hostHome = join(root, 'host-home'), nativeConfig = join(nativeHome, 'native'), hostConfig = join(hostHome, 'config/opencode')
    await Promise.all([mkdir(project), mkdir(nativeConfig, { recursive: true }), mkdir(hostConfig, { recursive: true }), mkdir(join(nativeHome, 'tmp'), { recursive: true }), mkdir(join(hostHome, 'tmp'), { recursive: true })])
    const helper = join(root, 'helper.cjs'), trace = join(root, 'trace.jsonl'), completed = join(root, 'completed'), release = join(root, 'release'), source = join(root, 'hooks.json'), mcp = join(root, 'mcp.json'), effects = [join(project, 'one'), join(project, 'two')]
    const helperText = createBackgroundHelper(root, dialect), command = purpose => ({ type: 'command', command: [process.execPath, helper, purpose].map(quote).join(' '), timeout: 5, ...(purpose === 'background' ? { async: true } : {}) })
    const sourceText = JSON.stringify({ hooks: idle ? { UserPromptSubmit: [{ hooks: [command('record'), command('background')] }] } : dialect === 'claude-code' ? { UserPromptSubmit: [{ hooks: [command('background')] }], PreToolUse: [{ hooks: [command('record')] }] } : { PreToolUse: [{ hooks: [command('background')] }], PostToolUse: [{ hooks: [command('record')] }] } }), sourceDigest = hash(sourceText)
    await Promise.all([writeFile(helper, helperText), writeFile(source, sourceText), writeFile(mcp, '{"mcpServers":{}}')])
    const commandFor = (mode, index) => ': ' + quote('BG_CASE:' + mode) + '; sleep 0.3; printf ' + quote(index ? 'BG_TOOL_TWO' : 'BG_TOOL_ONE') + '; printf ' + quote(index ? 'two' : 'one') + ' > ' + quote(effects[index])
    gateway = createServer(async (request, response) => {
      try {
        ensure(++requests <= MAX_REQUESTS, 'BACKGROUND_GATEWAY_LIMIT')
        const path = new URL(request.url, 'http://loopback').pathname
        if (path.endsWith('/api/hello')) { response.writeHead(404); response.end('{}'); return }
        if (path.endsWith('/messages/count_tokens')) { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"input_tokens":1}'); return }
        let bytes = 0; const chunks = []
        for await (const chunk of request) { bytes += chunk.length; ensure(bytes <= MAX_BYTES, 'BACKGROUND_GATEWAY_INPUT_LIMIT'); chunks.push(chunk) }
        const body = JSON.parse(Buffer.concat(chunks)), native = path === '/native/v1/messages' || path === '/native/v1/responses', host = path === '/host/v1/chat/completions'
        ensure(native || host, 'BACKGROUND_GATEWAY_ROUTE_INVALID')
        const rows = body.messages ?? body.input ?? [], text = JSON.stringify(rows), tools = body.tools?.map(tool => host ? tool.function?.name : tool.name) ?? []
        const mode = MODES.find(value => text.includes('BG_CASE:' + value)), name = host ? 'bash' : dialect === 'claude-code' ? 'Bash' : 'exec_command', parent = !!mode && tools.includes(name)
        const send = (tool, input, id) => host ? chat(response, tool, input, id) : dialect === 'claude-code' ? anthropic(response, body, tool, input, id) : responses(response, tool, input, id)
        if (!parent) { send(); return }
        const key = (native ? 'native:' : 'host:') + mode, state = traffic.get(key) ?? { models: [], ignoredControlVisible: false, outputs: [], idleWake: false }
        traffic.set(key, state); state.models.push(backgroundModelEvidence(rows, idle)); state.ignoredControlVisible ||= text.includes(CONTROL); state.outputs = toolOutputs(rows)
        ensure(state.models.length <= 3, 'BACKGROUND_PARENT_LIMIT')
        if (idle) { if (state.models.length > 1) await waitFile(join(root, state.models.length === 2 ? 'ready-two' : 'ready-three'), AbortSignal.timeout(START_MS)); send(); return }
        if (state.models.length === 1) {
          await writeFile(release, '')
          if (dialect === 'claude-code') await waitFile(completed, AbortSignal.timeout(START_MS))
        }
        const index = state.models.length - 1
        send(index < 2 ? name : undefined, index < 2 ? dialect === 'codex' && native ? { cmd: commandFor(mode, index) } : { command: commandFor(mode, index), description: 'Background delivery fixture' } : undefined, TOOL_IDS[index])
      } catch (error) { errors.push(error instanceof ConformanceError ? error.message : 'BACKGROUND_GATEWAY_INVALID'); if (!response.headersSent) response.writeHead(500); response.end('{}') }
    })
    await new Promise((resolve, reject) => { gateway.once('error', reject); gateway.listen(0, '127.0.0.1', resolve) })
    const address = 'http://127.0.0.1:' + gateway.address().port
    const prepare = async () => { warnings.length = 0; await Promise.all([trace, completed, release, join(root, 'ready-two'), join(root, 'ready-three'), ...effects].map(path => rm(path, { force: true }))) }
    const idleGate = async (backend, count, signal) => {
      if (count !== 1) return
      const state = traffic.get(backend + ':context'); ensure(state?.models.length === 1, 'BACKGROUND_IDLE_INITIAL_INVALID')
      await writeFile(release, ''); await waitFile(completed, signal); await delay(IDLE_WINDOW_MS, undefined, { signal })
      state.idleWake = state.models.length !== 1
    }
    const observe = async (backend, mode, done, ui, history) => {
      const rows = await readRows(trace), first = rows.find(row => row.first), last = rows.filter(row => row.purpose === 'record').at(-1), state = traffic.get(backend + ':' + mode)
      const values = await Promise.all(effects.map(path => readFile(path, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error })))
      const rawOutputs = history ? history.flatMap(row => row.parts?.filter(part => part.type === 'tool').map(part => ({ id: part.callID, text: part.state?.output })) ?? []) : state?.outputs
      const common = { mode, done, modelCalls: state?.models.length ?? 0, models: state?.models ?? [], ignoredControlVisible: state?.ignoredControlVisible ?? false, ui, hookCalls: rows.length, ownedIdentity: !!first && typeof first.session === 'string' && !!first.session && rows.every(row => row.session === first.session && ['UserPromptSubmit', 'PreToolUse', 'PostToolUse'].includes(row.event)), backgroundEmissions: rows.filter(row => row.first).length, artifacts: dialect === 'claude-code' ? artifactEvidence(last?.rows ?? [], first) : [], rollout: dialect === 'codex' ? rolloutEvidence(last?.rows ?? [], last?.turn) : [] }
      if (idle) {
        const prompts = history ? history.filter(row => row.info?.role === 'user').map(row => row.parts.filter(part => part.type === 'text').map(part => part.text).join('')) : last?.prompts
        return { ...common, idleWake: state?.idleWake, originalPrompts: Array.isArray(prompts) && prompts.length >= 2 && prompts.length <= 3 && prompts.every((text, index) => text === IDLE_PROMPTS[index]) }
      }
      return { ...common, effects: values.filter(value => value !== null), originalResults: TOOL_IDS.every((id, index) => { const owned = rawOutputs?.filter(row => row.id === id) ?? []; return owned.length === 1 && typeof owned[0].text === 'string' && owned[0].text.includes(index ? 'BG_TOOL_TWO' : 'BG_TOOL_ONE') && !(backend === 'host' && (owned[0].text.includes(SYSTEM) || owned[0].text.includes(CONTEXT))) }) }
    }
    if (dialect === 'codex') {
      await writeFile(join(nativeConfig, 'hooks.json'), sourceText)
      await writeFile(join(nativeConfig, 'config.toml'), 'model="fixture"\nmodel_provider="fixture"\napproval_policy="never"\nsandbox_mode="danger-full-access"\n[features]\nhooks=true\n[model_providers.fixture]\nname="Fixture"\nbase_url=' + JSON.stringify(address + '/native/v1') + '\nwire_api="responses"\nrequires_openai_auth=false\nsupports_websockets=false\n')
    }
    const nativeControls = [], hostControls = [], model = dialect === 'claude-code' ? 'claude-sonnet-4-6' : 'fixture'
    for (const mode of modes) {
      stage = 'native-' + mode; await prepare()
      const args = dialect === 'claude-code' ? ['-p', '--output-format', 'json', '--setting-sources', '', '--strict-mcp-config', '--mcp-config', mcp, '--settings', source, '--tools', 'Bash', '--dangerously-skip-permissions', '--max-turns', '4', '--model', model] : ['exec', '--json', '--dangerously-bypass-hook-trust', '--skip-git-repo-check', '--model', model, '-']
      const env = { ...environment(nativeHome, project), ...(dialect === 'claude-code' ? { CLAUDE_CONFIG_DIR: nativeConfig, ANTHROPIC_API_KEY: 'synthetic', ANTHROPIC_BASE_URL: address + '/native' } : { CODEX_HOME: nativeConfig }) }, limits = { durationMs: REQUEST_MS, graceMs: 1000, maxBytes: MAX_BYTES }
      const result = idle ? await runNativeGatedConversation(nativeBinary, [...args.filter(value => value !== '--output-format' && value !== 'json'), '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'], IDLE_PROMPTS, (count, signal) => idleGate('native', count, signal), project, env, limits) : await runNativeProcess(nativeBinary, args, 'BG_CASE:' + mode, project, env, limits)
      const output = dialect === 'claude-code' && !idle ? JSON.parse(result.stdout) : result.stdout.trim().split('\n').map(JSON.parse)
      const done = idle ? output.filter(row => row.type === 'result' && row.is_error === false && row.result?.includes(DONE)).length === IDLE_PROMPTS.length : dialect === 'claude-code' ? output.is_error === false && output.result?.includes(DONE) === true : output.some(row => row.type === 'item.completed' && row.item?.type === 'agent_message' && row.item.text?.includes(DONE))
      const ui = dialect === 'codex' ? output.filter(row => row.type === 'item.completed' && row.item?.type === 'error' && backgroundUiMessage(row.item.message)).map(row => row.item.message) : []
      nativeControls.push(await observe('native', mode, done, ui))
    }
    const password = 'synthetic-background-conformance', options = { sources: [{ id: 'native', dialect, path: source }], reviewedDigests: { native: sourceDigest }, permissionMode: 'bypassPermissions' }
    await writeFile(join(hostConfig, 'opencode.json'), JSON.stringify({ model: 'fixture/' + HOST_MODEL, small_model: 'fixture/' + HOST_MODEL, enabled_providers: ['fixture'], snapshot: false, share: 'disabled', autoupdate: false, permission: 'allow', plugin: [[pathToFileURL(entrypoint).href, options]], provider: { fixture: { npm: '@ai-sdk/openai-compatible', options: { apiKey: 'synthetic', baseURL: address + '/host/v1' }, models: { [HOST_MODEL]: { name: 'Background conformance', limit: { context: 100000, output: 2000 } } } } } }))
    stage = 'host-start'
    child = spawn(opencodeBinary, ['--print-logs', 'serve', '--hostname', '127.0.0.1', '--port', String(await availablePort())], { cwd: project, env: { ...environment(hostHome, project), OPENCODE_CONFIG_DIR: hostConfig, OPENCODE_DISABLE_CLAUDE_CODE: '1', OPENCODE_DISABLE_DEFAULT_PLUGINS: '1', OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_EXTERNAL_SKILLS: '1', OPENCODE_SERVER_PASSWORD: password }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    closed = new Promise(resolve => child.once('close', resolve))
    child.stderr.on('data', chunk => { for (const code of String(chunk).match(/\b(?:HOST|TRANSCRIPT|SESSION_STORE|MODEL|SOURCE|PLUGIN|BACKGROUND)_[A-Z_]+\b/g) ?? []) codes.add(code) })
    const hostAddress = await Promise.race([new Promise((resolve, reject) => { let text = ''; child.once('error', () => reject(new ConformanceError('HOST_START_FAILED'))); child.once('close', () => reject(new ConformanceError('HOST_START_EXITED'))); child.stdout.on('data', chunk => { text = (text + String(chunk)).slice(-MAX_BYTES); const found = /http:\/\/127\.0\.0\.1:\d+/.exec(text)?.[0]; if (found) resolve(found) }) }), new Promise((_, reject) => { timer = setTimeout(() => reject(new ConformanceError('HOST_START_TIMEOUT')), START_MS) })])
    clearTimeout(timer); await initializeHost(hostAddress, project, password)
    const request = async (method, path, body) => {
      let response
      try { response = await fetch(hostAddress + path + '?directory=' + encodeURIComponent(project), { method, headers: { 'content-type': 'application/json', authorization: 'Basic ' + Buffer.from('opencode:' + password).toString('base64') }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(REQUEST_MS) }) }
      catch (error) { throw new ConformanceError('BACKGROUND_HOST_REQUEST_FAILED: method=' + method + ' cause=' + (['TimeoutError', 'AbortError', 'TypeError'].includes(error?.name) ? error.name : 'UNKNOWN')) }
      try { return { ok: response.ok, data: await response.json() } }
      catch { throw new ConformanceError('BACKGROUND_HOST_RESPONSE_INVALID: method=' + method + ' status=' + response.status) }
    }
    eventController = new AbortController(); ({ done: eventsDone } = await observeEvents(hostAddress, project, password, eventController.signal, warnings))
    for (const mode of modes) {
      stage = 'host-' + mode; await prepare()
      const session = await request('POST', '/session', {}); ensure(session.ok && typeof session.data?.id === 'string', 'HOST_CREATE_FAILED')
      const results = []
      for (const text of idle ? IDLE_PROMPTS : ['BG_CASE:' + mode]) {
        results.push(await request('POST', '/session/' + session.data.id + '/message', { model: { providerID: 'fixture', modelID: HOST_MODEL }, parts: [{ type: 'text', text }] }))
        if (idle) await idleGate('host', results.length, AbortSignal.timeout(START_MS))
      }
      const history = await request('GET', '/session/' + session.data.id + '/message'); ensure(history.ok && Array.isArray(history.data), 'BACKGROUND_HISTORY_UNAVAILABLE')
      hostControls.push(await observe('host', mode, results.every(result => result.ok && result.data?.parts?.some(part => part.type === 'text' && part.text.includes(DONE)) === true), [...warnings], history.data))
      const deleted = await request('DELETE', '/session/' + session.data.id); ensure(deleted.ok, 'BACKGROUND_SESSION_DELETE_FAILED')
    }
    stage = 'integrity'
    ensure(!errors.length, 'BACKGROUND_GATEWAY_FAILED: ' + [...new Set(errors)].join(','))
    ensure(hash(await readFile(source)) === sourceDigest && (dialect !== 'codex' || hash(await readFile(join(nativeConfig, 'hooks.json'))) === sourceDigest), 'CONFORMANCE_SOURCE_CHANGED')
    ensure(hash(await readFile(helper)) === hash(helperText), 'CONFORMANCE_HOOK_CHANGED')
    ensure(await fingerprintAdapter(packageRoot) === adapterBuildSha256, 'CONFORMANCE_BUILD_CHANGED')
    return { caseID: (dialect === 'claude-code' ? 'claude' : 'codex') + '.background.' + delivery, host: 'v1', nativeVersion, hostVersion, adapterBuildSha256, ...(idle ? compareBackgroundIdleEvidence(nativeControls, hostControls) : compareBackgroundEvidence(dialect, nativeControls, hostControls)), platform: process.platform, architecture: process.arch, diagnostics: [...codes].sort(), isolation: { temporaryHomeAndConfig: true, loopbackProvider: true, sourceBytesUnchanged: true, nativeTrustVerified: false, nativePermissionBypass: true, machineManagedSettingsMayRemain: true }, limits: [idle ? 'Ordinary Claude UserPromptSubmit background context after completion while idle, with a bounded no-wake observation and later genuine prompts' : 'Ordinary active-turn command hooks, bounded synthetic shell tools and selected output branches only', 'No real model account is used; warning evidence covers native CLI error items and stock server toast emission, not complete TUI presentation', 'Cold restart, Codex idle next-turn delivery, other events, trust, provider variants and V2 require separate proof'] }
  } catch (error) {
    const code = error instanceof ConformanceError ? error.message : typeof error?.code === 'string' && /^[A-Z][A-Z_0-9]{1,47}$/.test(error.code) ? error.code : 'UNKNOWN'
    const frame = error instanceof Error ? error.stack?.split('\n').find(line => line.includes('conformance-background.mjs:')) : undefined
    const line = frame && /:(\d+):\d+\)?$/.exec(frame)?.[1]
    throw new ConformanceError('CONFORMANCE_BACKGROUND_FAILED: ' + dialect + '/' + delivery + '/' + stage + ' system=' + code + (line ? ' check=conformance-background.mjs:' + line : '') + ' codes=' + [...codes].sort().join(','), error instanceof ConformanceError ? error.status : 1)
  } finally {
    clearTimeout(timer); eventController?.abort()
    try { await eventsDone } finally { try { await stopHost(child, closed) } finally { try { if (gateway) { gateway.closeAllConnections(); await new Promise(resolve => gateway.close(resolve)) } } finally { await rm(root, { recursive: true, force: true }) } } }
  }
}
