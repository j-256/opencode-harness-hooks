import { createHash, randomUUID } from 'node:crypto'
import type { AttributedAction } from './engine.js'
import type { HookAction } from './effect-types.js'
import { HostHookError } from './host-errors.js'
import { runService } from './service-execution.js'
import type { SessionSnapshot } from './sessions.js'
import type { StopModelBlocks } from './stop-records.js'
import type { StartupBatch } from './startup-records.js'
import { CLAUDE_USER_INTERRUPTION } from './stop-records.js'

export const PROMPT_REQUEST_HEADER = 'x-opencode-harness-hooks-request'
const MAX_ENTRIES = 10000
const MAX_ID_BYTES = 4096
const MAX_BYTES = 32 * 1024 * 1024
const MAX_TICKETS = 1024
const MAX_VARIANTS = 128
const READ_MS = 5000
type Context = AttributedAction<Extract<HookAction, { kind: 'context' }>>
export type PromptProtocol = 'openai' | 'anthropic'
export interface PromptLayout { readonly id: string; readonly text: readonly string[] }
export interface PromptContinuationOptions { readonly reconcileCancellation?: boolean }
export interface PromptContinuationReservation { readonly admit: () => void; readonly release: () => void; readonly suppress?: () => void }
export interface PromptStopHistory extends StopModelBlocks { readonly completionID: string; readonly assistantText: readonly string[]; readonly interrupted?: true }
interface Entry { readonly kind: 'prompt' | 'continuation'; readonly turnID: string; readonly turnSignal: AbortSignal; readonly text: readonly string[]; readonly contexts: readonly Context[]; readonly projection?: readonly string[]; readonly history?: PromptStopHistory; readonly startup?: StartupBatch['model']; readonly bytes: number }
interface Layout { readonly turnID: string; readonly turnSignal: AbortSignal; readonly rows: readonly PromptLayout[] }
interface State { readonly signal: AbortSignal; readonly entries: Map<string, Entry>; readonly reservations: Map<string, Entry>; readonly retired: Map<string, Entry>; readonly cleanup: () => void; requests: AbortController; layout?: Layout }
interface Ticket { readonly sessionID: string; readonly turnID: string; readonly sessionSignal: AbortSignal; readonly turnSignal: AbortSignal; readonly signal: AbortSignal; readonly protocol: PromptProtocol; readonly entries: readonly Entry[]; readonly hashes: Map<string, string> }
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
  private continuations = 0
  private bytes = 0

  remember(session: SessionSnapshot, text: readonly string[], contexts: readonly Context[]): void {
    this.retain(session, session.turnID, text, contexts, 'prompt')
  }

  rememberContinuation(session: SessionSnapshot, messageID: string, text: readonly string[], projection?: readonly string[]): void {
    this.retain(session, messageID, text, [], 'continuation', projection)
  }

  rememberStartup(session: SessionSnapshot, input: StartupBatch['model']): void {
    if (this.lifetime.signal.aborted || session.signal.aborted || session.turnSignal.aborted) fail('HOST_PROMPT_CANCELLED')
    const state = this.sessions.get(session.sessionID), entry = session.turnID ? state?.entries.get(session.turnID) : undefined
    const strings = (value: unknown): value is readonly string[] => Array.isArray(value) && value.every(item => typeof item === 'string')
    if (!state || state.signal !== session.signal || !entry || entry.kind !== 'prompt' || entry.turnSignal !== session.turnSignal || entry.startup || !record(input) || !strings(input.claude) || !strings(input.codex)) fail('HOST_STARTUP_CONTEXT_UNAVAILABLE')
    const startup = Object.freeze({ claude: Object.freeze([...input.claude]), codex: Object.freeze([...input.codex]) })
    const bytes = Buffer.byteLength(JSON.stringify(startup))
    if (this.bytes + bytes > MAX_BYTES) fail('HOST_PROMPT_CONTEXT_LIMIT')
    this.invalidate(state)
    if (session.signal.aborted || session.turnSignal.aborted || this.lifetime.signal.aborted) fail('HOST_PROMPT_CANCELLED')
    if (this.sessions.get(session.sessionID) !== state || state.entries.get(session.turnID!) !== entry) fail('HOST_STARTUP_CONTEXT_UNAVAILABLE')
    state.entries.set(session.turnID!, { ...entry, startup, bytes: entry.bytes + bytes })
    this.bytes += bytes
  }

  rememberHistory(session: SessionSnapshot, input: PromptStopHistory): void {
    session = { ...session }
    if (this.lifetime.signal.aborted || session.signal.aborted || session.turnSignal.aborted) fail('HOST_PROMPT_CANCELLED')
    const state = this.sessions.get(session.sessionID), entry = session.turnID ? state?.entries.get(session.turnID) : undefined
    const strings = (value: unknown): value is readonly string[] => Array.isArray(value) && [...value].every(text => typeof text === 'string')
    if (!state || state.signal !== session.signal || !entry || entry.kind !== 'prompt' || entry.turnSignal !== session.turnSignal || entry.history || !record(input) || typeof input.completionID !== 'string' || !input.completionID || input.completionID.includes('\0') || Buffer.byteLength(input.completionID) > MAX_ID_BYTES || state.entries.has(input.completionID) || [...state.entries.values()].some(row => row.history?.completionID === input.completionID) || !strings(input.assistantText) || !input.assistantText.length || !strings(input.reminders) || !strings(input.feedback) || input.interrupted !== undefined && input.interrupted !== true || !input.reminders.length && !input.feedback.length && !input.interrupted) fail('HOST_PROMPT_HISTORY_UNAVAILABLE')
    const history = Object.freeze({ completionID: input.completionID, assistantText: Object.freeze([...input.assistantText]), reminders: Object.freeze([...input.reminders]), feedback: Object.freeze([...input.feedback]), ...(input.interrupted ? { interrupted: true as const } : {}) })
    const bytes = Buffer.byteLength(JSON.stringify(history))
    if (this.bytes + bytes > MAX_BYTES) fail('HOST_PROMPT_CONTEXT_LIMIT')
    this.invalidate(state)
    if (session.signal.aborted || session.turnSignal.aborted || this.lifetime.signal.aborted) fail('HOST_PROMPT_CANCELLED')
    if (this.sessions.get(session.sessionID) !== state || state.entries.get(session.turnID!) !== entry) fail('HOST_PROMPT_HISTORY_UNAVAILABLE')
    if (this.bytes + bytes > MAX_BYTES) fail('HOST_PROMPT_CONTEXT_LIMIT')
    state.entries.set(session.turnID!, { ...entry, history, bytes: entry.bytes + bytes })
    this.bytes += bytes
  }

  reserveContinuation(session: SessionSnapshot, messageID: string, text: readonly string[], projection: readonly string[], options: PromptContinuationOptions = {}): PromptContinuationReservation {
    session = { ...session }
    const { state, entry } = this.retain(session, messageID, text, [], 'continuation', projection, true)
    const reconcileCancellation = options.reconcileCancellation === true
    const signal = AbortSignal.any([session.signal, this.lifetime.signal, ...(reconcileCancellation ? [] : [session.turnSignal])])
    let phase: 'pending' | 'admitted' | 'released' | 'suppressed' = 'pending'
    const release = () => {
      if (phase !== 'pending') return
      phase = 'released'
      signal.removeEventListener('abort', release)
      if (this.sessions.get(session.sessionID) !== state || state.reservations.get(messageID) !== entry) return
      state.reservations.delete(messageID)
      this.continuations--
      this.bytes -= entry.bytes
      if (!state.reservations.size && !state.entries.size && !state.retired.size) state.cleanup()
    }
    signal.addEventListener('abort', release, { once: true })
    return Object.freeze({
      admit: () => {
        if (signal.aborted || session.turnSignal.aborted) fail('HOST_PROMPT_CANCELLED')
        if (phase !== 'pending' || this.sessions.get(session.sessionID) !== state || state.reservations.get(messageID) !== entry) fail('HOST_PROMPT_RESERVATION_UNAVAILABLE')
        state.reservations.delete(messageID)
        state.entries.set(messageID, entry)
        phase = 'admitted'
        signal.removeEventListener('abort', release)
        this.invalidate(state)
      },
      ...(reconcileCancellation ? { suppress: () => {
        if (signal.aborted) fail('HOST_PROMPT_CANCELLED')
        if (!session.turnSignal.aborted) fail('HOST_PROMPT_RETIREMENT_UNAVAILABLE')
        if (phase !== 'pending' || this.sessions.get(session.sessionID) !== state || state.reservations.get(messageID) !== entry) fail('HOST_PROMPT_RESERVATION_UNAVAILABLE')
        this.invalidate(state)
        if (signal.aborted || this.sessions.get(session.sessionID) !== state || state.reservations.get(messageID) !== entry) fail('HOST_PROMPT_CANCELLED')
        state.reservations.delete(messageID)
        state.retired.set(messageID, entry)
        phase = 'suppressed'
        signal.removeEventListener('abort', release)
      } } : {}),
      release,
    })
  }

  retireContinuation(owner: SessionSnapshot, messageID: string, text: readonly string[]): void {
    owner = { ...owner }
    if (this.lifetime.signal.aborted || owner.signal.aborted) fail('HOST_PROMPT_CANCELLED')
    if (!Array.isArray(text) || !text.every(value => typeof value === 'string')) fail('HOST_PROMPT_RETIREMENT_UNAVAILABLE')
    text = [...text]
    const state = this.sessions.get(owner.sessionID), entry = state?.entries.get(messageID)
    if (!owner.turnSignal.aborted || !state || state.signal !== owner.signal || !entry || entry.kind !== 'continuation' || entry.turnID !== owner.turnID || entry.turnSignal !== owner.turnSignal || !same(entry.text, text)) fail('HOST_PROMPT_RETIREMENT_UNAVAILABLE')
    this.invalidate(state)
    if (this.lifetime.signal.aborted || owner.signal.aborted || this.sessions.get(owner.sessionID) !== state || state.entries.get(messageID) !== entry) fail('HOST_PROMPT_CANCELLED')
    state.entries.delete(messageID)
    state.retired.set(messageID, entry)
  }

  ownsCurrentMessage(session: SessionSnapshot, messageID: string): boolean {
    if (this.lifetime.signal.aborted || session.signal.aborted || session.turnSignal.aborted || !session.turnID) return false
    const state = this.sessions.get(session.sessionID)
    if (state && state.signal !== session.signal) return false
    if (messageID === session.turnID) return true
    const entry = state?.entries.get(messageID)
    return entry?.kind === 'continuation' && entry.turnID === session.turnID && entry.turnSignal === session.turnSignal
  }

  private retain(session: SessionSnapshot, messageID: string | undefined, text: readonly string[], contexts: readonly Context[], kind: Entry['kind'], projection?: readonly string[], reserved = false): { readonly state: State; readonly entry: Entry } {
    if (this.lifetime.signal.aborted || session.signal.aborted || session.turnSignal.aborted) fail('HOST_PROMPT_CANCELLED')
    if (!session.turnID || typeof messageID !== 'string' || !messageID || messageID.includes('\0') || Buffer.byteLength(messageID) > MAX_ID_BYTES || !Array.isArray(text) || !text.length || [...text].some(value => typeof value !== 'string')) fail('HOST_PROMPT_INPUT_UNAVAILABLE')
    if (kind === 'continuation' && messageID === session.turnID) fail('HOST_PROMPT_ID_REUSED')
    if (projection !== undefined && (!Array.isArray(projection) || !projection.length || [...projection].some(value => typeof value !== 'string'))) fail('HOST_PROMPT_INPUT_UNAVAILABLE')
    if (contexts.some(row => row.action.placement !== 'model' || row.dialect === 'claude-code' && !['stdout', 'additionalContext'].includes(row.action.channel ?? ''))) fail('HOST_PROMPT_CONTEXT_UNAVAILABLE')
    let state = this.sessions.get(session.sessionID)
    if (state && state.signal !== session.signal) fail('HOST_PROMPT_SESSION_MISMATCH')
    const bytes = Buffer.byteLength(JSON.stringify([kind, messageID, session.turnID, text, contexts, projection]))
    this.capacity(state, messageID, bytes)
    const entry = { kind, turnID: session.turnID, turnSignal: session.turnSignal, text: Object.freeze([...text]), contexts: Object.freeze(structuredClone(contexts)), ...(projection ? { projection: Object.freeze([...projection]) } : {}), bytes }
    if (!state) {
      const cleanup = () => {
        const previous = this.sessions.get(session.sessionID)
        if (!previous) return
        for (const entry of [...previous.entries.values(), ...previous.reservations.values(), ...previous.retired.values()]) {
          this.bytes -= entry.bytes
          if (entry.kind === 'prompt') this.prompts--
          else this.continuations--
        }
        this.sessions.delete(session.sessionID)
        previous.entries.clear()
        previous.reservations.clear()
        previous.retired.clear()
        previous.requests.abort()
        session.signal.removeEventListener('abort', cleanup)
      }
      state = { signal: session.signal, entries: new Map(), reservations: new Map(), retired: new Map(), cleanup, requests: new AbortController() }
      this.sessions.set(session.sessionID, state)
      session.signal.addEventListener('abort', cleanup, { once: true })
    }
    this.invalidate(state)
    if (this.lifetime.signal.aborted || session.signal.aborted || session.turnSignal.aborted || this.sessions.get(session.sessionID) !== state) {
      if (this.sessions.get(session.sessionID) === state && !state.entries.size && !state.reservations.size && !state.retired.size) state.cleanup()
      fail('HOST_PROMPT_CANCELLED')
    }
    this.capacity(state, messageID, bytes)
    const entries = reserved ? state.reservations : state.entries
    entries.set(messageID, entry)
    if (kind === 'prompt') this.prompts++
    else this.continuations++
    this.bytes += bytes
    return { state, entry }
  }

  private invalidate(state: State): void {
    delete state.layout
    const previous = state.requests
    state.requests = new AbortController()
    previous.abort()
  }

  private capacity(state: State | undefined, messageID: string, bytes: number): void {
    if (state?.entries.has(messageID) || state?.reservations.has(messageID) || state?.retired.has(messageID)) fail('HOST_PROMPT_ID_REUSED')
    if (this.prompts + this.continuations >= MAX_ENTRIES || this.bytes + bytes > MAX_BYTES) fail('HOST_PROMPT_CONTEXT_LIMIT')
  }

  layout(session: SessionSnapshot, input: readonly PromptLayout[]): void {
    const state = this.sessions.get(session.sessionID)
    if (state?.reservations.size) fail('HOST_PROMPT_ADMISSION_PENDING')
    if (!state || !session.turnID || !this.ownsCurrentMessage(session, input.at(-1)?.id ?? '') || input.length !== state.entries.size) fail('HOST_PROMPT_LAYOUT_UNAVAILABLE')
    const seen = new Set<string>()
    const expected = [...state.entries.keys()]
    for (const [index, row] of input.entries()) {
      const entry = state.entries.get(row.id)
      if (!entry || seen.has(row.id) || expected[index] !== row.id || !same(entry.text, row.text)) fail('HOST_PROMPT_LAYOUT_UNAVAILABLE')
      seen.add(row.id)
    }
    state.layout = Object.freeze({ turnID: session.turnID, turnSignal: session.turnSignal, rows: Object.freeze(input.map(row => Object.freeze({ id: row.id, text: Object.freeze([...row.text]) }))) })
  }

  issue(session: SessionSnapshot, protocol: PromptProtocol = 'openai'): string | undefined {
    const state = this.sessions.get(session.sessionID)
    if (state?.reservations.size) fail('HOST_PROMPT_ADMISSION_PENDING')
    if (!state || state.signal !== session.signal || !state.layout || !session.turnID || state.layout.turnID !== session.turnID || state.layout.turnSignal !== session.turnSignal || session.signal.aborted || session.turnSignal.aborted || this.lifetime.signal.aborted) fail('HOST_PROMPT_LAYOUT_UNAVAILABLE')
    const entries = state.layout.rows.map(row => state.entries.get(row.id)!)
    if (!entries.some(entry => entry.contexts.length || entry.projection || entry.history || entry.startup?.claude.length || entry.startup?.codex.length)) return undefined
    if (this.tickets.size >= MAX_TICKETS) fail('HOST_PROMPT_REQUEST_LIMIT')
    const id = randomUUID()
    const signal = AbortSignal.any([session.signal, session.turnSignal, this.lifetime.signal, state.requests.signal])
    this.tickets.set(id, { sessionID: session.sessionID, turnID: session.turnID, sessionSignal: session.signal, turnSignal: session.turnSignal, signal, protocol, entries, hashes: new Map() })
    signal.addEventListener('abort', () => { this.tickets.delete(id) }, { once: true })
    return id
  }

  owner(token: string): { readonly sessionID: string; readonly messageID: string } | undefined {
    const ticket = this.tickets.get(token)
    return ticket ? { sessionID: ticket.sessionID, messageID: ticket.turnID } : undefined
  }

  async project(request: Request, token: string, expected?: SessionSnapshot): Promise<Request> {
    const ticket = this.tickets.get(token)
    if (!ticket || ticket.signal.aborted || expected && (ticket.sessionID !== expected.sessionID || ticket.turnID !== expected.turnID || ticket.sessionSignal !== expected.signal || ticket.turnSignal !== expected.turnSignal || expected.turnSignal.aborted)) fail('HOST_PROMPT_REQUEST_UNAVAILABLE')
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
      for (const [position, raw] of source.entries()) {
        if (!record(raw)) fail('HOST_PROMPT_REQUEST_UNAVAILABLE')
        if (raw.role !== 'user') { result.push(raw); continue }
        const content = typeof raw.content === 'string' ? [{ type: partType, text: raw.content }] : raw.content
        if (!Array.isArray(content)) fail('HOST_PROMPT_REQUEST_UNAVAILABLE')
        if (ticket.protocol === 'anthropic' && content.length && content.every(part => record(part) && part.type === 'tool_result')) { result.push(raw); continue }
        if (!content.every(part => record(part) && part.type === partType && typeof part.text === 'string')) fail('HOST_PROMPT_REQUEST_UNAVAILABLE')
        const entry = ticket.entries[index++]
        if (!entry || !same(content.map(part => part.text), entry.text)) fail('HOST_PROMPT_REQUEST_UNAVAILABLE')
        if (entry.projection) {
          result.push({ ...raw, content: entry.projection.map(text => ({ type: partType, text })) })
          continue
        }
        for (const text of entry.startup?.codex ?? []) {
          if (ticket.protocol === 'anthropic') fail('HOST_PROMPT_ROLE_UNAVAILABLE')
          result.push(responses ? { type: 'message', role: 'developer', content: [{ type: partType, text }] } : { role: 'developer', content: text })
        }
        const claude = [...(entry.startup?.claude ?? []).map(text => ({ type: partType, text })), ...entry.contexts.filter(row => row.dialect === 'claude-code').sort((a, b) => a.completionOrder - b.completionOrder).map(row => ({ type: partType, text: `<system-reminder>\nUserPromptSubmit hook ${row.action.channel === 'stdout' ? 'success' : 'additional context'}: ${row.action.text}\n</system-reminder>` }))]
        const history = entry.history
        if (history) {
          const previous = source[position - 1]
          if (!record(previous) || previous.role !== 'assistant' || previous.function_call != null || previous.tool_calls !== undefined && (!Array.isArray(previous.tool_calls) || previous.tool_calls.length)) fail('HOST_PROMPT_HISTORY_UNAVAILABLE')
          const parts = typeof previous.content === 'string' ? [{ type: 'text', text: previous.content }] : previous.content
          if (!Array.isArray(parts) || !parts.every(part => record(part) && ['text', 'output_text'].includes(String(part.type)) && typeof part.text === 'string') || !same(parts.map(part => part.text), history.assistantText)) fail('HOST_PROMPT_HISTORY_UNAVAILABLE')
          const reminders = history.reminders.map(text => ({ type: partType, text }))
          const current = claude.map((part, index) => ({ ...part, text: part.text + ((history.feedback.length || history.interrupted) && index === claude.length - 1 ? '\n' : '') }))
          const feedback = history.feedback.map(text => ({ type: partType, text: text + '\n' }))
          const interruption = history.interrupted ? [{ type: partType, text: CLAUDE_USER_INTERRUPTION + '\n' }] : []
          result.push({ ...raw, content: [...reminders, ...current, ...feedback, ...interruption, ...content] })
        } else result.push(claude.length ? { ...raw, content: [...claude, ...content] } : raw)
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
  inspect() { return Object.freeze({ prompts: this.prompts, continuations: this.continuations, bytes: this.bytes, tickets: this.tickets.size, sessions: this.sessions.size }) }
}
