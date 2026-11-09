import { createHash, randomUUID } from 'node:crypto'
import type { AttributedAction } from './engine.js'
import type { HookAction } from './effect-types.js'
import { HostHookError } from './hosts/tools.js'
import { runService } from './service-execution.js'
import type { SessionSnapshot } from './sessions.js'

export const PROMPT_REQUEST_HEADER = 'x-opencode-harness-hooks-request'
const MAX_PROMPTS = 10000
const MAX_BYTES = 32 * 1024 * 1024
const MAX_TICKETS = 1024
const MAX_VARIANTS = 128
const READ_MS = 5000
type Context = AttributedAction<Extract<HookAction, { kind: 'context' }>>
export type PromptProtocol = 'openai' | 'anthropic'
export interface PromptLayout { readonly id: string; readonly text: readonly string[] }
interface Entry { readonly text: readonly string[]; readonly contexts: readonly Context[]; readonly bytes: number }
interface State { readonly signal: AbortSignal; readonly entries: Map<string, Entry>; readonly cleanup: () => void; layout?: readonly PromptLayout[] }
interface Ticket { readonly sessionID: string; readonly turnID: string; readonly signal: AbortSignal; readonly protocol: PromptProtocol; readonly entries: readonly Entry[]; readonly hashes: Map<string, string> }
function fail(code: string): never { throw new HostHookError(code, 'unsupported') }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function same(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b) }
function hash(text: string): string { return createHash('sha256').update(text).digest('hex') }
function projectedRequest(request: Request, text: string, headers: Headers, signal: AbortSignal): Request {
  const output = new Request(request, { headers, body: text, signal })
  output.headers.delete(PROMPT_REQUEST_HEADER)
  output.headers.delete('content-length')
  return output
}

async function body(request: Request, signal: AbortSignal): Promise<string> {
  return runService(READ_MS, signal, async current => {
    const reader = request.clone().body?.getReader()
    if (!reader) return fail('HOST_PROMPT_REQUEST_UNAVAILABLE')
    const cancel = () => { void reader.cancel().catch(() => {}) }
    current.addEventListener('abort', cancel, { once: true })
    try {
      if (current.aborted) return fail('HOST_PROMPT_CANCELLED')
      const chunks: Uint8Array[] = []
      let bytes = 0
      while (true) {
        const next = await reader.read()
        if (next.done) break
        bytes += next.value.byteLength
        if (bytes > MAX_BYTES) return fail('HOST_PROMPT_REQUEST_LIMIT')
        chunks.push(next.value)
      }
      return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
    } finally { current.removeEventListener('abort', cancel); cancel() }
  })
}

export class PromptContexts {
  private readonly sessions = new Map<string, State>()
  private readonly tickets = new Map<string, Ticket>()
  private readonly lifetime = new AbortController()
  private prompts = 0
  private bytes = 0

  remember(session: SessionSnapshot, text: readonly string[], contexts: readonly Context[]): void {
    if (this.lifetime.signal.aborted || session.signal.aborted || session.turnSignal.aborted) fail('HOST_PROMPT_CANCELLED')
    if (!session.turnID || !text.length || text.some(value => typeof value !== 'string')) fail('HOST_PROMPT_INPUT_UNAVAILABLE')
    if (contexts.some(row => row.action.placement !== 'model' || row.dialect === 'claude-code' && !['stdout', 'additionalContext'].includes(row.action.channel ?? ''))) fail('HOST_PROMPT_CONTEXT_UNAVAILABLE')
    const bytes = Buffer.byteLength(JSON.stringify([session.turnID, text, contexts]))
    if (this.prompts >= MAX_PROMPTS || this.bytes + bytes > MAX_BYTES) fail('HOST_PROMPT_CONTEXT_LIMIT')
    let state = this.sessions.get(session.sessionID)
    if (state && state.signal !== session.signal) fail('HOST_PROMPT_SESSION_MISMATCH')
    if (!state) {
      const cleanup = () => {
        const previous = this.sessions.get(session.sessionID)
        if (!previous) return
        for (const entry of previous.entries.values()) { this.bytes -= entry.bytes; this.prompts-- }
        this.sessions.delete(session.sessionID)
        session.signal.removeEventListener('abort', cleanup)
      }
      state = { signal: session.signal, entries: new Map(), cleanup }
      this.sessions.set(session.sessionID, state)
      session.signal.addEventListener('abort', cleanup, { once: true })
    }
    if (state.entries.has(session.turnID)) fail('HOST_PROMPT_ID_REUSED')
    state.entries.set(session.turnID, { text: Object.freeze([...text]), contexts: Object.freeze(structuredClone(contexts)), bytes })
    delete state.layout
    this.prompts++
    this.bytes += bytes
  }

  layout(session: SessionSnapshot, input: readonly PromptLayout[]): void {
    const state = this.sessions.get(session.sessionID)
    if (!state || state.signal !== session.signal || session.turnSignal.aborted || !session.turnID || input.at(-1)?.id !== session.turnID || input.length !== state.entries.size) fail('HOST_PROMPT_LAYOUT_UNAVAILABLE')
    const seen = new Set<string>()
    for (const row of input) {
      const entry = state.entries.get(row.id)
      if (!entry || seen.has(row.id) || !same(entry.text, row.text)) fail('HOST_PROMPT_LAYOUT_UNAVAILABLE')
      seen.add(row.id)
    }
    state.layout = Object.freeze(input.map(row => Object.freeze({ id: row.id, text: Object.freeze([...row.text]) })))
  }

  issue(session: SessionSnapshot, protocol: PromptProtocol = 'openai'): string | undefined {
    const state = this.sessions.get(session.sessionID)
    if (!state || state.signal !== session.signal || !state.layout || !session.turnID || session.signal.aborted || session.turnSignal.aborted || this.lifetime.signal.aborted) fail('HOST_PROMPT_LAYOUT_UNAVAILABLE')
    const entries = state.layout.map(row => state.entries.get(row.id)!)
    if (!entries.some(entry => entry.contexts.length)) return undefined
    if (this.tickets.size >= MAX_TICKETS) fail('HOST_PROMPT_REQUEST_LIMIT')
    const id = randomUUID()
    const signal = AbortSignal.any([session.signal, session.turnSignal, this.lifetime.signal])
    this.tickets.set(id, { sessionID: session.sessionID, turnID: session.turnID, signal, protocol, entries, hashes: new Map() })
    signal.addEventListener('abort', () => { this.tickets.delete(id) }, { once: true })
    return id
  }

  owner(token: string): { readonly sessionID: string; readonly messageID: string } | undefined {
    const ticket = this.tickets.get(token)
    return ticket ? { sessionID: ticket.sessionID, messageID: ticket.turnID } : undefined
  }

  async project(request: Request, token: string, expected?: SessionSnapshot): Promise<Request> {
    const ticket = this.tickets.get(token)
    if (!ticket || ticket.signal.aborted || expected && (ticket.sessionID !== expected.sessionID || ticket.turnID !== expected.turnID || expected.turnSignal.aborted)) fail('HOST_PROMPT_REQUEST_UNAVAILABLE')
    const headers = new Headers(request.headers)
    headers.delete(PROMPT_REQUEST_HEADER)
    headers.delete('content-length')
    const signal = AbortSignal.any([request.signal, ticket.signal])
    try {
      const text = await body(request, signal)
      const fingerprint = hash(text)
      if ([...ticket.hashes.values()].includes(fingerprint)) return projectedRequest(request, text, headers, signal)
      if (ticket.hashes.size >= MAX_VARIANTS) fail('HOST_PROMPT_REQUEST_LIMIT')
      const value: unknown = JSON.parse(text)
      if (!record(value)) fail('HOST_PROMPT_REQUEST_UNAVAILABLE')
      const responses = ticket.protocol === 'openai' && Array.isArray(value.input) && value.messages === undefined
      const source = responses ? value.input : value.messages
      if (!Array.isArray(source)) fail('HOST_PROMPT_REQUEST_UNAVAILABLE')
      const partType = responses ? 'input_text' : 'text'
      const result: unknown[] = []
      let index = 0
      for (const raw of source) {
        if (!record(raw)) fail('HOST_PROMPT_REQUEST_UNAVAILABLE')
        if (raw.role !== 'user') { result.push(raw); continue }
        const content = typeof raw.content === 'string' ? [{ type: partType, text: raw.content }] : raw.content
        if (!Array.isArray(content)) fail('HOST_PROMPT_REQUEST_UNAVAILABLE')
        if (ticket.protocol === 'anthropic' && content.length && content.every(part => record(part) && part.type === 'tool_result')) { result.push(raw); continue }
        if (!content.every(part => record(part) && part.type === partType && typeof part.text === 'string')) fail('HOST_PROMPT_REQUEST_UNAVAILABLE')
        const entry = ticket.entries[index++]
        if (!entry || !same(content.map(part => part.text), entry.text)) fail('HOST_PROMPT_REQUEST_UNAVAILABLE')
        const claude = entry.contexts.filter(row => row.dialect === 'claude-code').sort((a, b) => a.completionOrder - b.completionOrder).map(row => ({ type: partType, text: `<system-reminder>\nUserPromptSubmit hook ${row.action.channel === 'stdout' ? 'success' : 'additional context'}: ${row.action.text}\n</system-reminder>` }))
        result.push(claude.length ? { ...raw, content: [...claude, ...content] } : raw)
        for (const row of entry.contexts) {
          if (row.dialect !== 'codex') continue
          if (ticket.protocol === 'anthropic') fail('HOST_PROMPT_ROLE_UNAVAILABLE')
          result.push(responses ? { type: 'message', role: 'developer', content: [{ type: partType, text: row.action.text }] } : { role: 'developer', content: row.action.text })
        }
      }
      if (index !== ticket.entries.length) fail('HOST_PROMPT_REQUEST_UNAVAILABLE')
      const output = JSON.stringify({ ...value, [responses ? 'input' : 'messages']: result })
      if (Buffer.byteLength(output) > MAX_BYTES) fail('HOST_PROMPT_REQUEST_LIMIT')
      if (signal.aborted) fail('HOST_PROMPT_CANCELLED')
      ticket.hashes.set(fingerprint, hash(output))
      return projectedRequest(request, output, headers, signal)
    } catch (error) {
      if (signal.aborted) throw new HostHookError('HOST_PROMPT_CANCELLED', 'cancelled')
      if (error instanceof HostHookError) throw error
      throw new HostHookError('HOST_PROMPT_REQUEST_UNAVAILABLE', 'unsupported')
    }
  }

  dispose(): void {
    this.lifetime.abort()
    for (const state of this.sessions.values()) state.cleanup()
  }
  inspect() { return Object.freeze({ prompts: this.prompts, bytes: this.bytes, tickets: this.tickets.size, sessions: this.sessions.size }) }
}
