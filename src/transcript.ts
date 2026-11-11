import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, open, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { CONTRACT_VERSIONS } from './contracts.js'
import type { HostVersion } from './contracts.js'
import { HostHookError } from './host-errors.js'
import type { HostToolEvent } from './tool-types.js'
import type { HostPromptEvent } from './prompt-types.js'
import { HookServiceError, runService } from './service-execution.js'
import type { SessionSnapshot } from './sessions.js'
import { nativeToolInput, toolName } from './tool-schema.js'
import type { JsonValue } from './types.js'
import type { DispatchResult } from './engine.js'
import { PromptAttachments } from './prompt-attachments.js'
import { ModelContext } from './model-context.js'
import type { HostModelEvent } from './model-types.js'
import type { StopDelivery, StopEvent } from './stop.js'
import { StopRecords } from './stop-records.js'
import type { StopModelBlocks, StopContinuationOptions, StopInterruptionReceipt, StopInterruptedModel, StopAbortedAssistant } from './stop-records.js'

const HISTORY_MS = 5000
const MAX_MESSAGES = 10000
const MAX_BYTES = 32 * 1024 * 1024
const MAX_CALLS = 20000
const MAX_ORIGINAL_BYTES = 64 * 1024 * 1024
const MAX_PENDING = 1024
const TRANSCRIPT_NAMESPACE = Buffer.from('6ba7b8119dad11d180b400c04fd430c8', 'hex')
const V1_BOOKKEEPING = new Set(['step-start', 'step-finish'])
const V2_BOOKKEEPING = new Set(['agent-switched', 'model-switched', 'idle'])
export function isV2Bookkeeping(type: unknown): boolean { return typeof type === 'string' && V2_BOOKKEEPING.has(type) }
const FINISH: Readonly<Record<string, string>> = Object.freeze({ stop: 'end_turn', 'end-turn': 'end_turn', 'tool-calls': 'tool_use', length: 'max_tokens' })
type TranscriptEvent = HostToolEvent | HostPromptEvent | StopEvent

export interface TranscriptHistory {
  readonly id: string
  readonly parentID?: string
  readonly messages: readonly unknown[]
}
export interface TranscriptService {
  observeModel?(event: HostModelEvent, session: SessionSnapshot): void
  admitPrompt?(event: HostPromptEvent, session: SessionSnapshot, dispatch: DispatchResult): void
  admitStop?(delivery: StopDelivery): readonly string[]
  stopModelInput?(delivery: StopDelivery): StopModelBlocks
  admitStopInterruption?(event: StopEvent, session: SessionSnapshot, receipt: StopInterruptionReceipt): StopInterruptedModel
  retireStopContinuation?(event: StopEvent, session: SessionSnapshot, row: unknown, assistant: unknown, evidence: StopAbortedAssistant): void
  admitContinuation?(delivery: StopDelivery, readback: unknown): void
  reserveContinuation?(delivery: StopDelivery, input: unknown, options?: StopContinuationOptions): TranscriptContinuationReservation
  observe(event: HostToolEvent, session: SessionSnapshot): void
  prepare(event: TranscriptEvent, session: SessionSnapshot, signal: AbortSignal): Promise<string>
  dispose(): Promise<void>
}
export interface TranscriptContinuationReservation { readonly admit: (readback: unknown) => void; readonly suppress?: (readback: unknown, previousID: string) => void; readonly release: () => void }
interface Options {
  readonly host: HostVersion
  readonly directory: string
  readonly temporaryParent?: string
  readonly now?: () => number
  readonly history: (event: TranscriptEvent, signal: AbortSignal) => Promise<TranscriptHistory>
}
interface Tool {
  readonly id: string
  readonly name: string
  readonly state: Record<string, unknown>
  readonly time: Record<string, unknown>
}
interface Message {
  readonly id: string
  readonly role: 'user' | 'assistant' | 'synthetic'
  readonly created: number
  readonly turnID: string
  readonly model?: string
  readonly finish?: string
  readonly content: readonly (string | Tool)[]
}
function fail(code: string): never { throw new HostHookError(code, code === 'TRANSCRIPT_CANCELLED' ? 'cancelled' : 'unsupported') }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function object(value: unknown): Record<string, unknown> { return record(value) ? value : fail('TRANSCRIPT_SCHEMA_INVALID') }
function string(value: unknown): string { return typeof value === 'string' ? value : fail('TRANSCRIPT_SCHEMA_INVALID') }
function array(value: unknown): readonly unknown[] { return Array.isArray(value) ? value : fail('TRANSCRIPT_SCHEMA_INVALID') }
function millis(value: unknown): number { return typeof value === 'number' && Number.isFinite(value) && !Number.isNaN(new Date(value).getTime()) ? value : fail('TRANSCRIPT_SCHEMA_INVALID') }
function key(sessionID: string, turnID: string, callID: string): string { return JSON.stringify([sessionID, turnID, callID]) }
function completionSignature(message: Message): string { return createHash('sha256').update(JSON.stringify(message)).digest('hex') }
function uuid(value: string): string {
  const bytes = createHash('sha1').update(TRANSCRIPT_NAMESPACE).update(value).digest().subarray(0, 16)
  bytes[6] = (bytes[6]! & 0x0f) | 0x50
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-')
}
function snapshot<T>(value: T): T {
  try {
    const text = JSON.stringify(value, (_key, item: unknown) => {
      if (typeof item === 'number' && !Number.isFinite(item) || ['bigint', 'symbol', 'function'].includes(typeof item)) throw new Error()
      return item
    })
    if (text === undefined || Buffer.byteLength(text) > MAX_BYTES) return fail('TRANSCRIPT_SIZE_LIMIT')
    return JSON.parse(text) as T
  } catch (error) { if (error instanceof HostHookError) throw error; return fail('TRANSCRIPT_SCHEMA_INVALID') }
}

function messages(host: HostVersion, sessionID: string, input: readonly unknown[], stops: StopRecords): readonly Message[] {
  if (input.length > MAX_MESSAGES) fail('TRANSCRIPT_MESSAGE_LIMIT')
  let turnID: string | undefined
  let previousID: string | undefined
  let previousRawID: string | undefined
  const seen = new Set<string>()
  const completions = new Set<string>()
  return input.flatMap(raw => {
    const row = object(raw)
    const info = host === 'v1' ? object(row.info) : row
    if (host === 'v1' && info.sessionID !== sessionID) fail('TRANSCRIPT_SESSION_MISMATCH')
    const role = host === 'v1' ? info.role : row.type
    if (host === 'v2' && isV2Bookkeeping(role)) return []
    if (role !== 'user' && role !== 'assistant' && !(host === 'v2' && role === 'synthetic')) return fail('TRANSCRIPT_CONTENT_UNSUPPORTED')
    const id = string(info.id)
    if (!id || seen.has(id)) fail('TRANSCRIPT_MESSAGE_ID_INVALID')
    seen.add(id)
    const preceding = previousRawID
    previousRawID = id
    if (host === 'v2' && stops.suppresses(sessionID, row, completions, preceding)) return []
    if (role === 'synthetic') stops.validateContinuation(sessionID, row, previousID, turnID)
    if (role === 'assistant') completions.add(id)
    if (role === 'user') turnID = id
    if (!turnID || host === 'v1' && role === 'assistant' && info.parentID !== turnID) fail('TRANSCRIPT_TURN_UNAVAILABLE')
    const created = millis(object(info.time).created)
    const content: (string | Tool)[] = []
    if (host === 'v2' && (role === 'user' || role === 'synthetic')) {
      for (const field of ['files', 'agents', 'skills']) if (row[field] !== undefined && array(row[field]).length) fail('TRANSCRIPT_CONTENT_UNSUPPORTED')
      content.push(string(row.text))
    } else {
      for (const rawPart of array(host === 'v1' ? row.parts : row.content)) {
        const part = object(rawPart)
        if (host === 'v1' && V1_BOOKKEEPING.has(String(part.type))) continue
        if (part.type === 'text') {
          if (part.synthetic === true || part.ignored === true) fail('TRANSCRIPT_CONTENT_UNSUPPORTED')
          content.push(string(part.text))
        } else if (part.type === 'tool' && role === 'assistant') {
          const state = object(part.state)
          if (!['pending', 'running', 'completed', 'error'].includes(String(state.status))) fail('TRANSCRIPT_TOOL_STATE_UNSUPPORTED')
          content.push({ id: string(host === 'v1' ? part.callID : part.id), name: string(host === 'v1' ? part.tool : part.name), state, time: object(host === 'v1' ? state.time ?? {} : part.time ?? {}) })
        } else fail('TRANSCRIPT_CONTENT_UNSUPPORTED')
      }
    }
    const model = role === 'assistant' ? string(host === 'v1' ? info.modelID : object(row.model).id) : undefined
    const finish = info.finish === undefined ? undefined : string(info.finish)
    previousID = id
    return [{ id, role, created, turnID, content, ...(model ? { model } : {}), ...(finish ? { finish } : {}) }]
  })
}

export class ClaudeTranscript implements TranscriptService {
  private readonly options: Options
  private readonly originals = new Map<string, Readonly<Record<string, JsonValue>>>()
  private readonly serial = new Map<string, Promise<unknown>>()
  private readonly published = new Set<string>()
  private readonly prompts = new PromptAttachments()
  private readonly stops = new StopRecords()
  private readonly models: ModelContext
  private readonly lifetime = new AbortController()
  private directory: Promise<string> | undefined
  private directoryPath: string | undefined
  private disposing: Promise<void> | undefined
  private originalBytes = 0
  private pendingCount = 0

  constructor(options: Options) {
    if (!['v1', 'v2'].includes(options.host) || !isAbsolute(options.directory) || options.temporaryParent !== undefined && !isAbsolute(options.temporaryParent)) fail('TRANSCRIPT_OPTIONS_INVALID')
    this.options = { ...options }
    this.models = new ModelContext(options.now)
  }

  observeModel(event: HostModelEvent, session: SessionSnapshot): void {
    if (event.host !== this.options.host) fail('TRANSCRIPT_HOST_MISMATCH')
    if (event.sessionID !== session.sessionID || event.messageID !== session.turnID || event.signal.aborted) throw new HostHookError('TRANSCRIPT_MODEL_CANCELLED', 'cancelled')
    this.models.observe(session)
  }

  admitPrompt(event: HostPromptEvent, session: SessionSnapshot, dispatch: DispatchResult): void {
    if (event.host !== this.options.host) fail('TRANSCRIPT_HOST_MISMATCH')
    this.prompts.admit(event, session, dispatch)
  }

  admitStop(delivery: StopDelivery): readonly string[] {
    this.stopHost(delivery)
    return this.stops.admit(delivery)
  }

  stopModelInput(delivery: StopDelivery): StopModelBlocks {
    this.stopHost(delivery)
    return this.stops.modelInput(delivery)
  }

  admitContinuation(delivery: StopDelivery, readback: unknown): void {
    this.stopHost(delivery)
    this.stops.admitContinuation(delivery, snapshot(readback) as JsonValue)
  }

  reserveContinuation(delivery: StopDelivery, input: unknown, options?: StopContinuationOptions): TranscriptContinuationReservation {
    this.stopHost(delivery)
    const reservation = this.stops.reserveContinuation(delivery, snapshot(input) as JsonValue, options)
    return Object.freeze({ admit: (readback: unknown) => reservation.admit(snapshot(readback) as JsonValue), ...(reservation.suppress ? { suppress: (readback: unknown, previousID: string) => reservation.suppress!(snapshot(readback) as JsonValue, previousID) } : {}), release: reservation.release })
  }

  admitStopInterruption(event: StopEvent, session: SessionSnapshot, receipt: StopInterruptionReceipt): StopInterruptedModel {
    this.stopHost({ event })
    const owner = Object.freeze({ ...session })
    return this.stops.admitInterruption(snapshot(event), owner, snapshot(receipt))
  }

  retireStopContinuation(event: StopEvent, session: SessionSnapshot, row: unknown, assistant: unknown, evidence: StopAbortedAssistant): void {
    this.stopHost({ event })
    const owner = Object.freeze({ ...session })
    this.stops.retireContinuation(snapshot(event), owner, snapshot(row) as JsonValue, snapshot(assistant) as JsonValue, snapshot(evidence))
  }

  private stopHost(delivery: Pick<StopDelivery, 'event'>): void {
    if (delivery.event.host !== this.options.host) fail('TRANSCRIPT_HOST_MISMATCH')
    if (this.options.host !== 'v2') fail('TRANSCRIPT_STOP_HOST_UNSUPPORTED')
    if (delivery.event.cwd !== this.options.directory) fail('TRANSCRIPT_STOP_CWD_UNAVAILABLE')
  }

  observe(event: HostToolEvent, session: SessionSnapshot): void {
    if (event.host !== this.options.host) fail('TRANSCRIPT_HOST_MISMATCH')
    if (event.sessionID !== session.sessionID) fail('TRANSCRIPT_SESSION_MISMATCH')
    if (event.event !== 'PreToolUse') return
    if (this.lifetime.signal.aborted) fail('TRANSCRIPT_CANCELLED')
    if (!session.turnID) return
    const id = key(event.sessionID, session.turnID, event.callID)
    const input = snapshot(nativeToolInput(event.host, event.tool, event.toolInput))
    const previous = this.originals.get(id)
    if (previous && JSON.stringify(previous) !== JSON.stringify(input)) fail('TRANSCRIPT_CALL_ID_REUSED')
    if (!previous && this.originals.size >= MAX_CALLS) fail('TRANSCRIPT_CALL_LIMIT')
    const bytes = previous ? 0 : Buffer.byteLength(JSON.stringify(input)) + Buffer.byteLength(id)
    if (this.originalBytes + bytes > MAX_ORIGINAL_BYTES) fail('TRANSCRIPT_MEMORY_LIMIT')
    this.originalBytes += bytes
    this.originals.set(id, input)
  }

  prepare(event: TranscriptEvent, session: SessionSnapshot, parent: AbortSignal): Promise<string> {
    if (event.host !== this.options.host) return Promise.reject(new HostHookError('TRANSCRIPT_HOST_MISMATCH', 'unsupported'))
    if (event.sessionID !== session.sessionID) return Promise.reject(new HostHookError('TRANSCRIPT_SESSION_MISMATCH', 'unsupported'))
    if (event.event === 'Stop') {
      if (this.options.host !== 'v2') return Promise.reject(new HostHookError('TRANSCRIPT_STOP_HOST_UNSUPPORTED', 'unsupported'))
      if (event.cwd !== this.options.directory) return Promise.reject(new HostHookError('TRANSCRIPT_STOP_CWD_UNAVAILABLE', 'unsupported'))
      if (!session.turnID || event.messageID !== session.turnID) return Promise.reject(new HostHookError('TRANSCRIPT_STOP_TURN_UNAVAILABLE', 'unsupported'))
      try { event = Object.freeze(snapshot(event)); session = Object.freeze({ ...session }) } catch (error) { return Promise.reject(error) }
    }
    if (this.pendingCount >= MAX_PENDING) return Promise.reject(new HostHookError('TRANSCRIPT_PENDING_LIMIT', 'unsupported'))
    this.pendingCount++
    const signal = AbortSignal.any([parent, session.signal, ...(event.event === 'Stop' ? [session.turnSignal] : []), this.lifetime.signal])
    const previous = this.serial.get(event.sessionID) ?? Promise.resolve()
    const pending = previous.catch(() => {}).then(async () => {
      if (signal.aborted) fail('TRANSCRIPT_CANCELLED')
      const history = snapshot(await runService(HISTORY_MS, signal, signal => this.options.history(event, signal)))
      if (history.id !== event.sessionID) fail('TRANSCRIPT_SESSION_MISMATCH')
      if (history.parentID !== undefined && (typeof history.parentID !== 'string' || !history.parentID)) fail('TRANSCRIPT_SCHEMA_INVALID')
      if (!session.turnID) fail('TRANSCRIPT_TURN_UNAVAILABLE')
      if (event.event === 'UserPromptSubmit') this.prompts.begin(session)
      const entries = messages(this.options.host, event.sessionID, array(history.messages), this.stops)
      const rawContinuations = new Set(history.messages.flatMap(row => record(row) && ['user', 'assistant', 'synthetic'].includes(String(row.type)) && typeof row.id === 'string' ? [row.id] : []))
      const rows = this.project(event, entries, history.parentID !== undefined, rawContinuations)
      const text = rows.map(row => JSON.stringify(row)).join('\n') + '\n'
      if (Buffer.byteLength(text) > MAX_BYTES) fail('TRANSCRIPT_SIZE_LIMIT')
      if (signal.aborted) fail('TRANSCRIPT_CANCELLED')
      this.directory ??= mkdtemp(join(this.options.temporaryParent ?? tmpdir(), 'opencode-harness-transcripts-'))
      const directory = await this.directory
      this.directoryPath = directory
      const path = join(directory, createHash('sha256').update(event.sessionID).digest('hex') + '.jsonl')
      if (!rows.length && event.event === 'UserPromptSubmit') {
        if (this.published.has(event.sessionID)) fail('TRANSCRIPT_HISTORY_RESET_UNVERIFIED')
        return path
      }
      const temporary = join(directory, randomUUID() + '.tmp')
      try {
        const file = await open(temporary, 'wx', 0o600)
        try { await file.writeFile(text) } finally { await file.close() }
        if (signal.aborted) fail('TRANSCRIPT_CANCELLED')
        await rename(temporary, path)
        if (event.event === 'Stop') this.stops.prepare(event, session, completionSignature(entries.at(-1)!))
        this.published.add(event.sessionID)
        return path
      } finally { await rm(temporary, { force: true }) }
    }).catch((error: unknown) => {
      if (signal.aborted) return fail('TRANSCRIPT_CANCELLED')
      if (error instanceof HostHookError) throw error
      if (error instanceof HookServiceError && error.code === 'EXECUTION_TIMEOUT') return fail('TRANSCRIPT_HISTORY_TIMEOUT')
      return fail('TRANSCRIPT_UNAVAILABLE')
    })
    this.serial.set(event.sessionID, pending)
    void pending.finally(() => { this.pendingCount--; if (this.serial.get(event.sessionID) === pending) this.serial.delete(event.sessionID) }).catch(() => {})
    return pending
  }

  dispose(): Promise<void> {
    this.lifetime.abort()
    this.prompts.dispose()
    this.stops.dispose()
    this.models.dispose()
    this.disposing ??= (async () => {
      await Promise.allSettled([...this.serial.values()])
      try { if (this.directoryPath) await rm(this.directoryPath, { recursive: true, force: true }) } catch { throw new HostHookError('TRANSCRIPT_DISPOSE_FAILED', 'failed') }
    })().finally(() => {
      this.originals.clear()
      this.published.clear()
      this.originalBytes = 0
      this.disposing = undefined
    })
    return this.disposing
  }

  inspect() { return Object.freeze({ created: this.directoryPath !== undefined, disposed: this.lifetime.signal.aborted, originals: this.originals.size, originalBytes: this.originalBytes, pending: this.pendingCount, ...this.prompts.inspect(), ...this.stops.inspect(), ...this.models.inspect() }) }

  private project(event: TranscriptEvent, history: readonly Message[], sidechain: boolean, rawContinuations: ReadonlySet<string>): readonly Record<string, JsonValue>[] {
    const rows: Record<string, JsonValue>[] = []
    let parent: string | null = null
    let current = false
    const currentTurnID = history.findLast(message => message.role === 'user')?.turnID
    if (event.event === 'Stop') {
      const last = history.at(-1)
      if (!last || last.role !== 'assistant' || last.id !== event.completionID || last.turnID !== event.messageID || currentTurnID !== event.messageID || !last.finish || last.finish === 'tool-calls' || !Object.hasOwn(FINISH, last.finish)) fail('TRANSCRIPT_STOP_COMPLETION_UNAVAILABLE')
    }
    const modeled = new Set(history.filter(message => message.role === 'assistant').map(message => message.turnID))
    this.stops.validateHistory(event.sessionID, new Set(history.filter(message => message.role === 'assistant').map(message => message.id)), rawContinuations)
    if (event.event === 'UserPromptSubmit' && history.some(message => message.id === event.messageID)) fail('TRANSCRIPT_PROMPT_ALREADY_ADMITTED')
    const append = (identity: string, created: number, body: Record<string, JsonValue>) => {
      const id = uuid(JSON.stringify([event.sessionID, identity]))
      rows.push({ parentUuid: parent, isSidechain: sidechain, ...body, uuid: id, timestamp: new Date(created).toISOString(), cwd: this.options.directory, sessionId: event.sessionID, version: CONTRACT_VERSIONS['claude-code'] })
      parent = id
    }
    const push = (identity: string, created: number, role: 'user' | 'assistant', message: Record<string, JsonValue>) => append(identity, created, { type: role, message })
    for (const entry of history) {
      if (entry.role === 'synthetic') continue
      if (entry.role === 'user') {
        const content = entry.content.map(part => { if (typeof part !== 'string') return fail('TRANSCRIPT_CONTENT_UNSUPPORTED'); return part })
        push(entry.id, entry.created, 'user', { role: 'user', content: content.length === 1 ? content[0]! : content.map(text => ({ type: 'text', text })) })
        for (const attachment of this.prompts.read(event.sessionID, entry.id, content.join('\n'))) append('prompt/' + attachment.id, attachment.created, { ...attachment.body })
        const date = this.models.read(event.sessionID, entry.id, modeled.has(entry.id))
        if (date) append('date/' + date.id, date.created, { type: 'attachment', attachment: { type: 'date', date: date.date }, rendered: [{ content: `<system-reminder>\nToday's date is ${date.date}.\n</system-reminder>` }], renderedRole: 'system' })
        continue
      }
      const results: { readonly id: string; readonly content: JsonValue; readonly created: number; readonly error: boolean }[] = []
      const content: JsonValue[] = []
      for (const part of entry.content) {
        if (typeof part === 'string') { content.push({ type: 'text', text: part }); continue }
        const original = this.originals.get(key(event.sessionID, entry.turnID, part.id))
        if (!original) fail('TRANSCRIPT_ORIGINAL_INPUT_UNAVAILABLE')
        const isCurrent = event.event !== 'UserPromptSubmit' && event.event !== 'Stop' && part.id === event.callID && entry.turnID === currentTurnID
        if (isCurrent) current = true
        content.push({ type: 'tool_use', id: part.id, name: toolName(event.host, part.name), input: original })
        if (isCurrent || part.state.status === 'pending' || part.state.status === 'running') continue
        const error = part.state.status === 'error'
        let output: JsonValue
        if (error) output = typeof part.state.error === 'string' ? part.state.error : string(object(part.state.error).message)
        else if (this.options.host === 'v1') output = string(part.state.output)
        else output = array(part.state.content).map(raw => { const item = object(raw); if (item.type !== 'text') fail('TRANSCRIPT_CONTENT_UNSUPPORTED'); return { type: 'text', text: string(item.text) } })
        results.push({ id: part.id, content: output, error, created: millis(this.options.host === 'v1' ? part.time.end : part.time.completed) })
      }
      const stop = entry.finish === undefined ? content.some(item => record(item) && item.type === 'tool_use') ? 'tool_use' : null : Object.hasOwn(FINISH, entry.finish) ? FINISH[entry.finish]! : fail('TRANSCRIPT_FINISH_UNSUPPORTED')
      push(entry.id, entry.created, 'assistant', { id: entry.id, type: 'message', role: 'assistant', content, model: entry.model!, stop_reason: stop, stop_sequence: null })
      for (const result of results) push(`${entry.id}/${result.id}/result`, result.created, 'user', { role: 'user', content: [{ type: 'tool_result', tool_use_id: result.id, content: result.content, ...(result.error ? { is_error: true } : {}) }] })
      for (const record of this.stops.read(event.sessionID, entry.id, entry.turnID, completionSignature(entry))) append('stop/' + record.id, record.created, { ...record.body })
    }
    if (!current && event.event !== 'UserPromptSubmit' && event.event !== 'Stop') fail('TRANSCRIPT_CURRENT_CALL_MISSING')
    return rows
  }
}
