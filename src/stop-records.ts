import { createHash, randomUUID } from 'node:crypto'
import { HostHookError } from './hosts/tools.js'
import type { SessionSnapshot } from './sessions.js'
import type { StopDelivery, StopEvent } from './stop.js'
import type { JsonValue } from './types.js'
import { parseClaudeStopOutput } from './protocols/claude-output.js'

const MAX_SESSIONS = 1024
const MAX_COMPLETIONS = 10000
const MAX_RECORDS = 50000
const MAX_BYTES = 32 * 1024 * 1024
const MAX_ID_BYTES = 4096
const MAX_SERIALIZED_ID_BYTES = MAX_ID_BYTES * 6 + 2
// The normalized timestamp is unavailable until the next context phase
const READBACK_OVERHEAD_BYTES = 1024
const CONTINUATION_INPUT_FIELDS = new Set(['id', 'text', 'metadata', 'description'])
const INTERRUPTION_RECEIPT_FIELDS = new Set(['eventID', 'created', 'reason', 'source'])
const FEEDBACK_PREFIX = 'Stop hook feedback:\n'
const SUCCESS_EXIT = 0
const BLOCKING_EXIT = 2
const EVENT_ERROR_EXIT = 1
const MAX_EXIT = 255
const EMPTY_STDERR = 'No stderr output'
const NONBLOCKING_ERROR_PREFIX = 'Failed with non-blocking status code: '
export const CLAUDE_USER_INTERRUPTION = '[Request interrupted by user]'

interface StopRecord { readonly id: string; readonly created: number; readonly body: Readonly<Record<string, JsonValue>> }
interface Completion {
  readonly turnID: string
  readonly turnSignal: AbortSignal
  readonly signature: string
  records?: readonly StopRecord[]
  continuable?: boolean
  continuationID?: string
  interruption?: { readonly eventID: string; readonly record: StopRecord }
  interruptionReservation?: number
  bytes: number
}
type Continuation = { readonly completionID: string; readonly turnID: string; readonly retirementBytes?: number } & (
  | { readonly phase: 'admitted'; readonly signature: string }
  | { readonly phase: 'suppressed'; readonly signature: string; readonly previousID: string }
  | { readonly phase: 'pending'; readonly expected: string; readonly bytes: number; readonly detach: () => void }
)
interface RetiredAssistant { readonly completionID: string; readonly turnID: string; readonly signature: string; readonly previousID: string }
interface State { readonly signal: AbortSignal; readonly completions: Map<string, Completion>; readonly continuations: Map<string, Continuation>; readonly cancelled: Map<string, RetiredAssistant>; readonly cleanup: () => void }
export interface StopContinuationOptions { readonly reconcileCancellation?: boolean }
export interface StopContinuationReservation { readonly admit: (readback: JsonValue) => void; readonly suppress?: (readback: JsonValue, previousID: string) => void; readonly release: () => void }
export interface StopModelBlocks { readonly reminders: readonly string[]; readonly feedback: readonly string[] }
export interface StopInterruptedModel extends StopModelBlocks { readonly interrupted: true }
export interface StopInterruptionReceipt { readonly eventID: string; readonly created: number; readonly reason: 'user'; readonly source: 'sdk-cli' }
export interface StopAbortedAssistant { readonly id: string; readonly phase: 'failed'; readonly inputID: string; readonly agent: string; readonly model: Readonly<Record<string, JsonValue>>; readonly started: number; readonly completed: number; readonly eventID: string; readonly error: Readonly<Record<string, JsonValue>> }
interface ContinuationOwner { readonly event: Pick<StopEvent, 'event' | 'sessionID' | 'messageID' | 'completionID'>; readonly session: SessionSnapshot; readonly signal: AbortSignal }
function fail(code: string): never { throw new HostHookError(code, code === 'TRANSCRIPT_CANCELLED' ? 'cancelled' : 'unsupported') }
function record(value: unknown): value is Readonly<Record<string, JsonValue>> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function signature(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value, (_key, item: unknown) => record(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)).digest('hex')
}
function validContinuation(value: JsonValue): value is Readonly<Record<string, JsonValue>> & { readonly id: string } {
  return record(value) && typeof value.id === 'string' && !!value.id && !value.id.includes('\0') && Buffer.byteLength(value.id) <= MAX_ID_BYTES && typeof value.text === 'string' && record(value.metadata) && (value.description === undefined || typeof value.description === 'string')
}
function validReadback(value: JsonValue): value is Readonly<Record<string, JsonValue>> & { readonly id: string; readonly time: Readonly<Record<string, JsonValue>> } {
  return validContinuation(value) && value.type === 'synthetic' && record(value.time) && typeof value.time.created === 'number' && Number.isFinite(value.time.created) && !Number.isNaN(new Date(value.time.created).getTime())
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) }
  return value
}

function compile({ event, dispatch }: StopDelivery): readonly StopRecord[] {
  const entries = dispatch.entries.filter(entry => entry.dialect === 'claude-code')
  if (!entries.length) return []
  if (entries.length > MAX_RECORDS) fail('TRANSCRIPT_STOP_LIMIT')
  const records: StopRecord[] = []
  const toolUseID = randomUUID()
  const errors: string[] = []
  const context: string[] = []
  const infos = new Map<number, Record<string, JsonValue>>()
  let stopReason = ''
  let prevented = false
  let hasOutput = false
  let bytes = 0
  const append = (body: Record<string, JsonValue>, created: number) => {
    const record = { id: randomUUID(), created, body }
    bytes += Buffer.byteLength(JSON.stringify(record))
    if (records.length >= MAX_RECORDS || bytes > MAX_BYTES) fail('TRANSCRIPT_STOP_LIMIT')
    records.push(record)
  }
  for (const entry of [...entries].sort((left, right) => left.completionOrder - right.completionOrder || left.configuredOrder - right.configuredOrder)) {
    const result = entry.result
    if (result.status !== 'success' && result.status !== 'failed') fail('TRANSCRIPT_STOP_RESULT_UNSUPPORTED')
    const execution = result.commandArtifact
    if (!execution || typeof execution.command !== 'string' || typeof execution.stdout !== 'string' || typeof execution.stderr !== 'string' || !Number.isFinite(execution.durationMs) || execution.durationMs < 0 || !Number.isFinite(execution.completedAt) || Number.isNaN(new Date(execution.completedAt).getTime())) fail('TRANSCRIPT_HOOK_EXECUTION_UNAVAILABLE')
    if (Buffer.byteLength(execution.stdout) + Buffer.byteLength(execution.stderr) > MAX_BYTES) fail('TRANSCRIPT_STOP_LIMIT')
    const info: Record<string, JsonValue> = { command: execution.command, durationMs: execution.durationMs }
    infos.set(entry.configuredOrder, info)
    const attachment = (value: Record<string, JsonValue>, rendered?: string, output = true) => {
      append({ type: 'attachment', attachment: { hookName: 'Stop', hookEvent: 'Stop', toolUseID, ...value }, ...(rendered === undefined ? {} : { rendered: [{ content: rendered }], renderedRole: 'system' }) }, execution.completedAt)
      hasOutput ||= output
    }
    const nonblocking = (error: string, stdout: string, exitCode: number) => {
      errors.push(error)
      attachment({ type: 'hook_non_blocking_error', stderr: error, stdout, exitCode, command: execution.command, durationMs: execution.durationMs })
    }
    if (execution.status === 'timeout') {
      if (result.status !== 'failed' || result.code !== 'EXECUTION_TIMEOUT' || result.actions.length || typeof execution.timeoutMs !== 'number' || !Number.isFinite(execution.timeoutMs) || execution.timeoutMs <= 0) fail('TRANSCRIPT_HOOK_EXECUTION_UNAVAILABLE')
      attachment({ type: 'hook_cancelled', command: execution.command, durationMs: execution.durationMs, timedOut: true, timeoutMs: execution.timeoutMs }, undefined, false)
      continue
    }
    if (execution.status !== 'exited' || execution.signal !== null || execution.exitCode === null || !Number.isSafeInteger(execution.exitCode) || execution.exitCode < SUCCESS_EXIT || execution.exitCode > MAX_EXIT) fail('TRANSCRIPT_HOOK_EXECUTION_UNAVAILABLE')
    const parsed = parseClaudeStopOutput(execution.stdout)
    if (parsed.kind === 'async' || parsed.kind === 'unmapped-syntax') fail('TRANSCRIPT_STOP_OUTPUT_UNSUPPORTED')
    if (parsed.kind === 'invalid' && (parsed.category === 'event' || execution.exitCode !== BLOCKING_EXIT)) {
      if (result.status !== 'failed' || result.code !== 'INVALID_OUTPUT' || result.actions.length) fail('TRANSCRIPT_STOP_RESULT_UNSUPPORTED')
      const stderr = execution.stderr.trim()
      const error = parsed.error + (parsed.category !== 'event' && execution.exitCode !== SUCCESS_EXIT && stderr ? `\n\nHook exited ${execution.exitCode} with stderr:\n${stderr}` : '')
      nonblocking(error, parsed.category === 'event' ? '' : execution.stdout, parsed.category === 'event' ? EVENT_ERROR_EXIT : execution.exitCode)
      continue
    }
    if (result.status === 'failed') {
      if (result.code !== 'COMMAND_FAILED' || execution.exitCode === SUCCESS_EXIT || result.actions.length) fail('TRANSCRIPT_STOP_RESULT_UNSUPPORTED')
      nonblocking(NONBLOCKING_ERROR_PREFIX + (execution.stderr.trim() || EMPTY_STDERR), execution.stdout, execution.exitCode)
      continue
    }
    if (result.actions.some(action => action.kind !== 'stop-session' && action.kind !== 'warning' && (action.kind !== 'continue-turn' || action.mode !== 'feedback' || !['decision', 'stderr', 'additionalContext'].includes(action.channel ?? '')))) fail('TRANSCRIPT_STOP_EFFECT_UNSUPPORTED')
    const decision = result.actions.find(action => action.kind === 'continue-turn' && action.channel === 'decision')
    const blockingStderr = result.actions.find(action => action.kind === 'continue-turn' && action.channel === 'stderr')
    const stopped = result.actions.find(action => action.kind === 'stop-session')
    if (decision || blockingStderr && parsed.kind !== 'sync') delete info.durationMs
    if (stopped?.kind === 'stop-session') {
      prevented = true
      stopReason = stopped.reason
      attachment({ type: 'hook_stopped_continuation', message: stopped.reason }, `<system-reminder>\nStop hook stopped continuation: ${stopped.reason}\n</system-reminder>`)
    }
    const feedback = decision?.kind === 'continue-turn' ? decision.text : blockingStderr?.kind === 'continue-turn' ? '[' + execution.command + ']: ' + blockingStderr.text : undefined
    if (feedback !== undefined) {
      hasOutput = true
      errors.push(feedback)
      append({ type: 'user', isMeta: true, promptId: event.messageID, message: { role: 'user', content: FEEDBACK_PREFIX + feedback } }, execution.completedAt)
    }
    if (decision?.kind === 'continue-turn') attachment({ type: 'hook_blocking_error', blockingError: { blockingError: decision.text, command: execution.command } }, `<system-reminder>\nStop hook blocking error from command: "${execution.command}": ${decision.text}\n</system-reminder>`)
    else if (parsed.kind === 'sync' || !blockingStderr && parsed.kind === 'plain' && (execution.stdout.trim() || execution.stderr.trim())) attachment({ type: 'hook_success', content: parsed.kind === 'plain' ? parsed.text : '', stdout: execution.stdout, stderr: execution.stderr, exitCode: execution.exitCode, command: execution.command, durationMs: execution.durationMs })
    for (const action of result.actions) if (action.kind === 'warning') attachment({ type: 'hook_system_message', content: action.text })
    for (const action of result.actions) if (action.kind === 'continue-turn' && action.channel === 'additionalContext') {
      context.push(action.text)
      attachment({ type: 'hook_additional_context', content: [action.text] }, `<system-reminder>\nStop hook additional context: ${action.text}\n</system-reminder>`)
    }
  }
  append({ type: 'system', subtype: 'stop_hook_summary', hookCount: entries.length, hookInfos: entries.map(entry => infos.get(entry.configuredOrder)!), hookErrors: errors, hookAdditionalContext: context, preventedContinuation: prevented, stopReason, hasOutput, level: 'suggestion', toolUseID }, Date.now())
  return freeze(records)
}

function modelBlocks(records: readonly StopRecord[]): StopModelBlocks {
  const reminders: string[] = []
  const feedback: string[] = []
  for (const { body } of records) {
    if (body.renderedRole === 'system' && Array.isArray(body.rendered)) {
      for (const part of body.rendered) {
        if (!record(part) || typeof part.content !== 'string') fail('TRANSCRIPT_STOP_OUTPUT_UNSUPPORTED')
        reminders.push(part.content)
      }
    }
    if (body.type === 'user' && body.isMeta === true) {
      const message = body.message
      if (!record(message) || typeof message.content !== 'string') fail('TRANSCRIPT_STOP_OUTPUT_UNSUPPORTED')
      feedback.push(message.content)
    }
  }
  return Object.freeze({ reminders: Object.freeze(reminders), feedback: Object.freeze(feedback) })
}

function model(records: readonly StopRecord[]): readonly string[] {
  const { reminders, feedback } = modelBlocks(records)
  return Object.freeze([
    ...reminders.map((text, index) => text + (index === reminders.length - 1 && feedback.length ? '\n' : '')),
    ...feedback.map((text, index) => text + (index < feedback.length - 1 ? '\n' : '')),
  ])
}

export class StopRecords {
  private readonly states = new Map<string, State>()
  private completions = 0
  private records = 0
  private reservedRecords = 0
  private bytes = 0
  private disposed = false

  prepare(event: StopEvent, session: SessionSnapshot, signature: string): void {
    if (this.disposed || session.signal.aborted || session.turnSignal.aborted) fail('TRANSCRIPT_CANCELLED')
    const state = this.states.get(event.sessionID)
    if (state && state.signal !== session.signal) fail('TRANSCRIPT_SESSION_MISMATCH')
    const previous = state?.completions.get(event.completionID)
    if (previous) {
      if (previous.turnID !== event.messageID || previous.signature !== signature) fail('TRANSCRIPT_STOP_HISTORY_CHANGED')
      return
    }
    const bytes = Buffer.byteLength(JSON.stringify([event.sessionID, event.completionID, event.messageID, signature]))
    if (this.completions >= MAX_COMPLETIONS || this.bytes + bytes > MAX_BYTES) fail('TRANSCRIPT_STOP_LIMIT')
    this.state(session).completions.set(event.completionID, { turnID: event.messageID, turnSignal: session.turnSignal, signature, bytes })
    this.completions++
    this.bytes += bytes
  }

  admit(delivery: StopDelivery): readonly string[] {
    const { event, session, dispatch, signal } = delivery
    if (this.disposed || signal.aborted || session.signal.aborted || session.turnSignal.aborted || dispatch.cancelled) fail('TRANSCRIPT_CANCELLED')
    if (event.event !== 'Stop') fail('TRANSCRIPT_STOP_INPUT_INVALID')
    if (event.sessionID !== session.sessionID || event.messageID !== session.turnID) fail('TRANSCRIPT_STOP_TURN_UNAVAILABLE')
    if (dispatch.diagnostic.sessionID !== event.sessionID || dispatch.diagnostic.event !== 'Stop') fail('TRANSCRIPT_DISPATCH_MISMATCH')
    const state = this.states.get(event.sessionID)
    const completion = state?.completions.get(event.completionID)
    if (!state || state.signal !== session.signal || !completion) fail('TRANSCRIPT_STOP_SNAPSHOT_UNAVAILABLE')
    if (completion.turnID !== event.messageID || completion.turnSignal !== session.turnSignal) fail('TRANSCRIPT_STOP_TURN_UNAVAILABLE')
    if (completion.records !== undefined) fail('TRANSCRIPT_STOP_ID_REUSED')
    const records = compile(delivery)
    const projection = model(records)
    const bytes = Buffer.byteLength(JSON.stringify(records))
    if (this.records + this.reservedRecords + records.length > MAX_RECORDS || this.bytes + bytes > MAX_BYTES) fail('TRANSCRIPT_STOP_LIMIT')
    completion.records = records
    completion.continuable = !delivery.effects.stop && !delivery.effects.cancelled && delivery.effects.continuations.length > 0
    completion.bytes += bytes
    this.records += records.length
    this.bytes += bytes
    return projection
  }

  admitContinuation(delivery: StopDelivery, row: JsonValue): void {
    const { event } = delivery
    const { state, completion } = this.continuationOwner(delivery)
    if (!validReadback(row)) fail('TRANSCRIPT_STOP_CONTINUATION_INVALID')
    this.available(state, completion, row.id, event.messageID)
    const bytes = Buffer.byteLength(JSON.stringify([event.completionID, event.messageID, row]))
    if (this.bytes + bytes > MAX_BYTES) fail('TRANSCRIPT_STOP_LIMIT')
    state.continuations.set(row.id, Object.freeze({ phase: 'admitted', completionID: event.completionID, turnID: event.messageID, signature: signature(row) }))
    completion.continuationID = row.id
    completion.bytes += bytes
    this.bytes += bytes
  }

  modelInput(delivery: StopDelivery): StopModelBlocks {
    return modelBlocks(this.admittedOwner(delivery, 'TRANSCRIPT_STOP_MODEL_UNAVAILABLE').completion.records!)
  }

  admitInterruption(event: StopEvent, session: SessionSnapshot, receipt: StopInterruptionReceipt): StopInterruptedModel {
    if (this.disposed || session.signal.aborted) fail('TRANSCRIPT_CANCELLED')
    if (!record(receipt) || Object.keys(receipt).some(key => !INTERRUPTION_RECEIPT_FIELDS.has(key)) || receipt.reason !== 'user' || receipt.source !== 'sdk-cli' || typeof receipt.eventID !== 'string' || !receipt.eventID || receipt.eventID.includes('\0') || Buffer.byteLength(receipt.eventID) > MAX_ID_BYTES || typeof receipt.created !== 'number' || !Number.isFinite(receipt.created) || Number.isNaN(new Date(receipt.created).getTime())) fail('TRANSCRIPT_STOP_INTERRUPTION_INVALID')
    const state = this.states.get(event.sessionID), completion = state?.completions.get(event.completionID)
    if (event.event !== 'Stop' || event.sessionID !== session.sessionID || event.messageID !== session.turnID || !state || state.signal !== session.signal || !completion || completion.turnID !== event.messageID || completion.turnSignal !== session.turnSignal || !session.turnSignal.aborted) fail('TRANSCRIPT_STOP_INTERRUPTION_UNAVAILABLE')
    if (completion.interruption || [...state.completions.values()].some(row => row.interruption?.eventID === receipt.eventID)) fail('TRANSCRIPT_STOP_INTERRUPTION_REUSED')
    const interrupted = freeze({ id: randomUUID(), created: receipt.created, body: { type: 'user', message: { role: 'user', content: [{ type: 'text', text: CLAUDE_USER_INTERRUPTION }] }, promptId: event.messageID, userType: 'external', entrypoint: receipt.source } })
    const bytes = Buffer.byteLength(JSON.stringify([receipt.eventID, interrupted]))
    const reserved = completion.interruptionReservation ?? 0
    if (reserved ? bytes > reserved : this.records + this.reservedRecords >= MAX_RECORDS || this.bytes + bytes > MAX_BYTES) fail('TRANSCRIPT_STOP_LIMIT')
    const blocks = modelBlocks(completion.records ?? [])
    completion.interruption = Object.freeze({ eventID: receipt.eventID, record: interrupted })
    if (reserved) { delete completion.interruptionReservation; this.reservedRecords-- }
    completion.bytes += bytes - reserved
    this.records++
    this.bytes += bytes - reserved
    return Object.freeze({ ...blocks, interrupted: true })
  }

  reserveContinuation(delivery: StopDelivery, input: JsonValue, options: StopContinuationOptions = {}): StopContinuationReservation {
    const owner: ContinuationOwner = { event: { event: delivery.event.event, sessionID: delivery.event.sessionID, messageID: delivery.event.messageID, completionID: delivery.event.completionID }, session: { ...delivery.session }, signal: delivery.signal }
    const { event, session } = owner
    const { state, completion } = this.continuationOwner(owner)
    if (!validContinuation(input) || Object.keys(input).some(key => !CONTINUATION_INPUT_FIELDS.has(key))) fail('TRANSCRIPT_STOP_CONTINUATION_INVALID')
    const id = input.id
    this.available(state, completion, id, event.messageID)
    const reconcileCancellation = options.reconcileCancellation === true
    const retirementBytes = reconcileCancellation ? Buffer.byteLength(JSON.stringify([event.completionID, event.messageID, id])) * 2 + MAX_SERIALIZED_ID_BYTES + READBACK_OVERHEAD_BYTES : 0
    const bytes = Buffer.byteLength(JSON.stringify([event.completionID, event.messageID, input])) + READBACK_OVERHEAD_BYTES + (reconcileCancellation ? MAX_SERIALIZED_ID_BYTES : 0) + retirementBytes
    const interruptionBytes = reconcileCancellation ? Buffer.byteLength(JSON.stringify(event.messageID)) + MAX_SERIALIZED_ID_BYTES + READBACK_OVERHEAD_BYTES : 0
    if (this.bytes + bytes + interruptionBytes > MAX_BYTES || interruptionBytes && this.records + this.reservedRecords >= MAX_RECORDS) fail('TRANSCRIPT_STOP_LIMIT')
    const signal = reconcileCancellation ? session.signal : AbortSignal.any([owner.signal, session.signal, session.turnSignal])
    const release = () => {
      if (this.states.get(event.sessionID) !== state || state.continuations.get(id) !== pending) return
      pending.detach()
      state.continuations.delete(id)
      delete completion.continuationID
      completion.bytes -= bytes
      this.bytes -= bytes
      if (interruptionBytes && completion.interruptionReservation === interruptionBytes) {
        delete completion.interruptionReservation
        this.reservedRecords--
        completion.bytes -= interruptionBytes
        this.bytes -= interruptionBytes
      }
    }
    const pending: Extract<Continuation, { phase: 'pending' }> = Object.freeze({ phase: 'pending', completionID: event.completionID, turnID: event.messageID, expected: signature({ type: 'synthetic', ...input }), bytes, detach: () => { signal.removeEventListener('abort', release) } })
    state.continuations.set(id, pending)
    completion.continuationID = id
    completion.bytes += bytes
    this.bytes += bytes
    if (interruptionBytes) { completion.interruptionReservation = interruptionBytes; this.reservedRecords++; completion.bytes += interruptionBytes; this.bytes += interruptionBytes }
    signal.addEventListener('abort', release, { once: true })
    const publish = (row: JsonValue, phase: 'admitted' | 'suppressed', previousID?: string) => {
      if (phase === 'admitted') this.continuationOwner(owner)
      else {
        const owned = this.admittedOwner(owner, 'TRANSCRIPT_STOP_RECONCILIATION_UNAVAILABLE', true)
        if (!reconcileCancellation || !owned.completion.continuable) fail('TRANSCRIPT_STOP_RECONCILIATION_UNAVAILABLE')
      }
      if (this.states.get(event.sessionID) !== state || state.continuations.get(id) !== pending) fail('TRANSCRIPT_STOP_RESERVATION_UNAVAILABLE')
      if (!validReadback(row)) fail('TRANSCRIPT_STOP_CONTINUATION_INVALID')
      if (phase === 'suppressed' && (typeof previousID !== 'string' || !previousID || previousID === id || previousID.includes('\0') || Buffer.byteLength(previousID) > MAX_ID_BYTES)) fail('TRANSCRIPT_STOP_CONTINUATION_POSITION')
      const payload = Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'time'))
      if (Object.keys(row.time).length !== 1 || signature(payload) !== pending.expected) fail('TRANSCRIPT_STOP_CONTINUATION_CHANGED')
      const actual = Buffer.byteLength(JSON.stringify(phase === 'suppressed' ? [event.completionID, event.messageID, row, previousID] : [event.completionID, event.messageID, row])) + retirementBytes
      if (actual > bytes) fail('TRANSCRIPT_STOP_LIMIT')
      const owned = { completionID: event.completionID, turnID: event.messageID, signature: signature(row), ...(retirementBytes ? { retirementBytes } : {}) }
      state.continuations.set(id, Object.freeze(phase === 'suppressed' ? { ...owned, phase, previousID: previousID! } : { ...owned, phase }))
      completion.bytes += actual - bytes
      this.bytes += actual - bytes
      pending.detach()
    }
    return Object.freeze({
      admit: (row: JsonValue) => publish(row, 'admitted'),
      ...(reconcileCancellation ? { suppress: (row: JsonValue, previousID: string) => publish(row, 'suppressed', previousID) } : {}),
      release,
    })
  }

  retireContinuation(event: StopEvent, session: SessionSnapshot, row: JsonValue, assistant: JsonValue, evidence: StopAbortedAssistant): void {
    if (this.disposed || session.signal.aborted) fail('TRANSCRIPT_CANCELLED')
    const state = this.states.get(event.sessionID), completion = state?.completions.get(event.completionID)
    if (!validReadback(row)) fail('TRANSCRIPT_STOP_CONTINUATION_INVALID')
    const owned = state?.continuations.get(row.id)
    if (!state || state.signal !== session.signal || event.event !== 'Stop' || event.sessionID !== session.sessionID || event.messageID !== session.turnID || !session.turnSignal.aborted || !completion || completion.turnID !== event.messageID || completion.turnSignal !== session.turnSignal || !completion.interruption || !owned || owned.phase !== 'admitted' || !owned.retirementBytes || owned.completionID !== event.completionID || owned.turnID !== event.messageID) fail('TRANSCRIPT_STOP_RETIREMENT_UNAVAILABLE')
    if (owned.signature !== signature(row)) fail('TRANSCRIPT_STOP_CONTINUATION_CHANGED')
    const validID = (value: unknown): value is string => typeof value === 'string' && !!value && !value.includes('\0') && Buffer.byteLength(value) <= MAX_ID_BYTES
    const validTime = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && !Number.isNaN(new Date(value).getTime())
    if (!record(assistant) || assistant.type !== 'assistant' || !validID(assistant.id) || !record(evidence) || evidence.phase !== 'failed' || evidence.id !== assistant.id || evidence.inputID !== row.id || !validID(evidence.agent) || assistant.agent !== evidence.agent || !record(assistant.model) || !record(evidence.model) || signature(assistant.model) !== signature(evidence.model) || !record(assistant.time) || !validTime(assistant.time.created) || !validTime(assistant.time.completed) || !validTime(evidence.started) || !validTime(evidence.completed) || assistant.time.created !== evidence.started || assistant.time.completed !== evidence.completed || !validID(evidence.eventID) || evidence.eventID === completion.interruption.eventID || !Array.isArray(assistant.content) || assistant.content.length || assistant.finish !== 'error' || !record(assistant.error) || !record(evidence.error) || evidence.error.type !== 'aborted' || evidence.error.message !== 'Step interrupted' || signature(assistant.error) !== signature(evidence.error)) fail('TRANSCRIPT_STOP_ABORTED_ASSISTANT_INVALID')
    if (state.cancelled.has(assistant.id) || state.continuations.has(assistant.id) || state.completions.has(assistant.id) || assistant.id === event.messageID) fail('TRANSCRIPT_STOP_ID_REUSED')
    const retired = Object.freeze({ completionID: event.completionID, turnID: event.messageID, signature: signature(assistant), previousID: row.id })
    if (Buffer.byteLength(JSON.stringify([assistant.id, retired, event.completionID])) > owned.retirementBytes) fail('TRANSCRIPT_STOP_LIMIT')
    state.cancelled.set(assistant.id, retired)
    state.continuations.set(row.id, Object.freeze({ ...owned, phase: 'suppressed', previousID: event.completionID }))
  }

  suppresses(sessionID: string, row: Readonly<Record<string, unknown>>, precedingCompletions: ReadonlySet<string>, previousID: string | undefined): boolean {
    const state = this.states.get(sessionID)
    const continuation = typeof row.id === 'string' ? state?.continuations.get(row.id) : undefined
    const owned = continuation?.phase === 'suppressed' ? continuation : typeof row.id === 'string' ? state?.cancelled.get(row.id) : undefined
    if (!owned) return false
    if (!precedingCompletions.has(owned.completionID) || owned.previousID !== previousID) fail('TRANSCRIPT_STOP_CONTINUATION_POSITION')
    if (owned.signature !== signature(row)) fail('TRANSCRIPT_STOP_CONTINUATION_CHANGED')
    return true
  }

  validateContinuation(sessionID: string, row: Readonly<Record<string, unknown>>, previousID: string | undefined, turnID: string | undefined): void {
    const owned = typeof row.id === 'string' ? this.states.get(sessionID)?.continuations.get(row.id) : undefined
    if (!owned || owned.phase !== 'admitted') fail('TRANSCRIPT_CONTENT_UNSUPPORTED')
    if (owned.turnID !== turnID || owned.completionID !== previousID) fail('TRANSCRIPT_STOP_CONTINUATION_POSITION')
    if (owned.signature !== signature(row)) fail('TRANSCRIPT_STOP_CONTINUATION_CHANGED')
  }

  read(sessionID: string, completionID: string, turnID: string, signature: string): readonly StopRecord[] {
    const completion = this.states.get(sessionID)?.completions.get(completionID)
    if (!completion) return []
    if (completion.turnID !== turnID || completion.signature !== signature) fail('TRANSCRIPT_STOP_HISTORY_CHANGED')
    return [...completion.records ?? [], ...completion.interruption ? [completion.interruption.record] : []]
  }

  validateHistory(sessionID: string, completionIDs: ReadonlySet<string>, continuationIDs: ReadonlySet<string>): void {
    const state = this.states.get(sessionID)
    if (state) for (const [id, completion] of state.completions) if ((completion.records !== undefined || completion.interruption) && !completionIDs.has(id)) fail('TRANSCRIPT_STOP_HISTORY_UNAVAILABLE')
    if (state) for (const [id, row] of state.continuations) if (row.phase !== 'pending' && !continuationIDs.has(id)) fail('TRANSCRIPT_STOP_HISTORY_UNAVAILABLE')
    if (state) for (const id of state.cancelled.keys()) if (!continuationIDs.has(id)) fail('TRANSCRIPT_STOP_HISTORY_UNAVAILABLE')
  }

  dispose(): void { this.disposed = true; for (const state of this.states.values()) state.cleanup() }
  inspect() { return Object.freeze({ stopSessions: this.states.size, stopCompletions: this.completions, stopRecords: this.records, stopBytes: this.bytes }) }

  private continuationOwner({ event, session, signal }: ContinuationOwner): { readonly state: State; readonly completion: Completion } {
    const owned = this.admittedOwner({ event, session, signal }, 'TRANSCRIPT_STOP_CONTINUATION_UNAVAILABLE')
    if (!owned.completion.continuable) fail('TRANSCRIPT_STOP_CONTINUATION_UNAVAILABLE')
    return owned
  }

  private admittedOwner({ event, session, signal }: ContinuationOwner, code: string, cancelled = false): { readonly state: State; readonly completion: Completion } {
    const interrupted = signal.aborted || session.turnSignal.aborted
    if (this.disposed || session.signal.aborted || !cancelled && interrupted) fail('TRANSCRIPT_CANCELLED')
    if (cancelled && !interrupted) fail(code)
    const state = this.states.get(event.sessionID)
    const completion = state?.completions.get(event.completionID)
    if (event.event !== 'Stop' || !state || state.signal !== session.signal || event.sessionID !== session.sessionID || event.messageID !== session.turnID || !completion || completion.turnID !== event.messageID || completion.turnSignal !== session.turnSignal || !completion.records) fail(code)
    return { state, completion }
  }

  private available(state: State, completion: Completion, id: string, turnID: string): void {
    if (completion.continuationID !== undefined || state.continuations.has(id) || state.completions.has(id) || id === turnID) fail('TRANSCRIPT_STOP_ID_REUSED')
  }

  private state(session: SessionSnapshot): State {
    let state = this.states.get(session.sessionID)
    if (state && state.signal !== session.signal) fail('TRANSCRIPT_SESSION_MISMATCH')
    if (!state) {
      if (this.states.size >= MAX_SESSIONS) fail('TRANSCRIPT_STOP_LIMIT')
      const cleanup = () => {
        const previous = this.states.get(session.sessionID)
        if (!previous) return
        for (const row of previous.continuations.values()) if (row.phase === 'pending') row.detach()
        for (const completion of previous.completions.values()) { this.completions--; this.records -= (completion.records?.length ?? 0) + (completion.interruption ? 1 : 0); this.reservedRecords -= completion.interruptionReservation ? 1 : 0; this.bytes -= completion.bytes }
        this.states.delete(session.sessionID)
        previous.completions.clear()
        previous.continuations.clear()
        previous.cancelled.clear()
        session.signal.removeEventListener('abort', cleanup)
      }
      state = { signal: session.signal, completions: new Map(), continuations: new Map(), cancelled: new Map(), cleanup }
      this.states.set(session.sessionID, state)
      session.signal.addEventListener('abort', cleanup, { once: true })
    }
    return state
  }
}
