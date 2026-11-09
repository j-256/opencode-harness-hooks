import { randomUUID } from 'node:crypto'
import { HostHookError } from './hosts/tools.js'
import type { SessionSnapshot } from './sessions.js'
import type { StopDelivery, StopEvent } from './stop.js'
import type { JsonValue } from './types.js'
import { parseClaudeStopOutput } from './protocols/claude-output.js'

const MAX_SESSIONS = 1024
const MAX_COMPLETIONS = 10000
const MAX_RECORDS = 50000
const MAX_BYTES = 32 * 1024 * 1024
const FEEDBACK_PREFIX = 'Stop hook feedback:\n'
const SUCCESS_EXIT = 0
const BLOCKING_EXIT = 2
const EVENT_ERROR_EXIT = 1
const MAX_EXIT = 255
const EMPTY_STDERR = 'No stderr output'
const NONBLOCKING_ERROR_PREFIX = 'Failed with non-blocking status code: '

interface StopRecord { readonly id: string; readonly created: number; readonly body: Readonly<Record<string, JsonValue>> }
interface Completion {
  readonly turnID: string
  readonly turnSignal: AbortSignal
  readonly signature: string
  records?: readonly StopRecord[]
  bytes: number
}
interface State { readonly signal: AbortSignal; readonly completions: Map<string, Completion>; readonly cleanup: () => void }
function fail(code: string): never { throw new HostHookError(code, code === 'TRANSCRIPT_CANCELLED' ? 'cancelled' : 'unsupported') }
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

export class StopRecords {
  private readonly states = new Map<string, State>()
  private completions = 0
  private records = 0
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

  admit(delivery: StopDelivery): void {
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
    const bytes = Buffer.byteLength(JSON.stringify(records))
    if (this.records + records.length > MAX_RECORDS || this.bytes + bytes > MAX_BYTES) fail('TRANSCRIPT_STOP_LIMIT')
    completion.records = records
    completion.bytes += bytes
    this.records += records.length
    this.bytes += bytes
  }

  read(sessionID: string, completionID: string, turnID: string, signature: string): readonly StopRecord[] {
    const completion = this.states.get(sessionID)?.completions.get(completionID)
    if (!completion) return []
    if (completion.turnID !== turnID || completion.signature !== signature) fail('TRANSCRIPT_STOP_HISTORY_CHANGED')
    return completion.records ?? []
  }

  validateHistory(sessionID: string, completionIDs: ReadonlySet<string>): void {
    const state = this.states.get(sessionID)
    if (state) for (const [id, completion] of state.completions) if (completion.records !== undefined && !completionIDs.has(id)) fail('TRANSCRIPT_STOP_HISTORY_UNAVAILABLE')
  }

  dispose(): void { this.disposed = true; for (const state of this.states.values()) state.cleanup() }
  inspect() { return Object.freeze({ stopSessions: this.states.size, stopCompletions: this.completions, stopRecords: this.records, stopBytes: this.bytes }) }

  private state(session: SessionSnapshot): State {
    let state = this.states.get(session.sessionID)
    if (state && state.signal !== session.signal) fail('TRANSCRIPT_SESSION_MISMATCH')
    if (!state) {
      if (this.states.size >= MAX_SESSIONS) fail('TRANSCRIPT_STOP_LIMIT')
      const cleanup = () => {
        const previous = this.states.get(session.sessionID)
        if (!previous) return
        for (const completion of previous.completions.values()) { this.completions--; this.records -= completion.records?.length ?? 0; this.bytes -= completion.bytes }
        this.states.delete(session.sessionID)
        session.signal.removeEventListener('abort', cleanup)
      }
      state = { signal: session.signal, completions: new Map(), cleanup }
      this.states.set(session.sessionID, state)
      session.signal.addEventListener('abort', cleanup, { once: true })
    }
    return state
  }
}
