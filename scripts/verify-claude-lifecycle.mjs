#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { parseArgs, promisify } from 'node:util'
import { NativeProbeError as ProbeError, NATIVE_CLAUDE_LIMITS as LIMITS, runNativeClaude } from './lib/native-claude.mjs'

const VERSION = '2.1.318'
const MODEL = 'claude-sonnet-4-6'
const MAX_REQUESTS = 12
const SLOW_HOOK_MS = 400
const FAST_HOOK_MS = 20
const FUNCTION_OUTPUT = 'NATIVE_LIFECYCLE_FUNCTION'
const SOURCES = Object.freeze(['startup', 'resume'])
const REJECTED_HANDLERS = Object.freeze([
  { type: 'prompt', prompt: 'NATIVE_LIFECYCLE_REJECTED_PROMPT', onFailure: 'block' },
  { type: 'agent', prompt: 'NATIVE_LIFECYCLE_REJECTED_AGENT', onFailure: 'block' },
  { type: 'mcp_tool', server: 'missing', tool: 'missing', input: {}, onFailure: 'block' },
])
const RESUME_MODES = new Set(['id', 'path'])
const SELECTIONS = Object.freeze({
  stable: { startup: ['a', 'b'], resume: ['a', 'b'] },
  fewer: { startup: ['a', 'b'], resume: ['a'] },
  more: { startup: ['a'], resume: ['a', 'b'] },
})
const STARTUP_ENVIRONMENT = Object.freeze({ tick: '1', dynamic: 'from-pretool', generation: 'startup' })
const RESUME_ENVIRONMENT = Object.freeze({ id: { tick: '2', dynamic: 'from-pretool', generation: 'resume' }, path: { tick: '1', dynamic: 'updated', generation: 'startup' } })
const run = promisify(execFile)
const quote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'"
const marker = (source, mode) => `NATIVE_LIFECYCLE_${source}_CONTEXT_${mode}`
const prompt = source => `NATIVE_LIFECYCLE_${source}_PROMPT: inspect the synthetic environment`
const HELP = `Usage: node scripts/verify-claude-lifecycle.mjs [-b PATH] [-r id|path] [-s MODE]

Verify Claude Code ${VERSION} SessionStart startup/resume ordering, per-handler
environment files, shell code, functions and native transcript/model delivery.

Requires Node.js 22+, POSIX and the pinned Claude executable. Uses isolated
HOME/config/project state, synthetic credentials and a loopback provider.
No build, model account, installation or live configuration change is needed.

Options:
  -b, --binary PATH  Claude executable (CLAUDE_BINARY, then claude)
  -r, --resume-mode MODE  Resume by session id (default) or transcript path
  -s, --selection-mode MODE  stable (default), fewer or more handlers on resume
  -h, --help         Show help without requiring a binary

Metadata-only JSON goes to stdout. Diagnostics go to stderr without native
output, commands, environment values, provider traffic or local paths.
Exit status: 0 native fixture verified; 1 runtime/check failure;
2 usage/version/platform precondition; 3 missing dependency.
Temporary state is removed. This is a native oracle: bridge lifecycle comparison
and remaining native events are separate gates, and equivalent remains false.
`

async function lines(path) {
  const value = await readFile(path)
  if (value.length > LIMITS.maxBytes) throw new ProbeError('NATIVE_ARTIFACT_LIMIT')
  return value.toString('utf8').trim().split('\n').map(line => JSON.parse(line))
}

function textParts(messages) {
  return messages.flatMap(message => (typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content).filter(part => part.type === 'text').map(part => ({ role: message.role, text: part.text })))
}

function validate(source, events, rows, requests, shellRows, commands, resumeMode, selectionMode) {
  const selected = SELECTIONS[selectionMode][source]
  const completion = selected.length === 1 ? ['a'] : ['b', 'a']
  const trace = events.filter(event => event.source === source)
  const started = trace.filter(event => event.phase === 'start' && event.input.hook_event_name === 'SessionStart')
  const completed = trace.filter(event => event.phase === 'end' && event.input.hook_event_name === 'SessionStart').sort((a, b) => a.time - b.time)
  assert.equal(started.length, selected.length)
  assert.deepEqual(completed.map(event => event.mode), completion)
  assert.ok(Math.max(...started.map(event => event.time)) <= Math.min(...completed.map(event => event.time)))
  assert.ok(started.every(event => event.input.source === source && event.envFile && event.envExists === (source === 'resume' && resumeMode === 'id' && SELECTIONS[selectionMode].startup.includes(event.mode)) && event.transcriptExists === (source === 'resume')))
  assert.ok(started.every(event => event.input.session_id === started[0].input.session_id))
  assert.deepEqual([...started].sort((a, b) => a.mode.localeCompare(b.mode)).map(event => basename(event.envFile)), selected.length === 1 ? ['sessionstart-hook-0.sh'] : ['sessionstart-hook-0.sh', 'sessionstart-hook-1.sh'])
  assert.equal(new Set(started.map(event => dirname(event.envFile))).size, 1)
  assert.ok(trace.every(event => Object.keys(event.variables).length === 0))
  assert.ok(trace.filter(event => event.input.hook_event_name !== 'SessionStart').every(event => !event.envFile))
  const submitted = trace.find(event => event.phase === 'start' && event.input.hook_event_name === 'UserPromptSubmit')
  assert.ok(submitted && submitted.time >= completed.at(-1).time)
  const model = requests.filter(request => request.source === source)
  assert.equal(model.length, 3)
  assert.ok(model[0].time >= completed.at(-1).time)
  const context = textParts(model[0].messages).filter(part => part.text.includes(`NATIVE_LIFECYCLE_${source}_CONTEXT_`))
  const expected = completion.map(mode => `<system-reminder>\nSessionStart:${source} hook success: ${marker(source, mode)}\n</system-reminder>`)
  assert.deepEqual(context.map(part => part.role), selected.length === 1 ? ['user'] : ['user', 'user'])
  assert.deepEqual(context.map(part => part.text), expected)
  const original = textParts(model[0].messages).findIndex(part => part.text.includes(prompt(source)))
  const parts = textParts(model[0].messages)
  assert.ok(parts.findIndex(part => part.text === expected.at(-1)) < original)
  const records = rows.filter(row => row.attachment?.hookEvent === 'SessionStart' && row.attachment.hookName === `SessionStart:${source}`)
  const rejectionTypes = source === 'startup' ? REJECTED_HANDLERS.map(() => 'hook_non_blocking_error') : []
  assert.deepEqual(records.map(row => row.attachment.type), [...rejectionTypes, ...completion.map(() => 'hook_success')])
  assert.equal(new Set(records.map(row => row.attachment.toolUseID)).size, 1)
  assert.equal(typeof records[0].attachment.toolUseID, 'string')
  assert.ok(records[0].attachment.toolUseID.length > 0)
  const user = rows.findIndex(row => row.type === 'user' && JSON.stringify(row.message?.content).includes(prompt(source)))
  for (const row of records) {
    assert.equal(row.type, 'attachment')
    assert.ok(!Number.isNaN(Date.parse(row.timestamp)))
    assert.ok(user > rows.indexOf(row))
  }
  const failures = rows.filter(row => row.attachment?.hookEvent === 'SessionStart' && row.attachment.type === 'hook_non_blocking_error')
  assert.equal(failures.length, REJECTED_HANDLERS.length)
  assert.equal(new Set(failures.map(row => row.attachment.toolUseID)).size, 1)
  for (const [index, handler] of REJECTED_HANDLERS.entries()) {
    const row = failures[index]
    assert.deepEqual(row.attachment, {
      type: 'hook_non_blocking_error', hookEvent: 'SessionStart', hookName: 'SessionStart:startup', toolUseID: failures[0].attachment.toolUseID,
      stdout: '', exitCode: 1,
      stderr: handler.type === 'mcp_tool' ? "mcp_tool hooks are not available for the 'SessionStart' hook event (no MCP client context)" : `Failed to run: ${handler.type}-type hooks are not supported for SessionStart events (no conversation context is available). Use a command-type hook instead.`,
      ...(handler.type === 'mcp_tool' ? {} : { command: handler.prompt, durationMs: 0 }),
    })
    assert.equal(Object.hasOwn(row, 'rendered'), false)
    assert.equal(Object.hasOwn(row, 'renderedRole'), false)
    for (const request of model) for (const part of textParts(request.messages)) {
      assert.equal(part.text.includes(row.attachment.stderr), false)
      if (handler.prompt) assert.equal(part.text.includes(handler.prompt), false)
    }
  }
  const successes = records.slice(rejectionTypes.length)
  assert.deepEqual(successes.map(row => row.attachment.content), completion.map(mode => marker(source, mode)))
  for (const [index, row] of successes.entries()) {
    const mode = completion[index]
    assert.equal(row.attachment.type, 'hook_success')
    assert.equal(row.attachment.command, commands[mode])
    assert.equal(row.attachment.stdout, marker(source, mode) + '\n')
    assert.equal(row.attachment.stderr, '')
    assert.equal(row.attachment.exitCode, 0)
    assert.ok(Number.isFinite(row.attachment.durationMs) && row.attachment.durationMs >= 0)
    assert.deepEqual(row.rendered, [{ content: expected[index] }])
    assert.equal(row.renderedRole, 'system')
  }
  for (const index of [1, 2]) {
    const id = `lifecycle-${source}-${index}`
    const shell = shellRows.find(row => row.id === id)
    assert.ok(shell)
    const hasB = SELECTIONS[selectionMode].startup.includes('b') || source === 'resume' && resumeMode === 'id' && SELECTIONS[selectionMode].resume.includes('b')
    assert.deepEqual(shell.variables, { a: 'alpha', ...(hasB ? { b: 'beta' } : {}), shared: hasB ? 'from-b' : 'from-a', ...(source === 'startup' ? STARTUP_ENVIRONMENT : RESUME_ENVIRONMENT[resumeMode]) })
    const result = model.flatMap(request => request.messages).flatMap(message => Array.isArray(message.content) ? message.content : []).find(part => part.type === 'tool_result' && part.tool_use_id === id)
    assert.ok(result && result.is_error !== true && JSON.stringify(result.content).includes(FUNCTION_OUTPUT))
  }
  return { sessionID: started[0].input.session_id, directory: dirname(started[0].envFile), failures: failures.map(row => row.uuid) }
}

async function verify(binary, resumeMode, selectionMode) {
  if (process.platform === 'win32') throw new ProbeError('PLATFORM_UNAVAILABLE: POSIX process groups', 2)
  let version
  try { version = (await run(binary, ['--version'], { timeout: LIMITS.durationMs, maxBuffer: LIMITS.maxBytes })).stdout.trim() } catch (error) { throw new ProbeError(error.code === 'ENOENT' || error.code === 'EACCES' ? 'DEPENDENCY_UNAVAILABLE: Claude Code' : 'DEPENDENCY_QUERY_FAILED: Claude Code', error.code === 'ENOENT' || error.code === 'EACCES' ? 3 : 1) }
  if (version !== VERSION && !version.startsWith(VERSION + ' ')) throw new ProbeError('NATIVE_VERSION_MISMATCH', 2)
  const root = await realpath(await mkdtemp(join(tmpdir(), 'harness-native-lifecycle-')))
  let gateway
  let stage = 'setup'
  try {
    const project = join(root, 'project'), home = join(root, 'home'), config = join(root, 'config')
    const trace = join(root, 'trace.jsonl'), shellTrace = join(root, 'shell.jsonl'), evaluations = join(root, 'evaluations.jsonl')
    await Promise.all([mkdir(project), mkdir(home), mkdir(config)])
    const hook = join(root, 'hook.cjs'), shellProbe = join(root, 'shell.cjs')
    const envA = `export SESSION_A=alpha\nexport SESSION_SHARED=from-a\nexport SESSION_TICK=$(( SESSION_TICK + 1 ))\nexport SESSION_DYNAMIC=initial\nprintf '%s\\n' '{"type":"source"}' >> "$PROBE_EVALUATIONS"\nfixture_function(){ printf ${FUNCTION_OUTPUT}; }\n`
    const envB = 'export SESSION_B=beta\nexport SESSION_SHARED=from-b\n'
    await writeFile(hook, `const fs=require('node:fs');const input=JSON.parse(fs.readFileSync(0,'utf8'));const mode=process.argv[2];const source=process.env.PROBE_SOURCE;const log=phase=>fs.appendFileSync(process.env.PROBE_TRACE,JSON.stringify({source,phase,mode,input,time:Date.now(),envFile:process.env.CLAUDE_ENV_FILE,envExists:!!process.env.CLAUDE_ENV_FILE&&fs.existsSync(process.env.CLAUDE_ENV_FILE),transcriptExists:fs.existsSync(input.transcript_path),variables:{a:process.env.SESSION_A,b:process.env.SESSION_B,shared:process.env.SESSION_SHARED,tick:process.env.SESSION_TICK}})+'\\n');log('start');if(input.hook_event_name==='SessionStart'){fs.writeFileSync(process.env.PROBE_BARRIER+'-'+mode,'ready');const timer=setInterval(()=>{if(JSON.parse(process.env.PROBE_PARTICIPANTS).some(peer=>!fs.existsSync(process.env.PROBE_BARRIER+'-'+peer)))return;clearInterval(timer);setTimeout(()=>{fs.appendFileSync(process.env.CLAUDE_ENV_FILE,mode==='a'?${JSON.stringify(envA)}+'export SESSION_GENERATION='+source+'\\n':${JSON.stringify(envB)});log('end');console.log('NATIVE_LIFECYCLE_'+source+'_CONTEXT_'+mode)},mode==='a'?${SLOW_HOOK_MS}:${FAST_HOOK_MS})},10)}else{if(input.hook_event_name==='UserPromptSubmit'||input.hook_event_name==='PreToolUse'&&input.tool_use_id.endsWith('-1')){const records=fs.readFileSync(process.env.PROBE_TRACE,'utf8').trim().split('\\n').map(JSON.parse);const owned=records.find(row=>row.source===source&&row.mode==='a'&&row.input.hook_event_name==='SessionStart');fs.appendFileSync(owned.envFile,'export SESSION_DYNAMIC='+(input.hook_event_name==='UserPromptSubmit'?'from-prompt':'from-pretool')+'\\n')}if(input.hook_event_name==='PreToolUse')fs.writeFileSync(process.env.PROBE_CAPTURE,fs.readFileSync(input.transcript_path));log('end')}`)
    await writeFile(shellProbe, `const fs=require('node:fs');const id=process.argv[2];fs.appendFileSync(process.env.PROBE_SHELL_TRACE,JSON.stringify({id,variables:{a:process.env.SESSION_A,b:process.env.SESSION_B,shared:process.env.SESSION_SHARED,tick:process.env.SESSION_TICK,dynamic:process.env.SESSION_DYNAMIC,generation:process.env.SESSION_GENERATION}})+'\\n');if(id.endsWith('-1')){const source=id.split('-')[1];const entry=fs.readFileSync(process.env.PROBE_TRACE,'utf8').trim().split('\\n').map(JSON.parse).find(row=>row.source===source&&row.mode==='a'&&row.input.hook_event_name==='SessionStart');fs.appendFileSync(entry.envFile,'export SESSION_DYNAMIC=updated\\n')}`)
    await Promise.all([hook, shellProbe].map(path => run(process.execPath, ['--check', path], { timeout: LIMITS.durationMs, maxBuffer: LIMITS.maxBytes })))
    const handler = mode => ({ type: 'command', command: process.execPath, args: [hook, mode], timeout: 3 })
    const settings = join(root, 'settings.json'), mcp = join(root, 'mcp.json')
    const inactiveHttp = { type: 'http', url: '' }
    const nonexecuting = [inactiveHttp, ...REJECTED_HANDLERS, ...REJECTED_HANDLERS.map(hook => ({ ...hook, if: 'Bash(*)' })), { ...handler('conditional'), if: 'Bash(*)' }]
    const startGroups = selectionMode === 'stable' ? [{ hooks: [...nonexecuting, handler('a'), handler('b')] }] : SOURCES.map(source => ({ matcher: source, hooks: [...nonexecuting, ...SELECTIONS[selectionMode][source].map(handler)] }))
    await writeFile(mcp, '{"mcpServers":{}}')
    const requests = []
    let source = 'startup'
    let count = 0
    let inactiveHttpRequests = 0
    gateway = createServer(async (request, response) => {
      try {
        const chunks = []
        let bytes = 0
        for await (const chunk of request) { bytes += chunk.length; if (bytes > LIMITS.maxBytes) throw new Error(); chunks.push(chunk) }
        if (request.url === '/inactive-hook') { inactiveHttpRequests++; response.setHeader('content-type', 'application/json'); response.end('{}'); return }
        if (request.url.includes('/count_tokens')) { response.setHeader('content-type', 'application/json'); response.end('{"input_tokens":1}'); return }
        if (!request.url.includes('/messages')) { response.writeHead(404); response.end('{}'); return }
        if (requests.length >= MAX_REQUESTS) throw new Error()
        const body = JSON.parse(Buffer.concat(chunks).toString())
        requests.push({ source, time: Date.now(), messages: body.messages }); count++
        if (count === 1) { const events = await lines(trace); const entry = events.find(row => row.source === source && row.mode === 'a' && row.input.hook_event_name === 'SessionStart'); await writeFile(entry.envFile, 'export SESSION_DYNAMIC=from-provider\n', { flag: 'a' }) }
        const tool = count <= 2
        const id = `lifecycle-${source}-${count}`
        const block = tool ? { type: 'tool_use', id, name: 'Bash', input: { command: quote(process.execPath) + ' ' + quote(shellProbe) + ' ' + quote(id) + '; fixture_function', description: 'Synthetic environment inspection' } } : { type: 'text', text: 'Fixture done' }
        const stop = tool ? 'tool_use' : 'end_turn'
        const message = { id, type: 'message', role: 'assistant', content: [block], model: body.model, stop_reason: stop, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }
        if (!body.stream) { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(message)); return }
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        const emit = (type, value) => response.write('event: ' + type + '\ndata: ' + JSON.stringify({ type, ...value }) + '\n\n')
        emit('message_start', { message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } })
        emit('content_block_start', { index: 0, content_block: tool ? { ...block, input: {} } : { type: 'text', text: '' } })
        emit('content_block_delta', { index: 0, delta: tool ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } : { type: 'text_delta', text: block.text } })
        emit('content_block_stop', { index: 0 }); emit('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 1 } }); emit('message_stop', {}); response.end()
      } catch { if (!response.headersSent) response.writeHead(500); response.end('{}') }
    })
    await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve))
    inactiveHttp.url = 'http://127.0.0.1:' + gateway.address().port + '/inactive-hook'
    await writeFile(settings, JSON.stringify({ hooks: { SessionStart: startGroups, UserPromptSubmit: [{ hooks: [handler('prompt')] }], PreToolUse: [{ hooks: [handler('tool')] }], PostToolUse: [{ hooks: [handler('post')] }] } }))
    const env = { PATH: process.env.PATH, TZ: process.env.TZ, HOME: home, CLAUDE_CONFIG_DIR: config, SHELL: '/bin/sh', PROBE_TRACE: trace, PROBE_SHELL_TRACE: shellTrace, PROBE_EVALUATIONS: evaluations, ANTHROPIC_API_KEY: 'synthetic', ANTHROPIC_BASE_URL: 'http://127.0.0.1:' + gateway.address().port, DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_NON_ESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1' }
    const args = ['-p', '--output-format', 'json', '--setting-sources', '', '--strict-mcp-config', '--mcp-config', mcp, '--settings', settings, '--tools', 'Bash', '--allowedTools', 'Bash', '--model', MODEL]
    let resumePath
    const results = []
    for (source of SOURCES) {
      stage = source; count = 0
      const capture = join(root, source + '.jsonl')
      await runNativeClaude(binary, [...args, ...(resumePath ? ['--resume', resumePath] : [])], prompt(source), project, { ...env, PROBE_SOURCE: source, PROBE_PARTICIPANTS: JSON.stringify(SELECTIONS[selectionMode][source]), PROBE_BARRIER: join(root, source), PROBE_CAPTURE: capture })
      const events = await lines(trace)
      const initial = events.find(event => event.source === source)
      assert.ok(initial.input.transcript_path.startsWith(config + '/'))
      resumePath = resumeMode === 'id' ? initial.input.session_id : initial.input.transcript_path
      const commands = Object.fromEntries(['a', 'b'].map(mode => [mode, [process.execPath, ...handler(mode).args].join(' ')]))
      results.push(validate(source, events, await lines(capture), requests, await lines(shellTrace), commands, resumeMode, selectionMode))
      assert.equal(inactiveHttpRequests, 0)
      assert.equal((await lines(evaluations)).length, results.length * 2 + (source === 'resume' && resumeMode === 'id' ? 2 : 0))
      const writer = events.find(event => event.source === source && event.mode === 'a' && event.input.hook_event_name === 'SessionStart')
      const content = await readFile(writer.envFile, 'utf8')
      for (const value of ['from-prompt', 'from-provider', 'from-pretool', 'updated']) assert.ok(content.includes('export SESSION_DYNAMIC=' + value + '\n'))
    }
    assert.equal(results[0].sessionID, results[1].sessionID)
    assert.equal(results[0].directory === results[1].directory, resumeMode === 'id')
    assert.deepEqual(results[0].failures, results[1].failures)
    return { claude: VERSION, mode: 'headless', sources: SOURCES, resumeMode, selectionMode, nativeConcurrentStartup: SELECTIONS[selectionMode].startup.length > 1, nativeConcurrentResume: SELECTIONS[selectionMode].resume.length > 1, completionOrderedContext: true, configuredEnvironmentOrder: true, perHandlerEnvironmentFiles: true, nonexecutingHandlersExcludedFromOrdinals: true, inactiveHttpNotInvoked: true, startupRejectionsRecorded: true, startupRejectionsNonblocking: true, repeatedStartupFailuresNotReattachedOnResume: true, nativeConditionSkipsUnrecorded: true, freshResumeEnvironmentNamespace: resumeMode === 'path', resumeEnvironmentGeneration: resumeMode === 'id' ? 'current-activation' : 'prior-activation', resumeEnvironmentFilesAppended: resumeMode === 'id', retainedFilesReplayedOnShorterSelection: resumeMode === 'id' && selectionMode === 'fewer', hookEnvironmentIsolated: true, firstPromptAndModelWait: true, shellFunctionsAndRepeatedCommands: true, shellCodeReplayedPerCommand: true, startupPreToolEnvironmentEditsApplied: true, laterEnvironmentEditsNotRefreshed: true, nativeTranscriptAndContext: true, bridgeLifecycleComparison: 'not-implemented', equivalent: false }
  } catch (error) { if (error instanceof ProbeError) throw error; throw new ProbeError('LIFECYCLE_CHECK_FAILED: ' + stage) } finally {
    if (gateway) { gateway.closeAllConnections(); await new Promise(resolve => gateway.close(resolve)) }
    await rm(root, { recursive: true, force: true })
  }
}

try {
  let parsed
  try { parsed = parseArgs({ options: { binary: { type: 'string', short: 'b' }, 'resume-mode': { type: 'string', short: 'r' }, 'selection-mode': { type: 'string', short: 's' }, help: { type: 'boolean', short: 'h' } }, strict: true, allowPositionals: false }) } catch { throw new ProbeError('USAGE_INVALID: use --help', 2) }
  if (parsed.values.help) process.stdout.write(HELP)
  else {
    const binary = parsed.values.binary ?? process.env.CLAUDE_BINARY ?? 'claude'
    const resumeMode = parsed.values['resume-mode'] ?? 'id'
    const selectionMode = parsed.values['selection-mode'] ?? 'stable'
    if (!binary.trim()) throw new ProbeError('USAGE_BINARY_EMPTY', 2)
    if (!RESUME_MODES.has(resumeMode)) throw new ProbeError('USAGE_RESUME_MODE: expected id or path', 2)
    if (!Object.hasOwn(SELECTIONS, selectionMode)) throw new ProbeError('USAGE_SELECTION_MODE: expected stable, fewer or more', 2)
    process.stdout.write(JSON.stringify(await verify(binary, resumeMode, selectionMode)) + '\n')
  }
} catch (error) { process.stderr.write((error instanceof ProbeError ? error.message : 'LIFECYCLE_PROBE_FAILED') + '\n'); process.exitCode = error instanceof ProbeError ? error.status : 1 }
