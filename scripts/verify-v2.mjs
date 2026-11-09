#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs, promisify } from 'node:util'

const PINNED_VERSION = '2.2.5'
const STARTUP_MS = 10000
const CLIENT_MS = 20000
const SHUTDOWN_MS = 2000
const IDLE_DELAY_MS = 120
const MAX_BYTES = 2 * 1024 * 1024
const run = promisify(execFile)
const HELP = `Usage: node scripts/verify-v2.mjs [-b PATH]

Verify awaited idle hooks and synthetic continuation against OpenCode ${PINNED_VERSION}.
Uses an isolated project, HOME/config/state and a loopback fake provider. Live
configuration and installed binaries are unchanged. No model account is needed.

Options:
  -b, --binary PATH  OpenCode executable (OPENCODE_V2_BINARY, then opencode)
  -h, --help         Show this help without requiring the executable or Git

Requires Node.js 22+, Git and the pinned OpenCode executable. No installation or
upgrade is performed. Success writes JSON to stdout; failures use stderr.
Exit status: 0 verified; 1 runtime/check failure; 2 usage/version; 3 dependency.
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

async function verify(binary) {
  const version = (await dependency(binary, ['--version'], 'OpenCode')).stdout.trim().replace(/^opencode v/, '')
  if (version !== PINNED_VERSION) throw new ProbeError('HOST_VERSION_MISMATCH: expected ' + PINNED_VERSION, 2)
  await dependency('git', ['--version'], 'Git')
  const root = await realpath(await mkdtemp(join(tmpdir(), 'harness-v2-')))
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
    gateway = createServer(async (req, res) => {
      try {
        const chunks = []
        let bytes = 0
        for await (const chunk of req) {
          bytes += chunk.length
          if (bytes > MAX_BYTES) { res.writeHead(413); res.end(); return }
          chunks.push(chunk)
        }
        const body = JSON.parse(Buffer.concat(chunks).toString())
        const continued = JSON.stringify(body.messages).includes('V2_IDLE_CONTINUATION')
        requests.push({ at: Date.now(), kind: String(req.headers['x-harness-request-kind'] ?? ''), continued })
        const message = { role: 'assistant', content: continued ? 'V2_SECOND_ANSWER' : 'V2_FIRST_ANSWER' }
        const chunk = (delta, finish_reason) => ({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason }] })
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end('data: ' + JSON.stringify(chunk(message, null)) + '\n\ndata: ' + JSON.stringify({ ...chunk({}, 'stop'), usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }) + '\n\ndata: [DONE]\n\n')
      } catch { if (!res.headersSent) res.writeHead(500); res.end() }
    })
    await new Promise((resolve, reject) => { gateway.once('error', reject); gateway.listen(0, '127.0.0.1', resolve) })
    await writeFile(join(plugin, 'package.json'), JSON.stringify({ name: 'harness-v2-fixture', type: 'module', exports: { '.': './index.js' } }))
    await writeFile(join(plugin, 'index.js'), `import { appendFile } from 'node:fs/promises'
export default {
  id: 'harness-v2-fixture',
  server() { throw new Error('V2 called V1 entrypoint') },
  async setup(ctx) {
    const seen = new Set()
    const log = async value => appendFile(${JSON.stringify(trace)}, JSON.stringify({ ...value, at: Date.now() }) + '\\n')
    await ctx.session.hook('title', event => { event.result = 'Fixture' })
    await ctx.session.hook('model.request', event => { event.headers['x-harness-request-kind'] = event.kind })
    await ctx.session.hook('experimental.idle', async event => {
      const first = !seen.has(event.sessionID)
      seen.add(event.sessionID)
      await log({ phase: 'start', sessionID: event.sessionID, first })
      await new Promise(resolve => setTimeout(resolve, ${IDLE_DELAY_MS}))
      if (first) await ctx.session.synthetic({ sessionID: event.sessionID, text: 'V2_IDLE_CONTINUATION', description: 'Hook continuation', metadata: { source: 'fixture' }, resume: false })
      await log({ phase: 'end', sessionID: event.sessionID, first })
    })
  },
}
`)
    await writeFile(join(config, 'opencode.json'), JSON.stringify({
      model: 'fixture/fixture', update: 'disable', snapshots: false, share: 'disabled', warming: false, plugins: [{ package: plugin }],
      providers: { fixture: { package: '@opencode/ai/providers/openai-compatible', settings: { apiKey: 'synthetic', baseURL: 'http://127.0.0.1:' + gateway.address().port + '/v1' }, models: { fixture: { name: 'Fixture', capabilities: { tools: false }, limit: { context: 50000, output: 2000 } } } } },
    }))
    host = spawn(binary, ['serve', '--hostname', '127.0.0.1', '--port', '0'], { cwd: project, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    hostDone = new Promise(resolve => host.once('close', resolve))
    host.stderr.on('data', () => {})
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
    const running = run(binary, ['--server', address, 'run', '--format', 'json', '--model', 'fixture/fixture', 'Finish the V2 fixture'], { cwd: project, env, timeout: CLIENT_MS, maxBuffer: MAX_BYTES })
    running.child.stdin.end()
    const result = await running.catch(error => { throw new ProbeError('HOST_CLIENT_FAILED: exit=' + (typeof error.code === 'number' ? error.code : 'unknown') + (error.killed ? ' timeout' : '')) })
    const completedAt = Date.now()
    const events = (await readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    const primary = requests.filter(request => request.kind === 'primary')
    check(primary.length === 2 && primary[0].continued === false && primary[1].continued === true, 'HOST_SYNTHETIC_CONTINUATION_FAILED')
    check(events.map(event => event.phase).join(',') === 'start,end,start,end', 'HOST_IDLE_SEQUENCE_FAILED')
    check(new Set(events.map(event => event.sessionID)).size === 1, 'HOST_IDLE_SESSION_CHANGED')
    check(primary[1].at >= events[1].at && completedAt >= events[3].at, 'HOST_IDLE_NOT_AWAITED')
    check(result.stdout.includes('V2_SECOND_ANSWER'), 'HOST_CONTINUED_ANSWER_MISSING')
    return { host: version, awaitedIdle: true, syntheticContinuesSameExecution: true, resume: false, continuedAnswerVisible: true }
  } finally {
    await stop(host, hostDone)
    if (gateway?.listening) { gateway.closeAllConnections(); await new Promise(resolve => gateway.close(resolve)) }
    await rm(root, { recursive: true, force: true })
  }
}

try {
  let parsed
  try { parsed = parseArgs({ options: { binary: { type: 'string', short: 'b' }, help: { type: 'boolean', short: 'h' } }, strict: true, allowPositionals: false }) } catch { throw new ProbeError('USAGE_INVALID: use --help', 2) }
  if (parsed.values.help) process.stdout.write(HELP)
  else {
    const binary = parsed.values.binary ?? process.env.OPENCODE_V2_BINARY ?? 'opencode'
    if (!binary.trim()) throw new ProbeError('USAGE_BINARY_EMPTY', 2)
    process.stdout.write(JSON.stringify(await verify(binary)) + '\n')
  }
} catch (error) {
  const code = error instanceof ProbeError ? error.message : 'HOST_PROBE_FAILED'
  process.stderr.write(code + '\n')
  process.exitCode = error instanceof ProbeError ? error.status : 1
}
