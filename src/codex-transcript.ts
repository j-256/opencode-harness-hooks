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
import type { SessionStartEvent } from './session-start.js'
import { OriginalInputs } from './original-inputs.js'
import { SESSION_SNAPSHOT_VERSION, sessionSnapshot, snapshotCopy, snapshotID, snapshotObject } from './session-snapshot.js'

const MAX_BYTES = 32 * 1024 * 1024
const MAX_CALLS = 20000
const MAX_MESSAGES = 10000
const MAX_PENDING = 128
const MAX_ID_BYTES = 4096
const HISTORY_MS = 5000
const SHELL_TOOLS = new Set(['bash', 'shell'])
const MILLISECONDS_PER_SECOND = 1000
export interface CodexTranscriptTool { readonly id: string; readonly name: string; readonly status: 'pending' | 'running' | 'completed' | 'error'; readonly created: number; readonly output?: string; readonly completed?: number }
export interface CodexTranscriptMessage { readonly id: string; readonly turnID: string; readonly role: 'user' | 'assistant'; readonly created: number; readonly content: readonly (string | CodexTranscriptTool)[] }
export interface CodexTranscriptHistory { readonly id: string; readonly messages: readonly CodexTranscriptMessage[] }
export interface CodexTranscriptView { readonly sessionID: string; readonly turnID: string; readonly transcriptPath: string }
export interface CodexTranscriptService {
  hasStart?(sessionID: string, activationID: string): boolean
  prepareStart?(event: SessionStartEvent, session: SessionSnapshot, signal: AbortSignal): Promise<Omit<CodexTranscriptView, 'turnID'>>
  rememberStart?(session: SessionSnapshot, activationID: string, contexts: readonly string[]): void
  revokeStart?(session: SessionSnapshot, activationID: string): void
  bindStart?(session: SessionSnapshot, activationID: string, messageID: string): void
  unbindStart?(session: SessionSnapshot, activationID: string, messageID: string): void
  observe(event: HostToolEvent, session: SessionSnapshot): void
  prepare(event: HostToolEvent, session: SessionSnapshot, signal: AbortSignal): Promise<CodexTranscriptView>
  dispose(): Promise<void>
}
interface Options { readonly host: HostVersion; readonly directory: string; readonly temporaryParent?: string; readonly history: (event: HostToolEvent | SessionStartEvent, signal: AbortSignal) => Promise<CodexTranscriptHistory> }
interface Published { readonly path?: string; readonly created: string; readonly fingerprints: ReadonlyMap<string, string>; readonly layout: readonly string[] }
interface Startup { readonly contexts: readonly string[]; readonly created: number; messageID?: string }
interface Startups { readonly signal: AbortSignal; readonly batches: Map<string, Startup>; readonly cleanup: () => void; bytes: number }
function fail(code: string): never { throw new HostHookError(code, code === 'CODEX_TRANSCRIPT_CANCELLED' ? 'cancelled' : 'unsupported') }
function copy<T>(value: T): T { return snapshotJsonObject({ value }, MAX_BYTES, () => fail('CODEX_TRANSCRIPT_INPUT_LIMIT')).value.value as T }
function identity(...parts: string[]): string {
  const bytes = createHash('sha1').update('opencode-harness-hooks/codex-transcript/').update(JSON.stringify(parts)).digest().subarray(0, 16)
  bytes[6] = (bytes[6]! & 0x0f) | 0x50; bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-')
}
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
  private readonly originals = new OriginalInputs({ maxCalls: MAX_CALLS, maxBytes: MAX_BYTES, limitCode: 'CODEX_TRANSCRIPT_INPUT_LIMIT', bytesCode: 'CODEX_TRANSCRIPT_INPUT_LIMIT', reusedCode: 'CODEX_TRANSCRIPT_CALL_ID_REUSED' })
  private readonly published = new Map<string, Published>()
  private readonly starts = new Map<string, Startups>()
  private readonly serial = new Map<string, Promise<unknown>>()
  private readonly lifetime = new AbortController()
  private startupBytes = 0
  private startupBatches = 0
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
    this.originals.remember(session, event.callID, event.tool, event.toolInput)
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
      const view = await this.publish(event.sessionID, history, this.project(event, session, history), signal)
      return { ...view, turnID: identity(this.options.directory, event.sessionID, session.turnID) }
    }).catch((error: unknown) => { if (signal.aborted) fail('CODEX_TRANSCRIPT_CANCELLED'); if (error instanceof HostHookError) throw error; fail('CODEX_TRANSCRIPT_UNAVAILABLE') })
    this.serial.set(event.sessionID, operation)
    void operation.finally(() => { this.pending--; if (this.serial.get(event.sessionID) === operation) this.serial.delete(event.sessionID) }).catch(() => {})
    return operation
  }

  prepareStart(inputEvent: SessionStartEvent, inputSession: SessionSnapshot, parent: AbortSignal): Promise<Omit<CodexTranscriptView, 'turnID'>> {
    let event: SessionStartEvent, session: SessionSnapshot
    try {
      this.owner(inputEvent, inputSession)
      if (inputEvent.cwd !== this.options.directory || inputEvent.event !== 'SessionStart') fail('CODEX_TRANSCRIPT_HOST_MISMATCH')
      event = copy(inputEvent); session = { ...inputSession }
    } catch (error) { return Promise.reject(error) }
    if (this.pending >= MAX_PENDING) return Promise.reject(new HostHookError('CODEX_TRANSCRIPT_PENDING_LIMIT', 'unsupported'))
    const signal = AbortSignal.any([parent, session.signal, this.lifetime.signal])
    const before = this.serial.get(event.sessionID) ?? Promise.resolve()
    this.pending++
    const operation = before.catch(() => {}).then(async () => {
      if (signal.aborted) fail('CODEX_TRANSCRIPT_CANCELLED')
      const history = copy(await runService(HISTORY_MS, signal, current => this.options.history(event, current)))
      if (history.id !== event.sessionID || !Array.isArray(history.messages) || history.messages.length > MAX_MESSAGES) fail('CODEX_TRANSCRIPT_HISTORY_INVALID')
      return this.publish(event.sessionID, history, this.project(event, session, history, false), signal)
    }).catch((error: unknown) => { if (signal.aborted) fail('CODEX_TRANSCRIPT_CANCELLED'); if (error instanceof HostHookError) throw error; fail('CODEX_TRANSCRIPT_UNAVAILABLE') })
    this.serial.set(event.sessionID, operation)
    void operation.finally(() => { this.pending--; if (this.serial.get(event.sessionID) === operation) this.serial.delete(event.sessionID) }).catch(() => {})
    return operation
  }

  rememberStart(session: SessionSnapshot, activationID: string, input: readonly string[]): void {
    if (this.lifetime.signal.aborted || session.signal.aborted) fail('CODEX_TRANSCRIPT_CANCELLED')
    let state = this.starts.get(session.sessionID)
    if (!activationID || activationID.includes('\0') || Buffer.byteLength(activationID) > MAX_ID_BYTES || !Array.isArray(input) || !input.every(text => typeof text === 'string') || state && (state.signal !== session.signal || state.batches.has(activationID))) fail('CODEX_STARTUP_BINDING_INVALID')
    const contexts = Object.freeze([...input]), bytes = Buffer.byteLength(JSON.stringify([session.sessionID, activationID, contexts]))
    if (this.startupBytes + bytes > MAX_BYTES || this.startupBatches >= MAX_MESSAGES || !state && this.starts.size >= MAX_MESSAGES) fail('CODEX_TRANSCRIPT_INPUT_LIMIT')
    if (!state) {
      state = this.createStartups(session)
    }
    state.batches.set(activationID, { contexts, created: Date.now() }); state.bytes += bytes
    this.startupBytes += bytes; this.startupBatches++
  }
  hasStart(sessionID: string, activationID: string): boolean { return this.starts.get(sessionID)?.batches.has(activationID) === true }

  discardPendingPrompt(session: SessionSnapshot, messageID: string): void {
    if (this.originals.hasTurn(session.sessionID, messageID) || this.published.get(session.sessionID)?.layout.some(raw => { const row: unknown = JSON.parse(raw); return Array.isArray(row) && row[0] === 'message' && row[2] === messageID })) fail('SESSION_SNAPSHOT_PROMPT_RECONCILIATION_UNAVAILABLE')
    const state = this.starts.get(session.sessionID)
    if (!state) return
    if (state.signal !== session.signal) fail('SESSION_SNAPSHOT_OWNER_MISMATCH')
    for (const batch of state.batches.values()) if (batch.messageID === messageID) delete batch.messageID
  }

  snapshotV1(sessionID: string) {
    if (this.options.host !== 'v1') fail('SESSION_SNAPSHOT_HOST_UNSUPPORTED')
    const published = this.published.get(sessionID)
    return snapshotCopy({ kind: 'codex-transcript-v1', version: SESSION_SNAPSHOT_VERSION, sessionID, directory: this.options.directory, originals: this.originals.snapshot(sessionID), starts: [...(this.starts.get(sessionID)?.batches ?? [])].map(([activationID, batch]) => ({ activationID, contexts: batch.contexts, created: batch.created, messageID: batch.messageID ?? null })), published: published ? { created: published.created, fingerprints: [...published.fingerprints].map(([id, digest]) => ({ id, digest })), layout: published.layout } : null })
  }

  restoreV1(session: SessionSnapshot, value: unknown): () => void {
    if (this.options.host !== 'v1') fail('SESSION_SNAPSHOT_HOST_UNSUPPORTED')
    if (this.lifetime.signal.aborted) fail('CODEX_TRANSCRIPT_CANCELLED')
    const input = sessionSnapshot('codex-transcript-v1', value, session, ['directory', 'originals', 'starts', 'published'])
    if (input.directory !== this.options.directory) fail('SESSION_SNAPSHOT_OWNER_MISMATCH')
    if (this.starts.has(session.sessionID) || this.published.has(session.sessionID) || this.serial.has(session.sessionID)) fail('SESSION_SNAPSHOT_STATE_CONFLICT')
    if (!Array.isArray(input.starts)) fail('SESSION_SNAPSHOT_SCHEMA_INVALID')
    const starts = new Map<string, Startup>(); let bytes = 0
    for (const raw of input.starts) {
      const row = snapshotObject(raw, ['activationID', 'contexts', 'created', 'messageID'])
      if (!snapshotID(row.activationID) || starts.has(row.activationID) || !Array.isArray(row.contexts) || !row.contexts.every(text => typeof text === 'string') || typeof row.created !== 'number' || !Number.isFinite(row.created) || Number.isNaN(new Date(row.created).getTime()) || row.messageID !== null && !snapshotID(row.messageID)) fail('SESSION_SNAPSHOT_SCHEMA_INVALID')
      starts.set(row.activationID, { contexts: row.contexts as string[], created: row.created, ...(row.messageID === null ? {} : { messageID: row.messageID }) })
      bytes += Buffer.byteLength(JSON.stringify([session.sessionID, row.activationID, row.contexts]))
    }
    if (this.startupBytes + bytes > MAX_BYTES || this.startupBatches + starts.size > MAX_MESSAGES || starts.size && this.starts.size >= MAX_MESSAGES) fail('CODEX_TRANSCRIPT_INPUT_LIMIT')
    let published: Published | undefined
    if (input.published !== null) {
      const row = snapshotObject(input.published, ['created', 'fingerprints', 'layout']), fingerprints = new Map<string, string>()
      if (typeof row.created !== 'string' || !Number.isFinite(Date.parse(row.created)) || new Date(row.created).toISOString() !== row.created || !Array.isArray(row.layout) || !row.layout.every(item => typeof item === 'string') || !Array.isArray(row.fingerprints)) fail('SESSION_SNAPSHOT_SCHEMA_INVALID')
      for (const raw of row.fingerprints) {
        const value = snapshotObject(raw, ['id', 'digest'])
        if (typeof value.id !== 'string' || !value.id || fingerprints.has(value.id) || typeof value.digest !== 'string' || !/^[a-f0-9]{64}$/.test(value.digest)) fail('SESSION_SNAPSHOT_SCHEMA_INVALID')
        fingerprints.set(value.id, value.digest)
      }
      published = { created: row.created, fingerprints, layout: row.layout as string[] }
    }
    const undo = this.originals.restore(session, input.originals)
    let state: Startups | undefined
    if (starts.size) {
      state = this.createStartups(session)
      for (const [id, batch] of starts) state.batches.set(id, batch)
      state.bytes = bytes; this.startupBytes += bytes; this.startupBatches += starts.size
    }
    if (published) this.published.set(session.sessionID, published)
    return () => { undo(); if (state && this.starts.get(session.sessionID) === state) state.cleanup(); if (this.published.get(session.sessionID) === published) this.published.delete(session.sessionID) }
  }

  private createStartups(session: SessionSnapshot): Startups {
    const cleanup = () => { const current = this.starts.get(session.sessionID); if (!current) return; this.startupBytes -= current.bytes; this.startupBatches -= current.batches.size; this.starts.delete(session.sessionID); session.signal.removeEventListener('abort', cleanup) }
    const state: Startups = { signal: session.signal, batches: new Map(), cleanup, bytes: 0 }
    this.starts.set(session.sessionID, state); session.signal.addEventListener('abort', cleanup, { once: true })
    return state
  }

  bindStart(session: SessionSnapshot, activationID: string, messageID: string): void {
    if (this.lifetime.signal.aborted || session.signal.aborted || session.turnSignal.aborted) fail('CODEX_TRANSCRIPT_CANCELLED')
    const state = this.starts.get(session.sessionID), startup = state?.batches.get(activationID)
    if (!state || state.signal !== session.signal || !startup || !messageID || messageID.includes('\0') || session.turnID !== messageID || startup.messageID !== undefined && startup.messageID !== messageID) fail('CODEX_STARTUP_BINDING_INVALID')
    startup.messageID = messageID
  }

  revokeStart(session: SessionSnapshot, activationID: string): void {
    const state = this.starts.get(session.sessionID)
    if (!state) return
    const startup = state.batches.get(activationID)
    if (state.signal !== session.signal || startup?.messageID !== undefined) fail('CODEX_STARTUP_BINDING_INVALID')
    if (!startup) return
    const bytes = Buffer.byteLength(JSON.stringify([session.sessionID, activationID, startup.contexts]))
    state.batches.delete(activationID); state.bytes -= bytes; this.startupBytes -= bytes; this.startupBatches--
    if (!state.batches.size) { this.starts.delete(session.sessionID); session.signal.removeEventListener('abort', state.cleanup) }
  }

  unbindStart(session: SessionSnapshot, activationID: string, messageID: string): void {
    const state = this.starts.get(session.sessionID)
    if (!state) return
    const startup = state.batches.get(activationID)
    if (state.signal !== session.signal || startup?.messageID !== messageID) fail('CODEX_STARTUP_BINDING_INVALID')
    delete startup.messageID
  }

  dispose(): Promise<void> {
    this.lifetime.abort()
    for (const state of this.starts.values()) state.signal.removeEventListener('abort', state.cleanup)
    this.starts.clear(); this.startupBytes = 0; this.startupBatches = 0
    this.disposing ??= (async () => {
      await Promise.allSettled([...this.serial.values()])
      try { await this.rollout.dispose() } finally { this.originals.dispose(); this.published.clear() }
    })().finally(() => { this.disposing = undefined })
    return this.disposing
  }

  inspect() { return Object.freeze({ ...this.rollout.inspect(), pendingTranscripts: this.pending, originalCalls: this.originals.inspect().calls, originalBytes: this.originals.inspect().bytes, startupBatches: this.startupBatches, startupBytes: this.startupBytes, startupBindings: [...this.starts.values()].reduce((count, state) => count + [...state.batches.values()].filter(batch => batch.messageID !== undefined).length, 0) }) }

  private async publish(hostSessionID: string, history: CodexTranscriptHistory, frames: readonly CodexRolloutHistoryRecord[], signal: AbortSignal): Promise<Omit<CodexTranscriptView, 'turnID'>> {
    const keys = frameKeys(frames), structure = layout(history)
    const fingerprints = new Map(frames.map((row, index) => [keys[index]!, createHash('sha256').update(JSON.stringify(row)).digest('hex')]))
    const published = this.published.get(hostSessionID), sessionID = identity(this.options.directory, hostSessionID)
    if (keys.length !== fingerprints.size || published && (structure.length < published.layout.length || published.layout.some((value, index) => value !== structure[index]) || [...published.fingerprints].some(([id, value]) => value !== fingerprints.get(id)))) fail('CODEX_TRANSCRIPT_HISTORY_RESET_UNVERIFIED')
    const created = published?.created ?? frames[0]?.timestamp ?? new Date().toISOString()
    const path = published?.path ? await this.rollout.appendHistory(sessionID, frames.filter((_row, index) => !published.fingerprints.has(keys[index]!)), signal) : await this.rollout.create({ metadata: { id: sessionID, session_id: sessionID, timestamp: created, cwd: this.options.directory, originator: 'opencode-harness-hooks', cli_version: HOST_VERSIONS[this.options.host], source: 'unknown', history_mode: 'legacy', thread_source: 'user' }, history: frames }, signal)
    if (signal.aborted) fail('CODEX_TRANSCRIPT_CANCELLED')
    this.published.set(hostSessionID, { path, created, fingerprints, layout: structure })
    return { sessionID, transcriptPath: path }
  }

  private owner(event: { readonly host: HostVersion; readonly sessionID: string }, session: SessionSnapshot) {
    if (this.lifetime.signal.aborted) fail('CODEX_TRANSCRIPT_CANCELLED')
    if (event.host !== this.options.host) fail('CODEX_TRANSCRIPT_HOST_MISMATCH')
    if (event.sessionID !== session.sessionID) fail('CODEX_TRANSCRIPT_SESSION_MISMATCH')
  }

  private project(event: HostToolEvent | SessionStartEvent, session: SessionSnapshot, history: CodexTranscriptHistory, requireCurrent = true): CodexRolloutHistoryRecord[] {
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
        for (const [activationID, startup] of this.starts.get(event.sessionID)?.batches ?? []) {
          if (startup.messageID !== message.id) continue
          for (const [index, text] of startup.contexts.entries()) rows.push({ timestamp: iso(startup.created), type: 'response_item', payload: { type: 'message', id: 'msg_' + identity(event.sessionID, activationID, String(index)), role: 'developer', content: [{ type: 'input_text', text }], internal_chat_message_metadata_passthrough: { turn_id: turn, create_time: startup.created / MILLISECONDS_PER_SECOND, content_item_kinds: ['hooks.additional_context'], content_item_metadata: [{ provenance: { type: 'harness', hook: true } }] } } })
        }
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
        const original = this.originals.get(event.sessionID, message.turnID, part.id)
        if (!original && (!('callID' in event) || part.id !== event.callID) && message.turnID === session.turnID && ['pending', 'running'].includes(part.status)) continue
        if (!original || original.tool !== part.name) fail('CODEX_TRANSCRIPT_ORIGINAL_INPUT_UNAVAILABLE')
        const shell = SHELL_TOOLS.has(original.tool)
        if (shell && typeof original.input.command !== 'string') fail('CODEX_TRANSCRIPT_HISTORY_INVALID')
        const args = shell ? { cmd: original.input.command!, ...(typeof original.input.workdir === 'string' ? { workdir: original.input.workdir } : {}) } : original.input
        rows.push({ timestamp, type: 'response_item', payload: { type: 'function_call', id: 'fc_' + identity(event.sessionID, message.turnID, part.id), name: shell ? 'exec_command' : original.tool, arguments: JSON.stringify(args), call_id: part.id, internal_chat_message_metadata_passthrough: attribution } })
        const current = 'callID' in event && part.id === event.callID && message.turnID === session.turnID
        if (current) found = true
        if (!current && ['completed', 'error'].includes(part.status)) {
          if (typeof part.output !== 'string' || part.completed === undefined) fail('CODEX_TRANSCRIPT_HISTORY_INVALID')
          rows.push({ timestamp: iso(part.completed), type: 'response_item', payload: { type: 'function_call_output', call_id: part.id, output: part.output, internal_chat_message_metadata_passthrough: attribution } })
        }
      }
    }
    if (requireCurrent && (!found || history.messages.findLast(message => message.role === 'user')?.id !== session.turnID)) fail('CODEX_TRANSCRIPT_CURRENT_CALL_MISSING')
    return rows
  }
}
