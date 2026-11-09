import { randomUUID } from 'node:crypto'
import { HostHookError } from './hosts/tools.js'
import type { SessionSnapshot } from './sessions.js'
import type { StopDelivery, StopEvent } from './stop.js'
import type { JsonValue } from './types.js'

const MAX_SESSIONS = 1024
const MAX_COMPLETIONS = 10000
const MAX_RECORDS = 50000
const MAX_BYTES = 32 * 1024 * 1024
const FEEDBACK_PREFIX = 'Stop hook feedback:\n'

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
  const errors: string[] = [], context: string[] = []
  const infos = new Map<number, Record<string, JsonValue>>()
  let stopReason = '', prevented = false
  let bytes = 0
  const append = (body: Record<string, JsonValue>, created: number) => {
    const record = { id: randomUUID(), created, body }
    bytes += Buffer.byteLength(JSON.stringify(record))
    if (records.length >= MAX_RECORDS || bytes > MAX_BYTES) fail('TRANSCRIPT_STOP_LIMIT')
    records.push(record)
  }
  for (const entry of [...entries].sort((left, right) => left.completionOrder - right.completionOrder || left.configuredOrder - right.configuredOrder)) {
    const result = entry.result
    if (result.status !== 'success') fail('TRANSCRIPT_STOP_RESULT_UNSUPPORTED')
    const execution = result.commandArtifact
    if (!execution || execution.status !== 'exited' || execution.exitCode !== 0 || execution.signal !== null || typeof execution.command !== 'string' || !Number.isFinite(execution.durationMs) || execution.durationMs < 0 || !Number.isFinite(execution.completedAt) || Number.isNaN(new Date(execution.completedAt).getTime())) fail('TRANSCRIPT_HOOK_EXECUTION_UNAVAILABLE')
    if (execution.stderr !== '') fail('TRANSCRIPT_STOP_OUTPUT_UNSUPPORTED')
    if (Buffer.byteLength(execution.stdout) > MAX_BYTES) fail('TRANSCRIPT_STOP_LIMIT')
    let output: unknown
    try { output = JSON.parse(execution.stdout) } catch { fail('TRANSCRIPT_STOP_OUTPUT_UNSUPPORTED') }
    if (output === null || typeof output !== 'object' || Array.isArray(output)) fail('TRANSCRIPT_STOP_OUTPUT_UNSUPPORTED')
    if (result.actions.some(action => action.kind !== 'stop-session' && (action.kind !== 'continue-turn' || action.mode !== 'feedback' || action.channel !== 'decision' && action.channel !== 'additionalContext'))) fail('TRANSCRIPT_STOP_EFFECT_UNSUPPORTED')
    const decision = result.actions.find(action => action.kind === 'continue-turn' && action.channel === 'decision')
    const stopped = result.actions.find(action => action.kind === 'stop-session')
    const additional = result.actions.filter(action => action.kind === 'continue-turn' && action.channel === 'additionalContext')
    const info: Record<string, JsonValue> = { command: execution.command, ...(!decision ? { durationMs: execution.durationMs } : {}) }
    infos.set(entry.configuredOrder, info)
    const attachment = (value: Record<string, JsonValue>, rendered?: string) => append({ type: 'attachment', attachment: { hookName: 'Stop', hookEvent: 'Stop', toolUseID, ...value }, ...(rendered === undefined ? {} : { rendered: [{ content: rendered }], renderedRole: 'system' }) }, execution.completedAt)
    if (stopped?.kind === 'stop-session') {
      prevented = true
      stopReason = stopped.reason
      attachment({ type: 'hook_stopped_continuation', message: stopped.reason }, `<system-reminder>\nStop hook stopped continuation: ${stopped.reason}\n</system-reminder>`)
    }
    if (decision?.kind === 'continue-turn') {
      errors.push(decision.text)
      append({ type: 'user', isMeta: true, promptId: event.messageID, message: { role: 'user', content: FEEDBACK_PREFIX + decision.text } }, execution.completedAt)
      attachment({ type: 'hook_blocking_error', blockingError: { blockingError: decision.text, command: execution.command } }, `<system-reminder>\nStop hook blocking error from command: "${execution.command}": ${decision.text}\n</system-reminder>`)
    } else attachment({ type: 'hook_success', content: '', stdout: execution.stdout, stderr: execution.stderr, exitCode: execution.exitCode, command: execution.command, durationMs: execution.durationMs })
    for (const action of additional) if (action.kind === 'continue-turn') {
      context.push(action.text)
      attachment({ type: 'hook_additional_context', content: [action.text] }, `<system-reminder>\nStop hook additional context: ${action.text}\n</system-reminder>`)
    }
  }
  append({ type: 'system', subtype: 'stop_hook_summary', hookCount: entries.length, hookInfos: entries.map(entry => infos.get(entry.configuredOrder)!), hookErrors: errors, hookAdditionalContext: context, preventedContinuation: prevented, stopReason, hasOutput: true, level: 'suggestion', toolUseID }, Date.now())
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
