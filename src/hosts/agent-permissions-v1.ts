import { randomUUID } from 'node:crypto'
import { snapshotJsonObject } from '../bounded-json.js'
import { HostHookError } from '../host-errors.js'
import type { AgentExecutionContext } from '../host-services.js'
import { runService } from '../service-execution.js'

const MAX_CALLS = 1024
const MAX_REQUESTS = 4096
const INPUT_BYTES = 8 * 1024 * 1024
const REPLY_BYTES = 64
const REPLY_MS = 5000
const MAX_COMMAND_BYTES = 8192
const MAX_ID_BYTES = 4096
const DENIAL = 'Agent hook permission denied in dontAsk mode'
const READ_COMMANDS = new Set(['cat', 'head', 'tail', 'wc', 'ls', 'pwd', 'echo', 'printf'])
interface Call { readonly sessionID: string; readonly callID: string; readonly tool: string }
interface Permission { readonly id: string; readonly sessionID: string; readonly permission: string; readonly tool: { readonly callID: string; readonly messageID: string } }
type PermissionOwner = Pick<AgentExecutionContext, 'parentID' | 'sessionID' | 'signal'>
interface State { readonly execution: PermissionOwner; readonly call: Call; readonly release: () => void; approved: boolean; args?: Readonly<Record<string, unknown>> }
interface Options { readonly serverUrl?: URL; readonly directory: string; readonly environment: Readonly<NodeJS.ProcessEnv>; readonly owner: (input: Permission) => PermissionOwner; readonly fetch?: typeof fetch; readonly diagnostic?: (value: Readonly<Record<string, unknown>>) => void }
function key(call: Pick<Call, 'sessionID' | 'callID'>): string { return JSON.stringify([call.sessionID, call.callID]) }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function id(value: unknown): value is string { return typeof value === 'string' && !!value && Buffer.byteLength(value) <= MAX_ID_BYTES && !value.includes('\0') }
function fail(code: string): never { throw new HostHookError(code, 'unsupported') }

export function readOnlyShell(value: unknown): boolean {
  if (typeof value !== 'string' || Buffer.byteLength(value) > MAX_COMMAND_BYTES) return false
  const words: string[] = []
  let word = '', present = false, quote = ''
  for (let index = 0; index < value.length; index++) {
    const char = value[index]!
    if (char === '\n' || char === '\r' || char === '\0') return false
    if (quote) {
      if (char === quote) { quote = ''; continue }
      if (quote === '"' && (char === '$' || char === '`' || char === '\\')) return false
      word += char; continue
    }
    if (char === "'" || char === '"') { quote = char; present = true; continue }
    if ('<>|;&(){}$`#\\'.includes(char)) return false
    if (char === ' ' || char === '\t') { if (present) { words.push(word); word = ''; present = false }; continue }
    word += char; present = true
  }
  if (quote) return false
  if (present) words.push(word)
  const command = words[0]
  if (!command) return false
  const name = command.startsWith('/bin/') ? command.slice(5) : command.startsWith('/usr/bin/') ? command.slice(9) : command
  return READ_COMMANDS.has(name)
}

export class V1AgentPermissions {
  private readonly calls = new Map<string, State>()
  private readonly replied = new Map<string, string>()
  private readonly active = new Set<Promise<void>>()
  private readonly lifetime = new AbortController()
  private readonly input: Options
  private observerFailures = 0
  constructor(input: Options) { this.input = { ...input, environment: { OPENCODE_SERVER_PASSWORD: input.environment.OPENCODE_SERVER_PASSWORD, OPENCODE_SERVER_USERNAME: input.environment.OPENCODE_SERVER_USERNAME }, ...(input.serverUrl ? { serverUrl: new URL(input.serverUrl) } : {}) } }
  private state(execution: AgentExecutionContext, call: Call): State {
    if (this.lifetime.signal.aborted || execution.signal.aborted || call.sessionID !== execution.sessionID) fail('HOST_AGENT_PERMISSION_CANCELLED')
    const token = key(call), previous = this.calls.get(token)
    if (previous) { if (previous.execution.signal !== execution.signal || previous.call.tool !== call.tool) fail('HOST_AGENT_PERMISSION_OWNER_MISMATCH'); return previous }
    if (this.calls.size >= MAX_CALLS) fail('HOST_AGENT_PERMISSION_LIMIT')
    const abort = () => { if (this.calls.get(token) === state) this.calls.delete(token) }
    const state: State = { execution: { parentID: execution.parentID, sessionID: execution.sessionID, signal: execution.signal }, call: { ...call }, approved: false, release: () => execution.signal.removeEventListener('abort', abort) }
    execution.signal.addEventListener('abort', abort, { once: true }); this.calls.set(token, state)
    return state
  }
  capture(execution: AgentExecutionContext, call: Call, args: unknown): void { const copied = snapshotJsonObject(args, INPUT_BYTES, () => fail('HOST_AGENT_PERMISSION_INPUT_INVALID')).value; this.state(execution, call).args = typeof copied.command === 'string' && Buffer.byteLength(copied.command) <= MAX_COMMAND_BYTES ? { command: copied.command } : {} }
  approve(execution: AgentExecutionContext, call: Call): void { this.state(execution, call).approved = true }
  complete(call: Call): void { const token = key(call), state = this.calls.get(token); state?.release(); this.calls.delete(token) }
  reply(input: unknown): Promise<void> {
    const operation = this.observed(input)
    this.active.add(operation); void operation.finally(() => this.active.delete(operation)).catch(() => {})
    return operation
  }
  private async observed(input: unknown): Promise<void> {
    const operationID = randomUUID(), started = performance.now()
    let code = 'HOST_AGENT_PERMISSION_FAILED', success = false, report = true
    try {
      const decision = await this.execute(input)
      report = decision !== 'duplicate'; success = true
      code = decision === 'allow' ? 'AGENT_PERMISSION_ALLOWED' : 'AGENT_PERMISSION_DENIED'
    } catch (error) { if (error instanceof HostHookError) code = error.code; throw error }
    finally {
      if (report) {
        const field = (value: unknown, name: string): unknown => record(value) ? Object.getOwnPropertyDescriptor(value, name)?.value : undefined
        const sessionID = field(input, 'sessionID'), callID = field(field(input, 'tool'), 'callID')
        const value = Object.freeze({ component: 'opencode-harness-hooks', operationID, ...(id(sessionID) ? { sessionID } : {}), ...(id(callID) ? { callID } : {}), phase: 'agent-permission', outcome: success ? 'success' : 'failed', code, durationMs: Math.round(performance.now() - started) })
        try { if (this.input.diagnostic) this.input.diagnostic(value); else console.error(JSON.stringify(value)) } catch { this.observerFailures++ }
      }
    }
  }
  private async execute(input: unknown): Promise<'allow' | 'deny' | 'duplicate'> {
    if (!record(input) || !id(input.id) || !id(input.sessionID) || !id(input.permission) || !record(input.tool) || !id(input.tool.callID) || !id(input.tool.messageID)) fail('HOST_AGENT_PERMISSION_OWNER_MISMATCH')
    const request = input as unknown as Permission, requestKey = JSON.stringify([request.sessionID, request.id])
    if (this.replied.has(requestKey)) return 'duplicate'
    const execution = this.input.owner(request), state = this.calls.get(key({ sessionID: request.sessionID, callID: request.tool.callID }))
    if (!state || !state.args || execution.signal !== state.execution.signal || state.execution.signal.aborted || this.lifetime.signal.aborted) fail('HOST_AGENT_PERMISSION_OWNER_MISMATCH')
    if (this.replied.size >= MAX_REQUESTS) fail('HOST_AGENT_PERMISSION_LIMIT')
    const base = this.input.serverUrl
    if (!base || !['http:', 'https:'].includes(base.protocol) || base.username || base.password) fail('HOST_AGENT_PERMISSION_TRANSPORT_UNAVAILABLE')
    const url = new URL('/permission/' + encodeURIComponent(request.id) + '/reply', base)
    url.searchParams.set('directory', this.input.directory)
    const headers = new Headers({ 'content-type': 'application/json' })
    const password = this.input.environment.OPENCODE_SERVER_PASSWORD
    if (password) headers.set('authorization', 'Basic ' + Buffer.from((this.input.environment.OPENCODE_SERVER_USERNAME ?? 'opencode') + ':' + password).toString('base64'))
    const allow = state.approved || request.permission === 'bash' && state.call.tool === 'bash' && readOnlyShell(state.args.command)
    const body = JSON.stringify(allow ? { reply: 'once' } : { reply: 'reject', message: DENIAL })
    this.replied.set(requestKey, execution.parentID)
    await runService(REPLY_MS, AbortSignal.any([state.execution.signal, this.lifetime.signal]), async signal => {
      const response = await (this.input.fetch ?? globalThis.fetch)(url, { method: 'POST', headers, body, signal, redirect: 'error' })
      if (!response.ok || !response.body) { void response.body?.cancel().catch(() => {}); fail('HOST_AGENT_PERMISSION_REPLY_FAILED') }
      const reader = response.body.getReader(), chunks: Uint8Array[] = []
      let bytes = 0
      const cancel = () => { void reader.cancel().catch(() => {}) }
      signal.addEventListener('abort', cancel, { once: true })
      if (signal.aborted) cancel()
      try { while (true) { const next = await reader.read(); if (signal.aborted) fail('HOST_AGENT_PERMISSION_CANCELLED'); if (next.done) break; bytes += next.value.byteLength; if (bytes > REPLY_BYTES) fail('HOST_AGENT_PERMISSION_REPLY_FAILED'); chunks.push(next.value) } } finally { signal.removeEventListener('abort', cancel); cancel() }
      if (Buffer.concat(chunks).toString().trim() !== 'true') fail('HOST_AGENT_PERMISSION_REPLY_FAILED')
    })
    if (state.execution.signal.aborted || this.lifetime.signal.aborted) fail('HOST_AGENT_PERMISSION_CANCELLED')
    return allow ? 'allow' : 'deny'
  }

  removeChild(sessionID: string): void { for (const [token, state] of this.calls) if (state.execution.sessionID === sessionID) { state.release(); this.calls.delete(token) } }
  removeSession(parentID: string): void { for (const [token, state] of this.calls) if (state.execution.parentID === parentID) { state.release(); this.calls.delete(token) }; for (const [token, parent] of this.replied) if (parent === parentID) this.replied.delete(token) }
  async dispose(): Promise<void> { this.lifetime.abort(); for (const state of this.calls.values()) state.release(); this.calls.clear(); await Promise.allSettled([...this.active]); this.replied.clear() }
  inspect() { return Object.freeze({ calls: this.calls.size, requests: this.replied.size, pending: this.active.size, observerFailures: this.observerFailures }) }
}
