import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { CodexRollout } from './codex-rollout.js'
import type { CodexRolloutHistoryRecord } from './codex-rollout.js'
import { HOST_VERSIONS } from './contracts.js'
import type { HostVersion } from './contracts.js'
import { snapshotJsonObject } from './bounded-json.js'
import { HostHookError } from './host-errors.js'
import { runService } from './service-execution.js'
import type { HostToolEvent } from './tool-types.js'
import type { SessionSnapshot } from './sessions.js'
import type { JsonValue } from './types.js'

const MAX_BYTES = 32 * 1024 * 1024
const MAX_CALLS = 20000
const MAX_MESSAGES = 10000
const MAX_PENDING = 128
const HISTORY_MS = 5000
const SHELL_TOOLS = new Set(['bash', 'shell'])
export interface CodexTranscriptTool { readonly id: string; readonly name: string; readonly status: 'pending' | 'running' | 'completed' | 'error'; readonly created: number; readonly output?: string; readonly completed?: number }
export interface CodexTranscriptMessage { readonly id: string; readonly turnID: string; readonly role: 'user' | 'assistant'; readonly created: number; readonly content: readonly (string | CodexTranscriptTool)[] }
export interface CodexTranscriptHistory { readonly id: string; readonly messages: readonly CodexTranscriptMessage[] }
export interface CodexTranscriptView { readonly sessionID: string; readonly turnID: string; readonly transcriptPath: string }
export interface CodexTranscriptService {
  observe(event: HostToolEvent, session: SessionSnapshot): void
  prepare(event: HostToolEvent, session: SessionSnapshot, signal: AbortSignal): Promise<CodexTranscriptView>
  dispose(): Promise<void>
}
interface Options { readonly host: HostVersion; readonly directory: string; readonly temporaryParent?: string; readonly history: (event: HostToolEvent, signal: AbortSignal) => Promise<CodexTranscriptHistory> }
interface Original { readonly tool: string; readonly input: Readonly<Record<string, JsonValue>> }
interface Published { readonly path: string; readonly fingerprints: ReadonlyMap<string, string>; readonly layout: readonly string[] }
function fail(code: string): never { throw new HostHookError(code, code === 'CODEX_TRANSCRIPT_CANCELLED' ? 'cancelled' : 'unsupported') }
function copy<T>(value: T): T { return snapshotJsonObject({ value }, MAX_BYTES, () => fail('CODEX_TRANSCRIPT_INPUT_LIMIT')).value.value as T }
function identity(...parts: string[]): string {
  const bytes = createHash('sha1').update('opencode-harness-hooks/codex-transcript/').update(JSON.stringify(parts)).digest().subarray(0, 16)
  bytes[6] = (bytes[6]! & 0x0f) | 0x50; bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-')
}
function key(session: string, turn: string, call: string): string { return JSON.stringify([session, turn, call]) }
function iso(value: number): string { if (!Number.isFinite(value) || Number.isNaN(new Date(value).getTime())) fail('CODEX_TRANSCRIPT_HISTORY_INVALID'); return new Date(value).toISOString() }
function layout(history: CodexTranscriptHistory): readonly string[] {
  return history.messages.flatMap(message => [JSON.stringify(['message', message.id, message.turnID, message.role, message.created]), ...message.content.map((part, index) => JSON.stringify(typeof part === 'string' ? ['text', message.id, index, part] : ['tool', message.id, index, part.id, part.name]))])
}
function frameKeys(frames: readonly CodexRolloutHistoryRecord[]): readonly string[] {
  let message: JsonValue | undefined
  return frames.map(row => {
    const payload = row.payload
    if (row.type === 'response_item') {
      if (payload.type === 'message') message = payload.id
      return JSON.stringify([row.type, payload.type, payload.id ?? payload.call_id])
    }
    return JSON.stringify([row.type, payload.type, payload.turn_id ?? message])
  })
}

export class CodexTranscript implements CodexTranscriptService {
  private readonly options: Options
  private readonly rollout: CodexRollout
  private readonly originals = new Map<string, Original>()
  private readonly published = new Map<string, Published>()
  private readonly serial = new Map<string, Promise<unknown>>()
  private readonly lifetime = new AbortController()
  private originalBytes = 0
  private pending = 0
  private disposing: Promise<void> | undefined

  constructor(options: Options) {
    if (!Object.hasOwn(HOST_VERSIONS, options.host) || typeof options.directory !== 'string' || !isAbsolute(options.directory) || typeof options.history !== 'function' || options.temporaryParent !== undefined && !isAbsolute(options.temporaryParent)) fail('CODEX_TRANSCRIPT_OPTIONS_INVALID')
    this.options = { ...options }
    this.rollout = new CodexRollout({ ...(options.temporaryParent !== undefined ? { temporaryParent: options.temporaryParent } : {}) })
  }

  observe(event: HostToolEvent, session: SessionSnapshot): void {
    this.owner(event, session)
    if (event.event !== 'PreToolUse') return
    if (!session.turnID) fail('CODEX_TRANSCRIPT_TURN_UNAVAILABLE')
    const id = key(event.sessionID, session.turnID, event.callID), value = copy({ tool: event.tool, input: event.toolInput })
    const previous = this.originals.get(id)
    if (previous && JSON.stringify(previous) !== JSON.stringify(value)) fail('CODEX_TRANSCRIPT_CALL_ID_REUSED')
    if (!previous) {
      const bytes = Buffer.byteLength(JSON.stringify(value)) + Buffer.byteLength(id)
      if (this.originals.size >= MAX_CALLS || this.originalBytes + bytes > MAX_BYTES) fail('CODEX_TRANSCRIPT_INPUT_LIMIT')
      this.originals.set(id, value); this.originalBytes += bytes
    }
  }

  prepare(inputEvent: HostToolEvent, inputSession: SessionSnapshot, parent: AbortSignal): Promise<CodexTranscriptView> {
    let event: HostToolEvent, session: SessionSnapshot
    try { this.owner(inputEvent, inputSession); event = { ...inputEvent }; session = { ...inputSession } } catch (error) { return Promise.reject(error) }
    if (this.pending >= MAX_PENDING) return Promise.reject(new HostHookError('CODEX_TRANSCRIPT_PENDING_LIMIT', 'unsupported'))
    const signal = AbortSignal.any([parent, session.signal, session.turnSignal, this.lifetime.signal])
    const before = this.serial.get(event.sessionID) ?? Promise.resolve()
    this.pending++
    const operation = before.catch(() => {}).then(async () => {
      if (signal.aborted) fail('CODEX_TRANSCRIPT_CANCELLED')
      const history = copy(await runService(HISTORY_MS, signal, current => this.options.history(event, current)))
      if (history.id !== event.sessionID) fail('CODEX_TRANSCRIPT_SESSION_MISMATCH')
      if (!session.turnID || !Array.isArray(history.messages) || history.messages.length > MAX_MESSAGES) fail('CODEX_TRANSCRIPT_HISTORY_INVALID')
      if (this.published.has(event.sessionID) && !history.messages.length) fail('CODEX_TRANSCRIPT_HISTORY_RESET_UNVERIFIED')
      const sessionID = identity(this.options.directory, event.sessionID), turnID = identity(this.options.directory, event.sessionID, session.turnID)
      const frames = this.project(event, session, history), keys = frameKeys(frames), structure = layout(history)
      const fingerprints = new Map(frames.map((row, index) => [keys[index]!, createHash('sha256').update(JSON.stringify(row)).digest('hex')]))
      const published = this.published.get(event.sessionID)
      if (keys.length !== fingerprints.size) fail('CODEX_TRANSCRIPT_HISTORY_INVALID')
      if (published && (structure.length < published.layout.length || published.layout.some((value, index) => value !== structure[index]) || [...published.fingerprints].some(([id, value]) => value !== fingerprints.get(id)))) fail('CODEX_TRANSCRIPT_HISTORY_RESET_UNVERIFIED')
      const path = published ? await this.rollout.appendHistory(sessionID, frames.filter((_row, index) => !published.fingerprints.has(keys[index]!)), signal) : await this.rollout.create({ metadata: { id: sessionID, session_id: sessionID, timestamp: frames[0]!.timestamp, cwd: this.options.directory, originator: 'opencode-harness-hooks', cli_version: HOST_VERSIONS[this.options.host], source: 'unknown', history_mode: 'legacy', thread_source: 'user' }, history: frames }, signal)
      if (signal.aborted) fail('CODEX_TRANSCRIPT_CANCELLED')
      this.published.set(event.sessionID, { path, fingerprints, layout: structure })
      return { sessionID, turnID, transcriptPath: path }
    }).catch((error: unknown) => { if (signal.aborted) fail('CODEX_TRANSCRIPT_CANCELLED'); if (error instanceof HostHookError) throw error; fail('CODEX_TRANSCRIPT_UNAVAILABLE') })
    this.serial.set(event.sessionID, operation)
    void operation.finally(() => { this.pending--; if (this.serial.get(event.sessionID) === operation) this.serial.delete(event.sessionID) }).catch(() => {})
    return operation
  }

  dispose(): Promise<void> {
    this.lifetime.abort()
    this.disposing ??= (async () => {
      await Promise.allSettled([...this.serial.values()])
      try { await this.rollout.dispose() } finally { this.originals.clear(); this.published.clear(); this.originalBytes = 0 }
    })().finally(() => { this.disposing = undefined })
    return this.disposing
  }

  inspect() { return Object.freeze({ ...this.rollout.inspect(), pendingTranscripts: this.pending, originalCalls: this.originals.size, originalBytes: this.originalBytes }) }

  private owner(event: HostToolEvent, session: SessionSnapshot) {
    if (this.lifetime.signal.aborted) fail('CODEX_TRANSCRIPT_CANCELLED')
    if (event.host !== this.options.host) fail('CODEX_TRANSCRIPT_HOST_MISMATCH')
    if (event.sessionID !== session.sessionID) fail('CODEX_TRANSCRIPT_SESSION_MISMATCH')
  }

  private project(event: HostToolEvent, session: SessionSnapshot, history: CodexTranscriptHistory): CodexRolloutHistoryRecord[] {
    const rows: CodexRolloutHistoryRecord[] = [], seen = new Set<string>()
    let turn: string | undefined, found = false, lastText = ''
    for (const message of history.messages) {
      if (!message.id || seen.has(message.id) || !Array.isArray(message.content)) fail('CODEX_TRANSCRIPT_HISTORY_INVALID')
      seen.add(message.id)
      const timestamp = iso(message.created)
      if (message.role === 'user') {
        if (message.turnID !== message.id || message.content.some(part => typeof part !== 'string')) fail('CODEX_TRANSCRIPT_HISTORY_INVALID')
        if (turn) rows.push({ timestamp, type: 'event_msg', payload: { type: 'task_complete', turn_id: turn, last_agent_message: lastText } })
        turn = identity(this.options.directory, event.sessionID, message.turnID); lastText = ''
        rows.push({ timestamp, type: 'event_msg', payload: { type: 'task_started', turn_id: turn, model_context_window: null } })
      } else if (message.role !== 'assistant' || turn !== identity(this.options.directory, event.sessionID, message.turnID)) fail('CODEX_TRANSCRIPT_TURN_UNAVAILABLE')
      if (!turn) fail('CODEX_TRANSCRIPT_TURN_UNAVAILABLE')
      const attribution = { turn_id: turn }
      const appendText = (text: string, index: number) => {
        rows.push({ timestamp, type: 'response_item', payload: { type: 'message', id: 'msg_' + identity(event.sessionID, message.id, String(index)), role: message.role, content: [{ type: message.role === 'user' ? 'input_text' : 'output_text', text }], internal_chat_message_metadata_passthrough: attribution } })
        rows.push({ timestamp, type: 'event_msg', payload: message.role === 'user' ? { type: 'user_message', message: text, images: [], local_images: [], text_elements: [] } : { type: 'agent_message', message: text } })
        if (message.role === 'assistant') lastText = text
      }
      if (message.role === 'user') { appendText(message.content.join('\n'), 0); continue }
      for (const [index, part] of message.content.entries()) {
        if (typeof part === 'string') { if (part) appendText(part, index); continue }
        if (!part.id || !part.name || !['pending', 'running', 'completed', 'error'].includes(part.status)) fail('CODEX_TRANSCRIPT_HISTORY_INVALID')
        const original = this.originals.get(key(event.sessionID, message.turnID, part.id))
        if (!original && part.id !== event.callID && message.turnID === session.turnID && ['pending', 'running'].includes(part.status)) continue
        if (!original || original.tool !== part.name) fail('CODEX_TRANSCRIPT_ORIGINAL_INPUT_UNAVAILABLE')
        const shell = SHELL_TOOLS.has(original.tool)
        if (shell && typeof original.input.command !== 'string') fail('CODEX_TRANSCRIPT_HISTORY_INVALID')
        const args = shell ? { cmd: original.input.command!, ...(typeof original.input.workdir === 'string' ? { workdir: original.input.workdir } : {}) } : original.input
        rows.push({ timestamp, type: 'response_item', payload: { type: 'function_call', id: 'fc_' + identity(event.sessionID, message.turnID, part.id), name: shell ? 'exec_command' : original.tool, arguments: JSON.stringify(args), call_id: part.id, internal_chat_message_metadata_passthrough: attribution } })
        const current = part.id === event.callID && message.turnID === session.turnID
        if (current) found = true
        if (!current && ['completed', 'error'].includes(part.status)) {
          if (typeof part.output !== 'string' || part.completed === undefined) fail('CODEX_TRANSCRIPT_HISTORY_INVALID')
          rows.push({ timestamp: iso(part.completed), type: 'response_item', payload: { type: 'function_call_output', call_id: part.id, output: part.output, internal_chat_message_metadata_passthrough: attribution } })
        }
      }
    }
    if (!found || history.messages.findLast(message => message.role === 'user')?.id !== session.turnID) fail('CODEX_TRANSCRIPT_CURRENT_CALL_MISSING')
    return rows
  }
}
