import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { composeV1Provider } from '../src/opencode.js'
import { ClaudeTranscript } from '../src/transcript.js'

const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'"
const services = { report: () => {}, dispatchDiagnostic: () => {}, promptDiagnostic: () => {} }
async function fixture(t: { after: (callback: () => Promise<void>) => void }, event = 'UserPromptSubmit') {
  const directory = await mkdtemp(join(tmpdir(), 'harness-provider-bridge-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const script = join(directory, 'hook.cjs')
  await writeFile(script, `const input=JSON.parse(require('node:fs').readFileSync(0,'utf8'));console.log(JSON.stringify(input.prompt==='Block'?{decision:'block',reason:'BRIDGE_BLOCKED'}:{hookSpecificOutput:{hookEventName:'UserPromptSubmit',additionalContext:input.turn_id?'CODEX_BRIDGE_CONTEXT':'CLAUDE_BRIDGE_CONTEXT'}}))`)
  const text = JSON.stringify({ hooks: { [event]: [{ hooks: [{ type: 'command', command: quote(process.execPath) + ' ' + quote(script) }] }] } })
  const path = join(directory, 'hooks.json')
  await writeFile(path, text)
  const sources = ['claude-code', 'codex'].map(dialect => ({ id: dialect, dialect, path }))
  const digest = createHash('sha256').update(text).digest('hex')
  const input = { directory, client: { session: { get: async () => ({ data: { id: 'session' } }), messages: async () => ({ data: [] }) } } }
  return { input, options: { sources, reviewedDigests: Object.fromEntries(sources.map(source => [source.id, digest])), permissionMode: 'default' } }
}
const identity = (id: string, agent = 'build') => ({ sessionID: 'session', agent, message: { id, agent: 'build', model: { modelID: 'model', providerID: 'fixture' } }, model: { modelID: 'model', providerID: 'fixture', api: { npm: '@ai-sdk/openai-compatible' } } })

test('V1 provider bridge retains authenticated fetch with mixed native context and repeated requests', async t => {
  const f = await fixture(t)
  const forwarded: Request[] = []
  const loaderArguments: unknown[][] = []
  let revision = 0
  const provider = {
    auth: {
      provider: 'fixture', methods: [{ type: 'api' }], tag: 'loader-this',
      async loader(this: { tag: string }, ...args: unknown[]) {
        assert.equal(this.tag, 'loader-this')
        loaderArguments.push(args)
        return { apiKey: 'non-secret-placeholder', fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          const request = new Request(input, init)
          request.headers.set('authorization', 'Bearer fixture-key-' + ++revision)
          forwarded.push(request)
          return new Response('{}')
        } }
      },
    },
  }
  const hooks = await composeV1Provider(f.input, f.options, provider, services)
  t.after(() => hooks.dispose())
  const config = { model: 'fixture/model', provider: { fixture: { options: {} as Record<string, unknown> } } }
  await hooks.config(config)
  assert.equal(Object.hasOwn(config.provider.fixture.options, 'fetch'), false)
  assert.equal(hooks.auth.methods, provider.auth.methods)
  const auth = () => Promise.resolve({ type: 'api' })
  const metadata = { id: 'fixture' }
  let loaded = await hooks.auth.loader(auth, metadata)
  assert.deepEqual(loaderArguments, [[auth, metadata]])
  const selected = { id: 'fixture', options: { ...loaded, ...config.provider.fixture.options } }
  const messages: { info: object; parts: { type: string; text: string }[] }[] = []
  for (const id of ['turn-1', 'turn-2']) {
    if (id === 'turn-2') {
      loaded = await hooks.auth.loader(auth, metadata)
      selected.options = { ...loaded, ...config.provider.fixture.options }
    }
    const prompt = identity(id)
    await hooks['chat.message'](prompt, { message: prompt.message, parts: [{ type: 'text', text: 'Original' }] })
    messages.push({ info: { ...prompt.message, role: 'user', sessionID: 'session' }, parts: [{ type: 'text', text: 'Original' }] })
    await hooks['experimental.chat.messages.transform']({}, { messages })
    await hooks['chat.params']({ ...prompt, provider: selected })
    const headers: Record<string, string> = {}
    await hooks['chat.headers'](prompt, { headers })
    await loaded.fetch('https://provider.invalid/chat/completions', { method: 'POST', headers, body: JSON.stringify({ messages: messages.map(() => ({ role: 'user', content: 'Original' })) }) })
    const request = forwarded.at(-1)!
    const body = await request.clone().json()
    assert.match(body.messages[0].content[0].text, /CLAUDE_BRIDGE_CONTEXT/)
    assert.deepEqual(body.messages[1], { role: 'developer', content: 'CODEX_BRIDGE_CONTEXT' })
    assert.equal(request.headers.get('authorization'), 'Bearer fixture-key-' + revision)
    assert.equal([...request.headers.keys()].some(key => key.startsWith('x-opencode-harness-')), false)
  }
  const title = identity('turn-2', 'title')
  await hooks['chat.params']({ ...title, provider: selected })
  const headers: Record<string, string> = {}
  await hooks['chat.headers'](title, { headers })
  const titleBody = { messages: [{ role: 'user', content: 'Generate a title' }] }
  await loaded.fetch('https://provider.invalid/chat/completions', { method: 'POST', headers, body: JSON.stringify(titleBody) })
  assert.deepEqual(await forwarded.at(-1)!.json(), titleBody)
  assert.equal(revision, 3)
  assert.deepEqual(loaderArguments, [[auth, metadata], [auth, metadata]])
})

test('V1 provider bridge rejects blocked prompts and malformed requests before authenticated fetch', async t => {
  const f = await fixture(t)
  let fetches = 0
  let loads = 0
  const provider = { auth: { provider: 'fixture', methods: [], loader: async () => { loads++; return { fetch: async () => { fetches++; return new Response('{}') } } } } }
  const hooks = await composeV1Provider(f.input, f.options, provider, services)
  t.after(() => hooks.dispose())
  await hooks.config({ model: 'fixture/model' })
  const blocked = identity('blocked')
  await assert.rejects(hooks['chat.message'](blocked, { message: blocked.message, parts: [{ type: 'text', text: 'Block' }] }), { code: 'HOOK_PROMPT_BLOCKED' })
  assert.equal(loads, 0)
  const loaded = await hooks.auth.loader()
  const prompt = identity('accepted')
  await hooks['chat.message'](prompt, { message: prompt.message, parts: [{ type: 'text', text: 'Original' }] })
  await hooks['experimental.chat.messages.transform']({}, { messages: [{ info: { ...prompt.message, role: 'user', sessionID: 'session' }, parts: [{ type: 'text', text: 'Original' }] }] })
  await hooks['chat.params']({ ...prompt, provider: { id: 'fixture', options: loaded } })
  const headers: Record<string, string> = {}
  await hooks['chat.headers'](prompt, { headers })
  await assert.rejects((loaded.fetch as typeof fetch)('https://provider.invalid/chat/completions', { method: 'POST', headers, body: JSON.stringify({ messages: [{ role: 'user', content: 'Wrong' }] }) }), { code: 'HOST_PROMPT_REQUEST_UNAVAILABLE' })
  assert.equal(fetches, 0)
})

test('V1 provider bridge rejects conflicting configuration and overwritten resolved transports', async t => {
  const f = await fixture(t)
  const provider = { auth: { provider: 'fixture', methods: [], loader: async () => ({ fetch: async () => new Response('{}') }) } }
  const hooks = await composeV1Provider(f.input, f.options, provider, services)
  t.after(() => hooks.dispose())
  await assert.rejects(hooks.config({ provider: { fixture: { options: { fetch: async () => new Response('{}') } } } }), { code: 'HOST_PROMPT_TRANSPORT_UNAVAILABLE' })
  const prompt = identity('turn')
  await assert.rejects(hooks['chat.message'](prompt, { message: prompt.message, parts: [{ type: 'text', text: 'Original' }] }), { code: 'HOST_PROMPT_TRANSPORT_UNAVAILABLE' })
  await hooks.config({ provider: { fixture: { options: {} } } })
  await hooks.auth.loader()
  await assert.rejects(hooks['chat.params']({ ...prompt, provider: { id: 'fixture', options: { fetch: async () => new Response('{}') } } }), { code: 'HOST_PROMPT_TRANSPORT_UNAVAILABLE' })
})

test('V1 provider bridge preserves provider hooks, loader identity in tool-only mode and both disposals', async t => {
  const f = await fixture(t, 'PreToolUse')
  const events: string[] = []
  const loader = async () => ({ fetch: async () => new Response('{}') })
  const provider = { auth: { provider: 'fixture', methods: [], loader }, config: async () => { events.push('config') }, 'chat.params': async (_input: unknown, output: { maxOutputTokens: number }) => { output.maxOutputTokens = 128; events.push('params') }, dispose: async () => { events.push('dispose'); throw new Error('provider cleanup failure') } }
  const hooks = await composeV1Provider(f.input, f.options, provider, services)
  assert.equal(hooks.auth.loader, loader)
  await hooks.config({ model: 'fixture/model' })
  const prompt = identity('turn')
  await hooks['chat.message'](prompt, { message: prompt.message, parts: [{ type: 'text', text: 'Original' }] })
  const output = { maxOutputTokens: 2048 }
  await hooks['chat.params'](prompt, output)
  assert.equal(output.maxOutputTokens, 128)
  await assert.rejects(hooks.dispose(), /provider cleanup failure/)
  assert.deepEqual(events, ['config', 'params', 'dispose'])
  assert.equal(hooks.inspect().runtime.sessions.disposed, true)
})

test('V1 provider bridge retains guarded Stop and source-review activation rejection', async t => {
  for (const event of ['Stop', 'UserPromptSubmit']) {
    const f = await fixture(t, event)
    const options = event === 'Stop' ? f.options : { ...f.options, reviewedDigests: {} }
    const provider = { auth: { provider: 'fixture', methods: [], loader: async () => ({}) } }
    const hooks = await composeV1Provider(f.input, options, provider, services)
    t.after(() => hooks.dispose())
    const prompt = identity('turn')
    await assert.rejects(hooks['chat.message'](prompt, { message: prompt.message, parts: [{ type: 'text', text: 'Original' }] }), { code: event === 'Stop' ? 'HOST_STOP_UNSUPPORTED' : 'SOURCE_REVIEW_REQUIRED' })
  }
})

test('V1 provider bridge preserves both cleanup failures and disposes the harness first', async t => {
  const f = await fixture(t, 'PreToolUse')
  const failures = [new Error('harness cleanup'), new Error('provider cleanup')]
  const order: string[] = []
  const transcripts = new ClaudeTranscript({ host: 'v1', directory: f.input.directory, history: async () => ({ id: 'session', messages: [] }) })
  t.mock.method(transcripts, 'dispose', async () => { order.push('harness'); throw failures[0] })
  const hooks = await composeV1Provider(f.input, f.options, { auth: { provider: 'fixture', methods: [], loader: async () => ({}) }, dispose: async () => { order.push('provider'); throw failures[1] } }, { ...services, transcripts })
  await assert.rejects(hooks.dispose(), (error: unknown) => error instanceof AggregateError && assert.deepEqual(error.errors, failures) === undefined)
  assert.deepEqual(order, ['harness', 'provider'])
})

test('V1 provider bridge rejects invalid loader output and preserves original loader errors', async t => {
  const f = await fixture(t)
  const failure = new Error('provider loader failure')
  for (const value of [null, { fetch: 'invalid' }, failure]) {
    const hooks = await composeV1Provider(f.input, f.options, { auth: { provider: 'fixture', methods: [], loader: async () => { if (value === failure) throw failure; return value } } }, services)
    t.after(() => hooks.dispose())
    await assert.rejects(hooks.auth.loader(), value === failure ? error => error === failure : { code: 'HOST_PROMPT_AUTH_FETCH_UNAVAILABLE' })
  }
})

test('V1 provider bridge retains fatal admission guards when its authentication loader is missing', async t => {
  const f = await fixture(t)
  const hooks = await composeV1Provider(f.input, f.options, { auth: { provider: 'fixture', methods: [] } }, services)
  t.after(() => hooks.dispose())
  const prompt = identity('turn')
  await assert.rejects(hooks.config({}), { code: 'HOST_PROMPT_AUTH_LOADER_UNAVAILABLE' })
  await assert.rejects(hooks['chat.message'](prompt, { message: prompt.message, parts: [{ type: 'text', text: 'Original' }] }), { code: 'HOST_PROMPT_AUTH_LOADER_UNAVAILABLE' })
})

test('V1 provider bridge supports API-key-only loaders without changing their credential', async t => {
  const f = await fixture(t)
  const requests: Request[] = []
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => { requests.push(new Request(input, init)); return new Response('{}') })
  const provider = { auth: { provider: 'fixture', methods: [], loader: async () => ({ apiKey: 'fixture-api-key' }) } }
  const hooks = await composeV1Provider(f.input, f.options, provider, services)
  t.after(() => hooks.dispose())
  await hooks.config({ model: 'fixture/model' })
  const loaded = await hooks.auth.loader() as { apiKey: string; fetch: typeof fetch }
  assert.equal(loaded.apiKey, 'fixture-api-key')
  const prompt = identity('turn')
  await hooks['chat.message'](prompt, { message: prompt.message, parts: [{ type: 'text', text: 'Original' }] })
  await hooks['experimental.chat.messages.transform']({}, { messages: [{ info: { ...prompt.message, role: 'user', sessionID: 'session' }, parts: [{ type: 'text', text: 'Original' }] }] })
  await hooks['chat.params']({ ...prompt, provider: { id: 'fixture', options: loaded } })
  const headers: Record<string, string> = { authorization: 'Bearer ' + loaded.apiKey }
  await hooks['chat.headers'](prompt, { headers })
  await loaded.fetch('https://provider.invalid/chat/completions', { method: 'POST', headers, body: JSON.stringify({ messages: [{ role: 'user', content: 'Original' }] }) })
  assert.equal(requests[0]!.headers.get('authorization'), 'Bearer fixture-api-key')
  assert.equal([...requests[0]!.headers.keys()].some(key => key.startsWith('x-opencode-harness-')), false)
  assert.match(JSON.stringify(await requests[0]!.json()), /CODEX_BRIDGE_CONTEXT/)
})

test('V1 provider session cleanup cancels issued prompt tickets even when provider cleanup fails', async t => {
  const f = await fixture(t)
  const failure = new Error('provider session cleanup failure')
  let fetches = 0
  const provider = { auth: { provider: 'fixture', methods: [], loader: async () => ({ fetch: async () => { fetches++; return new Response('{}') } }) }, disposeSession: async () => { throw failure } }
  const hooks = await composeV1Provider(f.input, f.options, provider, services)
  t.after(() => hooks.dispose())
  await hooks.config({ model: 'fixture/model' })
  const loaded = await hooks.auth.loader()
  const prompt = identity('turn')
  await hooks['chat.message'](prompt, { message: prompt.message, parts: [{ type: 'text', text: 'Original' }] })
  await hooks['experimental.chat.messages.transform']({}, { messages: [{ info: { ...prompt.message, role: 'user', sessionID: 'session' }, parts: [{ type: 'text', text: 'Original' }] }] })
  await hooks['chat.params']({ ...prompt, provider: { id: 'fixture', options: loaded } })
  const headers: Record<string, string> = {}
  await hooks['chat.headers'](prompt, { headers })
  await assert.rejects(hooks.disposeSession('session'), error => error === failure)
  assert.equal(hooks.inspect().runtime.sessions.active, 0)
  await assert.rejects((loaded.fetch as typeof fetch)('https://provider.invalid/chat/completions', { method: 'POST', headers, body: JSON.stringify({ messages: [{ role: 'user', content: 'Original' }] }) }))
  assert.equal(fetches, 0)
})

test('V1 provider bridge retains each legitimate loader transport with its own authenticated delegate', async t => {
  const f = await fixture(t)
  const seen: number[] = []
  let generation = 0
  const provider = { auth: { provider: 'fixture', methods: [], loader: async () => {
    const current = ++generation
    return { fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      assert.match(await request.text(), /CODEX_BRIDGE_CONTEXT/)
      assert.equal([...request.headers.keys()].some(key => key.startsWith('x-opencode-harness-')), false)
      seen.push(current)
      return new Response('{}')
    } }
  } } }
  const hooks = await composeV1Provider(f.input, f.options, provider, services)
  t.after(() => hooks.dispose())
  await hooks.config({ model: 'fixture/model' })
  const transports = [await hooks.auth.loader(), await hooks.auth.loader()]
  const prompt = identity('turn')
  await hooks['chat.message'](prompt, { message: prompt.message, parts: [{ type: 'text', text: 'Original' }] })
  await hooks['experimental.chat.messages.transform']({}, { messages: [{ info: { ...prompt.message, role: 'user', sessionID: 'session' }, parts: [{ type: 'text', text: 'Original' }] }] })
  for (const loaded of [...transports, transports[0]!]) {
    await hooks['chat.params']({ ...prompt, provider: { id: 'fixture', options: loaded } })
    const headers: Record<string, string> = {}
    await hooks['chat.headers'](prompt, { headers })
    await loaded.fetch('https://provider.invalid/chat/completions', { method: 'POST', headers, body: JSON.stringify({ messages: [{ role: 'user', content: 'Original' }] }) })
  }
  assert.deepEqual(seen, [1, 2, 1])
})

test('V1 provider errors cannot suppress fatal activation guards or their configuration failure', async t => {
  const f = await fixture(t)
  let calls = 0
  const fail = async () => { calls++; throw new Error('provider hook failure') }
  const hooks = await composeV1Provider(f.input, { ...f.options, reviewedDigests: {} }, { auth: { provider: 'fixture', methods: [], loader: async () => ({}) }, config: fail, 'chat.message': fail }, services)
  t.after(() => hooks.dispose())
  const prompt = identity('turn')
  await assert.rejects(hooks.config({}), { code: 'SOURCE_REVIEW_REQUIRED' })
  await assert.rejects(hooks['chat.message'](prompt, { message: prompt.message, parts: [{ type: 'text', text: 'Original' }] }), { code: 'SOURCE_REVIEW_REQUIRED' })
  assert.equal(calls, 0)
})
