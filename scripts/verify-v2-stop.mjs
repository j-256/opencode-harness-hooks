#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { access, mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs, promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const PINNED_VERSION = '2.2.5'
const STARTUP_MS = 10000
const CLIENT_MS = 20000
const SHUTDOWN_MS = 2000
const MAX_REQUESTS = 4
const COMMAND_DELAY_MS = 2000
const CONTROL_POLL_MS = 10
const CANCELLATION_STAGES = Object.freeze({ DURING_HOOK: 'during-hook', AFTER_FEEDBACK: 'after-feedback', PENDING_ACK: 'pending-ack' })
const STAGES = new Set(Object.values(CANCELLATION_STAGES))
const CORE = new URL('../dist/core.js', import.meta.url).href
const TRANSPORT = new URL('../dist/prompt-contexts.js', import.meta.url).href
const PACKAGE_DIRECTORY = fileURLToPath(new URL('..', import.meta.url))
const MAX_BYTES = 2 * 1024 * 1024
const run = promisify(execFile)
const HELP = `Usage: node scripts/verify-v2-stop.mjs [-b PATH] [--default-root [--history|--cancellation]]

Verify the explicit core Stop service against OpenCode ${PINNED_VERSION} using an
unchanged Claude command, owned synthetic history and exact model text blocks.
This is a foreground core integration fixture, not default-root Stop equivalence.
The historical --default-root modes require the unfinished completion adapter
and fail against the rejecting default package. Use verify-plugin.mjs with
--host v2 --stop-rejection for stock-host acceptance. Reports retain equivalent:false.
Uses isolated HOME/config/state and a loopback provider; live settings stay intact.

Options:
  -b, --binary PATH  OpenCode executable (OPENCODE_V2_BINARY, then opencode)
      --default-root  Load the actual package with an independent observer plugin
      --history       Compare retained output at later real prompts (default root)
      --cancellation  Interrupt Stop processing (default root, no history)
      --cancellation-stage NAME  during-hook (default), after-feedback or pending-ack
  -h, --help         Show help without dependencies or a package build

Requires Node.js 22+, POSIX, Git, npm run build and the pinned host executable.
No installation or upgrade is performed. Metadata-only JSON goes to stdout;
failures go to stderr without native output, commands or local paths.
The pending-ack stage calls the default setup through a controlled SDK return
delay. It reports that boundary separately from untouched package loading.
Exit status: 0 exercised checks pass; 1 runtime/check; 2 usage/version/platform;
3 missing dependency or package build. The report retains equivalent:false.
`

class ProbeError extends Error {
  constructor(code, status = 1) { super(code); this.status = status }
}
function check(condition, code) { if (!condition) throw new ProbeError(code) }
async function bounded(promise, timeoutMs, code) {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new ProbeError(code)), timeoutMs) })]) } finally { clearTimeout(timer) }
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

async function dependency(program, args, name) {
  try { return await run(program, args, { timeout: STARTUP_MS, maxBuffer: MAX_BYTES }) } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'EACCES') throw new ProbeError('DEPENDENCY_UNAVAILABLE: ' + name, 3)
    throw new ProbeError('DEPENDENCY_QUERY_FAILED: ' + name)
  }
}

async function verify(binary, defaultRoot, historical, cancelled = false, stage = CANCELLATION_STAGES.DURING_HOOK) {
  const pendingAck = cancelled && stage === CANCELLATION_STAGES.PENDING_ACK
  const afterFeedback = cancelled && stage !== CANCELLATION_STAGES.DURING_HOOK
  if (process.platform === 'win32' || Number(process.versions.node.split('.')[0]) < 22) throw new ProbeError('PLATFORM_UNAVAILABLE: Node.js 22+ and POSIX required', 2)
  const version = (await dependency(binary, ['--version'], 'OpenCode')).stdout.trim().replace(/^opencode v/, '')
  if (version !== PINNED_VERSION) throw new ProbeError('HOST_VERSION_MISMATCH: expected ' + PINNED_VERSION, 2)
  await dependency('git', ['--version'], 'Git')
  try { await Promise.all([access(new URL(CORE)), access(new URL(TRANSPORT))]) } catch { throw new ProbeError('DEPENDENCY_UNAVAILABLE: run npm run build', 3) }
  const root = await realpath(await mkdtemp(join(tmpdir(), 'harness-v2-stop-')))
  let gateway
  let host
  let hostDone
  try {
    const project = join(root, 'project')
    const config = join(root, 'config/opencode')
    const plugin = join(root, 'plugin')
    const trace = join(root, 'trace.jsonl')
    await Promise.all([mkdir(project), mkdir(config, { recursive: true }), mkdir(plugin)])
    const env = {
      PATH: process.env.PATH, SHELL: '/bin/sh', LANG: 'en_US.UTF-8', TMPDIR: process.env.TMPDIR,
      HOME: root, PWD: project, XDG_CONFIG_HOME: join(root, 'config'), XDG_STATE_HOME: join(root, 'state'), XDG_DATA_HOME: join(root, 'data'), XDG_CACHE_HOME: join(root, 'cache'),
      OPENCODE_CONFIG_DIR: config, OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_CLAUDE_CODE: '1', OPENCODE_DISABLE_EXTERNAL_SKILLS: '1', OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_DEFAULT_PLUGINS: '1',
      OPENCODE_PASSWORD: randomBytes(32).toString('base64url'),
    }
    await run('git', ['init', '-q', project], { env, timeout: STARTUP_MS })
    const requests = []
    const feedbackStarted = join(root, 'feedback-provider-started')
    const ackRelease = join(root, 'release-ack')
    gateway = createServer(async (req, res) => {
      try {
        const chunks = []
        let bytes = 0
        for await (const chunk of req) {
          bytes += chunk.length
          if (bytes > MAX_BYTES) { res.writeHead(413); res.end(); return }
          chunks.push(chunk)
        }
        if (requests.length >= MAX_REQUESTS) { res.writeHead(429); res.end(); return }
        const body = JSON.parse(Buffer.concat(chunks).toString())
        const continued = JSON.stringify(body.messages).includes(historical || cancelled ? 'LATER_NEXT_PROMPT' : 'V2_STOP_FEEDBACK')
        requests.push({ at: Date.now(), kind: String(req.headers['x-harness-request-kind'] ?? ''), continued, privateHeaderPresent: Object.hasOwn(req.headers, 'x-opencode-harness-hooks-request'), messages: body.messages })
        const message = { role: 'assistant', content: continued ? 'V2_SECOND_ANSWER' : 'V2_FIRST_ANSWER' }
        const chunk = (delta, finish_reason) => ({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason }] })
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        if (afterFeedback && !pendingAck && requests.filter(row => row.kind === 'primary').length === 2) { res.flushHeaders(); await writeFile(feedbackStarted, 'started'); return }
        res.end('data: ' + JSON.stringify(chunk(message, null)) + '\n\ndata: ' + JSON.stringify({ ...chunk({}, 'stop'), usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }) + '\n\ndata: [DONE]\n\n')
      } catch { if (!res.headersSent) res.writeHead(500); res.end() }
    })
    await new Promise((resolve, reject) => { gateway.once('error', reject); gateway.listen(0, '127.0.0.1', resolve) })
    const sourcePath=join(root,'native-hooks.json'), hookScript=join(root,'native-hook.cjs'), hookTrace=join(root,'native-hooks.jsonl')
    const finishedPath = join(root, 'interrupted-command-finished')
    const decision = afterFeedback ? `if(!ordinal)console.log(JSON.stringify({decision:'block',reason:'CANCEL_STOP_FEEDBACK',hookSpecificOutput:{hookEventName:'Stop',additionalContext:'CANCEL_STOP_CONTEXT'}}));` : cancelled ? `if(!ordinal)setTimeout(()=>{fs.writeFileSync(${JSON.stringify(finishedPath)},'finished');console.log(JSON.stringify({decision:'block',reason:'UNADMITTED_STOP_OUTPUT'}))},${COMMAND_DELAY_MS});` : historical ? `if(!ordinal)console.log(JSON.stringify(${JSON.stringify(historical.output)}));` : `if(!p.stop_hook_active)console.log(JSON.stringify({decision:'block',reason:'V2_STOP_FEEDBACK',hookSpecificOutput:{hookEventName:'Stop',additionalContext:'V2_STOP_CONTEXT'}}));`
    await writeFile(hookScript, `const fs=require('node:fs');const p=JSON.parse(fs.readFileSync(0,'utf8'));if(p.hook_event_name==='UserPromptSubmit'){if(p.prompt==='LATER_NEXT_PROMPT')console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'UserPromptSubmit',additionalContext:${JSON.stringify(historical?.promptContext ?? '')}}}));return}const ordinal=fs.existsSync(${JSON.stringify(hookTrace)})?fs.readFileSync(${JSON.stringify(hookTrace)},'utf8').trim().split('\\n').length:0;const rows=fs.readFileSync(p.transcript_path,'utf8').trim().split('\\n').map(JSON.parse);fs.appendFileSync(${JSON.stringify(hookTrace)},JSON.stringify({...p,fixtureRecords:rows,fixturePID:process.pid})+'\\n');if(rows.at(-1).message.role!=='assistant')throw new Error('Missing completed assistant');${decision}`)
    const command={type:'command',command:process.execPath,args:[hookScript]}
    const dialect='claude-code'
    const native=JSON.stringify({hooks:{Stop:[{hooks:[command]}],...(historical?.promptContext?{UserPromptSubmit:[{hooks:[command]}]}:{})}})
    await run(process.execPath,['--check',hookScript],{timeout:STARTUP_MS,maxBuffer:MAX_BYTES})
    await writeFile(sourcePath,native)
    const sourceSnapshot = await readFile(sourcePath), scriptSnapshot = await readFile(hookScript)
    const options={sources:[{id:'native',dialect,path:sourcePath}],reviewedDigests:{native:createHash('sha256').update(native).digest('hex')},permissionMode:'default'}
    let target = PACKAGE_DIRECTORY
    if (pendingAck) {
      target = join(root, 'controlled-default-setup')
      await mkdir(target)
      await writeFile(join(target, 'package.json'), JSON.stringify({ name: 'controlled-default-setup', type: 'module', exports: { '.': './index.js' } }))
      await writeFile(join(target, 'index.js'), `import plugin from ${JSON.stringify(new URL('../dist/index.js', import.meta.url).href)}
import { readFile, writeFile } from 'node:fs/promises'
export default { id: 'controlled-default-setup', async setup(ctx) {
  const session = { ...ctx.session, synthetic: async input => {
    const ack = await ctx.session.synthetic(input)
    await writeFile(${JSON.stringify(feedbackStarted)}, JSON.stringify({ id: ack.id, sessionID: ack.sessionID }))
    const deadline = performance.now() + ${STARTUP_MS}
    while (true) {
      try { await readFile(${JSON.stringify(ackRelease)}); break } catch {
        if (performance.now() >= deadline) throw new Error('ACK_RELEASE_TIMEOUT')
        await new Promise(resolve => setTimeout(resolve, ${CONTROL_POLL_MS}))
      }
    }
    return ack
  } }
  return plugin.setup({ ...ctx, session })
} }`)
    }
    await writeFile(join(plugin, 'package.json'), JSON.stringify({ name: 'harness-v2-fixture', type: 'module', exports: { '.': './index.js' } }))
    await writeFile(join(plugin, 'index.js'), `import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { appendFile, readFile } from 'node:fs/promises'
import { ClaudeTranscript, createRuntime } from ${JSON.stringify(CORE)}
import { PromptContexts, PROMPT_REQUEST_HEADER } from ${JSON.stringify(TRANSPORT)}
export default {
  id: 'harness-v2-fixture',
  server() { throw new Error('V2 called V1 entrypoint') },
  async setup(ctx) {
    const contexts = new PromptContexts()
    let pending
    const log = async value => appendFile(${JSON.stringify(trace)}, JSON.stringify({ ...value, at: Date.now() }) + '\\n')
    const transcripts = new ClaudeTranscript({ host: 'v2', directory: ctx.location.directory, history: async (event, signal) => {
      const [info, messages] = await Promise.all([ctx.session.get({ sessionID: event.sessionID }, { signal }), ctx.session.context({ sessionID: event.sessionID }, { signal })])
      return { id: info.id, ...(info.parentID ? { parentID: info.parentID } : {}), messages }
    } })
    const runtime = await createRuntime('v2', ctx.location.directory, ctx.options, {
      transcripts, report: () => {}, dispatchDiagnostic: () => {},
      host: { environment: { PATH: process.env.PATH, HOME: process.env.HOME, SHELL: '/bin/sh' } },
      stop: { diagnostic: () => {}, admit: async delivery => {
        let stage = 'records', reservation, transcriptReservation; try { const projection = transcripts.admitStop(delivery)
        if (delivery.effects.stop || !delivery.effects.continuations.length) return
        const id = 'msg_' + randomUUID()
        const text = 'V2_OWNED_TRANSPORT_MARKER'
        const description = 'Hook continuation'
        const metadata = { source: 'opencode-harness-hooks', completionID: delivery.event.completionID, token: randomUUID() }
        const before = transcripts.inspect().stopBytes
        stage = 'transcript-reservation'; transcriptReservation = transcripts.reserveContinuation(delivery, { id, text, metadata, description })
        assert.ok(transcripts.inspect().stopBytes > before)
        stage = 'model-reservation'; reservation = contexts.reserveContinuation(delivery.session, id, [text], projection)
        assert.equal(contexts.ownsCurrentMessage(delivery.session, id), false)
        assert.throws(() => contexts.issue(delivery.session), { code: 'HOST_PROMPT_ADMISSION_PENDING' })
        await log({ phase: 'reserved', id })
        stage = 'synthetic'; const admitted = await ctx.session.synthetic({ id, sessionID: delivery.event.sessionID, text, description, metadata, delivery: 'steer', resume: false }, { signal: delivery.signal })
        assert.equal(admitted.id, id); assert.equal(admitted.sessionID, delivery.event.sessionID); assert.equal(admitted.type, 'synthetic'); assert.equal(admitted.delivery, 'steer')
        assert.deepEqual(admitted.payload, { text, description, metadata }); assert.ok(Number.isFinite(admitted.time.created))
        stage = 'readback'; const readback = await ctx.session.context({ sessionID: delivery.event.sessionID }, { signal: delivery.signal })
        await log({ phase: 'queued', id: admitted.id, readbackVisible: readback.some(row => row.id === admitted.id), returnedKeys: Object.keys(admitted) })
        pending = { delivery, id, text, metadata, reservation, transcriptReservation }
         } catch (error) { reservation?.release(); transcriptReservation?.release(); await log({phase:'admission-failure',stage,code:error.code,name:error.name}); throw error }
      } },
    })
    const sessions = runtime.sessions
    await ctx.session.hook('prompt', event => {
      sessions.prompt(event.sessionID, event.messageID)
      contexts.remember(sessions.get(event.sessionID), [event.prompt.text], [])
      return log({ phase: 'prompt-observed', sessionID: event.sessionID, messageID: event.messageID })
    })
    await ctx.session.hook('context', async event => {
      if (pending) {
        const { delivery, id, text, metadata, reservation, transcriptReservation } = pending
        const readback = await ctx.session.context({ sessionID: event.sessionID }, { signal: delivery.signal })
        const row = readback.find(row => row.id === id)
        assert.equal(row.type, 'synthetic'); assert.equal(row.text, text); assert.deepEqual(row.metadata, metadata)
        transcriptReservation.admit(row)
        reservation.admit()
        assert.equal(contexts.ownsCurrentMessage(delivery.session, id), true)
        await log({ phase: 'admitted', id, readbackVisible: true })
        pending = undefined
      }
      contexts.layout(sessions.get(event.sessionID), event.messages.filter(row => row.role === 'user').map(row => ({ id: row.id, text: row.content.map(part => part.text) })))
      sessions.model(event.sessionID, event.model.id, sessions.get(event.sessionID).turnID)
    })
    await ctx.session.hook('title', event => { event.result = 'Fixture' })
    await ctx.session.hook('model.request', event => {
      event.headers['x-harness-request-kind'] = event.kind
      if (event.kind !== 'primary') return
      const session = sessions.get(event.sessionID)
      transcripts.observeModel({ host: 'v2', sessionID: event.sessionID, messageID: session.turnID, signal: session.turnSignal }, session)
      const token = contexts.issue(session, 'openai')
      if (token) event.headers[PROMPT_REQUEST_HEADER] = token
    })
    await ctx.session.hook('http.request', async event => {
      const token = event.request.headers.get(PROMPT_REQUEST_HEADER)
      if (event.kind === 'primary' && token) event.request = await contexts.project(event.request, token, sessions.get(event.sessionID))
    })
    await ctx.session.hook('experimental.idle', async event => {
      const session = sessions.get(event.sessionID)
      const history = await ctx.session.context({ sessionID: event.sessionID }, { signal: session.turnSignal })
      const completion = history.findLast(row => row.type === 'assistant')
      const stop = { host: 'v2', event: 'Stop', sessionID: event.sessionID, messageID: session.turnID, completionID: completion.id, cwd: ctx.location.directory }
      const path = await transcripts.prepare(stop, session, session.turnSignal)
      const projected = (await readFile(path, 'utf8')).trim().split('\\n').map(JSON.parse)
      await log({ phase: 'stop-snapshot', status: 'prepared', types: projected.map(row => row.type), rows: projected, last: projected.at(-1).message })
      const receipt = await runtime.stop({ ...stop, data: { transcript_path: path, last_assistant_message: completion.content.filter(part => part.type === 'text').map(part => part.text).join('\\n'), background_tasks: [], session_crons: [] } })
      await log({ phase: 'receipt', control: receipt.control, messageID: receipt.messageID })
    })
    return async () => { contexts.dispose(); await runtime.dispose() }
  },
}
`)
    const cancellationController = cancelled ? `
  const lifetime = new AbortController()
  const control = (async () => {
    const deadline = performance.now() + ${CLIENT_MS}
    while (!lifetime.signal.aborted) {
      let first
      try { first = JSON.parse((await readFile(${JSON.stringify(hookTrace)}, 'utf8')).trim().split('\\n')[0]) } catch {}
      if (first && ${afterFeedback ? `await readFile(${JSON.stringify(feedbackStarted)}, 'utf8').then(() => true, () => false)` : 'true'}) {
        await ctx.session.interrupt({ sessionID: first.session_id })
        await log({ phase: 'user-interruption', sessionID: first.session_id })
        ${afterFeedback ? `const native = await ctx.session.context({ sessionID: first.session_id }, { signal: AbortSignal.timeout(${STARTUP_MS}) }); await log({ phase: 'interrupted-native', assistantIDs: native.filter(row => row.type === 'assistant' && row.finish === 'error' && row.error?.type === 'aborted' && !row.content.length).map(row => row.id), syntheticIDs: native.filter(row => row.type === 'synthetic' && row.metadata?.source === 'opencode-harness-hooks').map(row => row.id) })` : ''}
        return
      }
      if (performance.now() >= deadline) throw new Error('CONTROL_TIMEOUT')
      await new Promise(resolve => setTimeout(resolve, ${CONTROL_POLL_MS}))
    }
  })().catch(() => log({ phase: 'controller-error' }))
  return async () => { lifetime.abort(); await control }
` : ''
    if (defaultRoot) await writeFile(join(plugin, 'index.js'), `import { appendFile, readFile } from 'node:fs/promises'
export default { id: 'harness-stop-observer', async setup(ctx) {
  const log = value => appendFile(${JSON.stringify(trace)}, JSON.stringify(value) + '\\n')
  await ctx.session.hook('title', event => { event.result = 'Fixture' })
  await ctx.session.hook('prompt', event => log({ phase: 'prompt-observed', sessionID: event.sessionID, messageID: event.messageID }))
  await ctx.session.hook('model.request', event => { event.headers['x-harness-request-kind'] = event.kind })
  await ctx.session.hook('context', event => log({ phase: 'root-context', users: event.messages.filter(row => row.role === 'user').map(row => row.id) }))
  await ctx.session.hook('experimental.idle', async event => {
    const rows = await ctx.session.context({ sessionID: event.sessionID }, { signal: AbortSignal.timeout(5000) })
    await log({ phase: 'root-idle', synthetics: rows.filter(row => row.type === 'synthetic').map(row => ({ id: row.id, source: row.metadata?.source, completionID: row.metadata?.completionID })) })
  })
  ${cancellationController}
} }
`)
    await run(process.execPath,['--check',join(plugin,'index.js')],{timeout:STARTUP_MS,maxBuffer:MAX_BYTES})
    await writeFile(join(config, 'opencode.json'), JSON.stringify({
      model: 'fixture/fixture', update: 'disable', snapshots: false, share: 'disabled', warming: false, plugins: defaultRoot ? [{ package: target, options }, { package: plugin }] : [{ package: plugin, options }],
      providers: { fixture: { package: '@opencode/ai/providers/openai-compatible', settings: { apiKey: 'synthetic', baseURL: 'http://127.0.0.1:' + gateway.address().port + '/v1' }, models: { fixture: { name: 'Fixture', capabilities: { tools: false }, limit: { context: 50000, output: 2000 } } } } },
    }))
    host = spawn(binary, ['serve', '--hostname', '127.0.0.1', '--port', '0'], { cwd: project, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    hostDone = new Promise(resolve => host.once('close', resolve))
    const diagnostics=[]
    host.stderr.on('data',chunk=>{for(const line of String(chunk).split('\n'))for(const code of line.match(/\b(?:HOST|SESSION|SOURCE|PLUGIN)_[A-Z_]+\b/g)??[])diagnostics.push(code)})
    const ready = new Promise((resolve, reject) => {
      let output = ''
      host.once('error', reject)
      host.once('close', () => reject(new ProbeError('HOST_EXITED_BEFORE_READY')))
      host.stdout.on('data', chunk => {
        output = (output + chunk).slice(-MAX_BYTES)
        const address = /http:\/\/127\.0\.0\.1:\d+/.exec(output)?.[0]
        if (address) resolve(address)
      })
    })
    const address = await bounded(ready, STARTUP_MS, 'HOST_STARTUP_TIMEOUT')
    const running = run(binary, ['--server', address, 'run', '--format', 'json', '--model', 'fixture/fixture', historical || cancelled ? 'LATER_ORIGINAL_PROMPT' : 'Finish the V2 fixture'], { cwd: project, env, timeout: CLIENT_MS, maxBuffer: MAX_BYTES })
    running.child.stdin.end()
    let result = await running.catch(error => ({stdout:error.stdout??'',stderr:error.stderr??'',failure:error.code??'unknown'}))
    const interruptedResult = result
    if (historical || cancelled) {
      if (afterFeedback && !pendingAck) {
        const errors = result.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(row => row.type === 'error')
        check(result.failure === 1 && errors.length === 1 && JSON.stringify(errors[0].error) === JSON.stringify({ type: 'aborted', message: 'Step interrupted' }), 'HOST_NATIVE_INTERRUPTED_CLI_OUTCOME_FAILED')
      } else check(!result.failure, 'HOST_STOP_HISTORY_FIRST_PROMPT_FAILED')
      const first = JSON.parse((await readFile(hookTrace, 'utf8')).trim().split('\n')[0])
      check(typeof first.session_id === 'string' && first.session_id, 'HOST_STOP_HISTORY_SESSION_UNAVAILABLE')
      const follow = run(binary, ['--server', address, 'run', '--session', first.session_id, '--format', 'json', '--model', 'fixture/fixture', 'LATER_NEXT_PROMPT'], { cwd: project, env, timeout: CLIENT_MS, maxBuffer: MAX_BYTES })
      follow.child.stdin.end()
      if (pendingAck) {
        const deadline = performance.now() + STARTUP_MS
        while (true) {
          let observed = []
          try { observed = (await readFile(trace, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse) } catch {}
          if (observed.some(row => row.phase === 'prompt-observed' && row.messageID !== first.prompt_id)) break
          check(performance.now() < deadline, 'HOST_NEXT_PROMPT_CONTROL_TIMEOUT')
          await new Promise(resolve => setTimeout(resolve, CONTROL_POLL_MS))
        }
        await writeFile(ackRelease, 'release')
      }
      result = await follow.catch(error => ({stdout:error.stdout??'',stderr:error.stderr??'',failure:error.code??'unknown'}))
    }
    const events = (await readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    const primary = requests.filter(request => request.kind === 'primary')
    let hooks=[];try{hooks=(await readFile(hookTrace,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)}catch{}
    const snapshots=defaultRoot ? hooks.map(row=>({ status:'prepared', rows:row.fixtureRecords })) : events.filter(row=>row.phase==='stop-snapshot')
    const receipts=events.filter(row=>row.phase==='receipt')
    check(!diagnostics.some(code => !cancelled || code !== 'HOST_STOP_CANCELLED'),'HOST_OWNED_STOP_DIAGNOSTICS:'+ [...new Set(diagnostics)].join(','))
    check(!result.failure && primary.length===(afterFeedback&&!pendingAck?3:2) && snapshots.length===2 && snapshots.every(row=>row.status==='prepared'),'HOST_OWNED_STOP_SNAPSHOT_FAILED')
    if (cancelled) {
      const oracle = JSON.parse(await readFile(new URL('../test/fixtures/claude-stop-cancellation-oracle.json', import.meta.url), 'utf8')).cases.find(row => row.name === (pendingAck ? CANCELLATION_STAGES.AFTER_FEEDBACK : stage))
      check(events.filter(row => row.phase === 'user-interruption').length === 1 && !events.some(row => row.phase === 'controller-error'), 'HOST_STOP_INTERRUPT_CONTROL_FAILED')
      check(hooks.every(row => row.stop_hook_active === false) && hooks[0].prompt_id !== hooks[1].prompt_id && hooks[0].session_id === hooks[1].session_id, 'HOST_STOP_INTERRUPT_OWNER_FAILED')
      const messages = primary.at(-1).messages.filter(row => ['user', 'assistant'].includes(row.role))
      check(JSON.stringify(messages.map(row => row.role)) === JSON.stringify(['user', 'assistant', 'user']) && JSON.stringify(messages[2].content) === JSON.stringify(oracle.nextUser.map(text => ({ type: 'text', text: text.replaceAll('FIXTURE_COMMAND', [process.execPath, hookScript].join(' ')) }))), 'HOST_STOP_INTERRUPT_MODEL_FAILED')
      check(hooks[1].fixtureRecords.filter(row => row.subtype === 'stop_hook_summary').length === (afterFeedback ? 1 : 0), 'HOST_STOP_INTERRUPT_UNADMITTED_RECORDS')
      const interruption = hooks[1].fixtureRecords.filter(row => row.userType === 'external')
      check(interruption.length === 1 && interruption[0].promptId === hooks[0].prompt_id && interruption[0].entrypoint === 'sdk-cli' && JSON.stringify(interruption[0].message) === JSON.stringify({ role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] }) && hooks[1].fixtureRecords.some(row => row.uuid === interruption[0].parentUuid), 'HOST_STOP_INTERRUPT_RECORD_FAILED')
      check(Number.isSafeInteger(hooks[0].fixturePID) && hooks[0].fixturePID > 0, 'HOST_STOP_INTERRUPT_PID_UNAVAILABLE')
      let active
      try { process.kill(hooks[0].fixturePID, 0); active = true } catch (error) { if (error.code !== 'ESRCH') throw new ProbeError('HOST_STOP_INTERRUPT_PID_CHECK_FAILED'); active = false }
      check(!active, 'HOST_STOP_INTERRUPT_PROCESS_ALIVE')
      if (afterFeedback) {
        const native = events.find(row => row.phase === 'interrupted-native'), retained = hooks[1].fixtureRecords
        if (pendingAck) {
          const ack = JSON.parse(await readFile(feedbackStarted, 'utf8')), remaining = events.filter(row => row.phase === 'root-idle').at(-1)?.synthetics
          check(native?.assistantIDs.length === 0 && ack.sessionID === hooks[0].session_id && remaining?.length === 1 && remaining[0].id === ack.id && remaining[0].source === 'opencode-harness-hooks', 'HOST_STOP_INTERRUPT_OWNED_RETIREMENT_FAILED')
        } else check(native?.assistantIDs.length === 1 && native.syntheticIDs.length === 1 && !retained.some(row => native.assistantIDs.includes(row.message?.id)) && events.filter(row => row.phase === 'root-idle').at(-1)?.synthetics.length === 1, 'HOST_STOP_INTERRUPT_OWNED_RETIREMENT_FAILED')
        check(retained.some(row => row.isMeta && row.message?.content === 'Stop hook feedback:\nCANCEL_STOP_FEEDBACK') && retained.some(row => row.rendered?.some(part => part.content === oracle.nextUser[1])), 'HOST_STOP_INTERRUPT_RETAINED_OUTPUT_FAILED')
        const errors = interruptedResult.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(row => row.type === 'error')
        check(pendingAck ? errors.length === 0 : errors[0].sessionID === hooks[0].session_id, 'HOST_NATIVE_INTERRUPTED_CLI_OWNER_FAILED')
      } else check(!(await access(finishedPath).then(() => true, () => false)) && events.filter(row => row.phase === 'root-idle').every(row => !row.synthetics.length), 'HOST_STOP_INTERRUPT_COMMAND_OR_SYNTHETIC')
      check((await readFile(sourcePath)).equals(sourceSnapshot) && (await readFile(hookScript)).equals(scriptSnapshot), 'FIXTURE_SOURCE_CHANGED')
      check(primary.every(row => !row.privateHeaderPresent) && !/UNADMITTED_STOP_OUTPUT|opencode-harness-hooks:Stop:/.test(JSON.stringify(primary)), 'HOST_STOP_INTERRUPT_TRANSPORT_FAILED')
      return { mode: stage, defaultRootStopCancellation: !pendingAck, defaultPackageEntrypoint: !pendingAck, ...(pendingAck ? { controlledDefaultSetup: true, acceptedBeforeHeldAck: true, nextPromptBeforeAckRelease: true } : {}), independentController: true, originalInterruptionOwner: true, nextPromptOracle: true, nativeInterruptionRecord: true, fixtureSourceUnchanged: true, ...(afterFeedback ? { admittedStopOutputRetained: true, ownedInputRetired: true, ...(pendingAck ? {} : { ownedAbortedAssistantRetired: true }), nativeInterruptedCliExit: interruptedResult.failure ?? 0 } : { unadmittedStopOutputAbsent: true, commandCancelled: true, noSyntheticContinuation: true }), equivalent: false }
    }
    if (historical) {
      check(hooks.length===2 && hooks.every(row=>row.stop_hook_active===false) && hooks[0].prompt_id!==hooks[1].prompt_id && hooks[0].session_id===hooks[1].session_id,'HOST_STOP_HISTORY_REAL_TURNS_FAILED')
      check((await readFile(sourcePath)).equals(sourceSnapshot) && (await readFile(hookScript)).equals(scriptSnapshot),'FIXTURE_SOURCE_CHANGED')
      check(hooks[0].last_assistant_message==='V2_FIRST_ANSWER' && hooks[1].last_assistant_message==='V2_SECOND_ANSWER','HOST_STOP_HISTORY_ASSISTANT_FAILED')
      const idles=events.filter(row=>row.phase==='root-idle'), prompts=events.filter(row=>row.phase==='prompt-observed')
      check(idles.length===2 && idles.every(row=>!row.synthetics.length) && prompts.length===2 && prompts[0].messageID!==prompts[1].messageID,'HOST_STOP_HISTORY_SYNTHETIC_OR_REPLAYED')
      const messages=primary[1].messages.filter(row=>['user','assistant'].includes(row.role))
      check(JSON.stringify(messages.map(row=>row.role))===JSON.stringify(['user','assistant','user']),'HOST_STOP_HISTORY_ROLES_FAILED')
      const content=messages[2].content
      check(Array.isArray(content) && content.every(part=>part.type==='text') && JSON.stringify(content.map(part=>part.text))===JSON.stringify(historical.nextUser.map(text=>text.replaceAll('FIXTURE_COMMAND',[process.execPath,hookScript].join(' ')))),'HOST_STOP_HISTORY_MODEL_FAILED')
      check(snapshots[1].rows.filter(row=>row.subtype==='stop_hook_summary').length===1 && snapshots[1].rows.some(row=>row.attachment?.type==='hook_stopped_continuation'),'HOST_STOP_HISTORY_ARTIFACT_FAILED')
      check(primary.every(row=>!row.privateHeaderPresent) && !/opencode-harness-hooks:Stop:/.test(JSON.stringify(primary)),'HOST_STOP_HISTORY_TRANSPORT_FAILED')
      return {mode:historical.name,defaultPackageEntrypoint:true,independentObserver:true,distinctRealTurns:true,noSyntheticContinuation:true,ownedNextPromptBlocks:true,retainedStopArtifacts:true,fixtureSourceUnchanged:true,foregroundFixture:true,mechanismOnly:false,defaultRootStop:true,equivalent:false}
    }
    if (!defaultRoot) check(receipts.length===2 && receipts[0].control==='continue' && receipts[1].control==='complete' && receipts[0].messageID===receipts[1].messageID,'HOST_OWNED_STOP_CONTROL_FAILED')
    check(hooks.length===2 && hooks[0].stop_hook_active===false && hooks[1].stop_hook_active===true && hooks[0].prompt_id===hooks[1].prompt_id,'HOST_OWNED_STOP_PAYLOAD_FAILED')
    check((await readFile(sourcePath)).equals(sourceSnapshot) && (await readFile(hookScript)).equals(scriptSnapshot),'FIXTURE_SOURCE_CHANGED')
    check(hooks[0].last_assistant_message==='V2_FIRST_ANSWER' && hooks[1].last_assistant_message==='V2_SECOND_ANSWER','HOST_OWNED_STOP_ASSISTANT_FAILED')
    const reserved=events.find(row=>row.phase==='reserved'), queued=events.find(row=>row.phase==='queued'), admitted=events.find(row=>row.phase==='admitted')
    if (!defaultRoot) check(reserved && queued && !queued.readbackVisible && admitted?.readbackVisible && reserved.id===queued.id && queued.id===admitted.id && queued.at>=reserved.at && admitted.at>=queued.at,'HOST_OWNED_STOP_READBACK_FAILED')
    else {
      const idles=events.filter(row=>row.phase==='root-idle'), contexts=events.filter(row=>row.phase==='root-context')
      check(idles.length===2 && !idles[0].synthetics.length && idles[1].synthetics.length===1,'HOST_ROOT_STOP_QUEUE_PHASE_FAILED')
      const owned=idles[1].synthetics[0]
      check(owned.source==='opencode-harness-hooks' && contexts.length===2 && contexts[1].users.at(-1)===owned.id,'HOST_ROOT_STOP_OWNERSHIP_FAILED')
    }
    const second=snapshots[1].rows
    check(second.filter(row=>row.type==='user' && !row.isMeta).length===1 && second.filter(row=>row.subtype==='stop_hook_summary').length===1 && !/V2_OWNED_TRANSPORT_MARKER|opencode-harness-hooks:Stop:/.test(JSON.stringify(second)),'HOST_OWNED_STOP_HISTORY_FAILED')
    const delivered = primary[1].messages.filter(row => row.role==='user' && Array.isArray(row.content) && row.content.some(part=>part.text?.startsWith('Stop hook feedback:')))
    check(delivered.length===1,'HOST_OWNED_STOP_MODEL_ROLE_FAILED')
    const owned=delivered[0].content.map(part=>part.text)
    const expected=[
      '<system-reminder>\nStop hook blocking error from command: "'+[process.execPath,hookScript].join(' ')+'": V2_STOP_FEEDBACK\n</system-reminder>',
      '<system-reminder>\nStop hook additional context: V2_STOP_CONTEXT\n</system-reminder>\n',
      'Stop hook feedback:\nV2_STOP_FEEDBACK',
    ]
    check(JSON.stringify(owned)===JSON.stringify(expected),'HOST_OWNED_STOP_MODEL_FAILED')
    check(primary.every(row=>!row.privateHeaderPresent) && !/V2_OWNED_TRANSPORT_MARKER|opencode-harness-hooks:Stop:/.test(JSON.stringify(primary)),'HOST_OWNED_STOP_TRANSPORT_FAILED')
    check(events.filter(row=>row.phase==='prompt-observed').length===1,'HOST_OWNED_STOP_PROMPT_REPLAYED')
    return {ownedStopHistory:true,ownedStopModelInput:true,...(!defaultRoot ? {reservedModelInput:true,reservedTranscriptInput:true,explicitInputIdentity:true} : {defaultPackageEntrypoint:true,independentObserver:true}),originalTurnRetained:true,stopActiveTransition:true,unchangedCommandExecutedTwice:true,queuedReadbackPhaseVerified:true,foregroundFixture:true,mechanismOnly:!defaultRoot,defaultRootStop:defaultRoot,equivalent:false}
  } finally {
    await stop(host, hostDone)
    if (gateway?.listening) { gateway.closeAllConnections(); await new Promise(resolve => gateway.close(resolve)) }
    await rm(root, { recursive: true, force: true })
  }
}

try {
  let parsed
  try { parsed = parseArgs({ options: { binary: { type: 'string', short: 'b' }, 'default-root': { type: 'boolean' }, history: { type: 'boolean' }, cancellation: { type: 'boolean' }, 'cancellation-stage': { type: 'string' }, help: { type: 'boolean', short: 'h' } }, strict: true, allowPositionals: false }) } catch { throw new ProbeError('USAGE_INVALID: use --help', 2) }
  if (parsed.values.help) process.stdout.write(HELP)
  else {
    const binary = parsed.values.binary ?? process.env.OPENCODE_V2_BINARY ?? 'opencode'
    if (!binary.trim()) throw new ProbeError('USAGE_BINARY_EMPTY', 2)
    if (parsed.values.history && !parsed.values['default-root']) throw new ProbeError('USAGE_HISTORY: --history requires --default-root', 2)
    if (parsed.values.cancellation && (!parsed.values['default-root'] || parsed.values.history)) throw new ProbeError('USAGE_CANCELLATION: --cancellation requires --default-root without --history', 2)
    if (parsed.values['cancellation-stage'] !== undefined && (!parsed.values.cancellation || !STAGES.has(parsed.values['cancellation-stage']))) throw new ProbeError('USAGE_CANCELLATION_STAGE: select --cancellation with during-hook, after-feedback or pending-ack', 2)
    if (parsed.values.history) {
      const oracle=JSON.parse(await readFile(new URL('../test/fixtures/claude-stop-history-oracle.json',import.meta.url),'utf8')),cases=[]
      for (const scenario of oracle.cases) cases.push(await verify(binary,true,scenario))
      process.stdout.write(JSON.stringify({defaultRootStopHistory:true,cases,equivalent:false})+'\n')
    } else process.stdout.write(JSON.stringify(await verify(binary, parsed.values['default-root'] ?? false, undefined, parsed.values.cancellation ?? false, parsed.values['cancellation-stage'])) + '\n')
  }
} catch (error) {
  const code = error instanceof ProbeError ? error.message : 'HOST_PROBE_FAILED'
  process.stderr.write(code + '\n')
  process.exitCode = error instanceof ProbeError ? error.status : 1
}
