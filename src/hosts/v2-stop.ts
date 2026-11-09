import { randomUUID } from 'node:crypto'
import { HostHookError } from './tools.js'
import { runService } from '../service-execution.js'
import type { createRuntime } from '../runtime.js'
import type { PromptContexts, PromptContinuationReservation, PromptStopHistory } from '../prompt-contexts.js'
import type { SessionSnapshot } from '../sessions.js'
import type { StopDelivery } from '../stop.js'
import type { StopEvent } from '../stop.js'
import type { StopModelBlocks } from '../stop-records.js'
import type { TranscriptHistory, TranscriptService, TranscriptContinuationReservation } from '../transcript.js'
import { V2StopEvents, V2_STOP_EVENT_TYPES } from './v2-stop-events.js'
import type { V2ExecutionInterruption } from './v2-stop-events.js'

const SERVICE_MS = 5000
const MAX_SESSIONS = 1024
const MAX_BYTES = 32 * 1024 * 1024
const MAX_HISTORY = 10000
const MAX_CONTEXT_MESSAGES = 10000
type Runtime = Awaited<ReturnType<typeof createRuntime>>
export interface V2IdleEvent { readonly sessionID: string; readonly background: readonly unknown[] }
export interface V2SyntheticInput { readonly id: string; readonly sessionID: string; readonly text: string; readonly description: string; readonly metadata: Readonly<Record<string, string>>; readonly delivery: 'steer'; readonly resume: false }
interface Pending {
  readonly owner: SessionSnapshot
  readonly signal: AbortSignal
  readonly input: V2SyntheticInput
  readonly completionID: string
  readonly model: PromptContinuationReservation
  readonly transcript: TranscriptContinuationReservation
  readonly bytes: number
  phase: 'enqueue' | 'queued' | 'admitted' | 'failed'
  failure?: HostHookError
  reading?: Promise<void>
}
interface Historical extends PromptStopHistory { readonly turnID: string; readonly bytes: number; nextPromptID?: string }
interface Attempt { readonly owner: SessionSnapshot; readonly event: StopEvent; readonly text: string; readonly bytes: number; readonly receipt: Promise<void>; readonly received: () => void; phase: 'dispatch' | 'admitted' | 'done' | 'interrupted' }
interface State { readonly signal: AbortSignal; readonly cleanup: () => void; readonly histories: Map<string, Historical>; attempt?: Attempt; pending?: Pending; failure?: HostHookError }
interface Options {
  readonly directory: string
  readonly runtime: Pick<Runtime, 'sessions' | 'stop'>
  readonly transcripts: TranscriptService
  readonly contexts: PromptContexts
  readonly history: (sessionID: string, signal: AbortSignal) => Promise<TranscriptHistory>
  readonly synthetic: (input: V2SyntheticInput) => Promise<unknown>
  readonly subscribe: (options: { readonly types: typeof V2_STOP_EVENT_TYPES; readonly signal: AbortSignal }) => AsyncIterable<unknown>
}
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function fail(code: string, outcome: HostHookError['outcome'] = 'unsupported'): never { throw new HostHookError(code, outcome) }
function same(left: unknown, right: unknown): boolean {
  const canonical = (value: unknown) => JSON.stringify(value, (_key, item: unknown) => record(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)
  try { return canonical(left) === canonical(right) } catch { return false }
}

export class V2StopBridge {
  private readonly states = new Map<string, State>()
  private readonly submissions = new Set<Promise<void>>()
  private readonly lifetime = new AbortController()
  private bytes = 0
  private historicalCount = 0
  private disposing: Promise<void> | undefined
  private readonly events = new V2StopEvents()
  private readonly observing: Promise<void>
  private eventFailure?: HostHookError

  constructor(private readonly options: Options) {
    this.observing = (async () => {
      for await (const raw of options.subscribe({ types: V2_STOP_EVENT_TYPES, signal: this.lifetime.signal })) {
        if (this.lifetime.signal.aborted) break
        const sessionID = record(raw) && record(raw.data) && typeof raw.data.sessionID === 'string' ? raw.data.sessionID : undefined
        if (sessionID && this.states.get(sessionID)?.failure) continue
        const started = performance.now()
        try {
          const receipt = this.events.event(raw)
          if (receipt) this.interrupted(receipt)
        } catch (error) { this.failedEvents(error, started, raw); if (this.eventFailure) return }
      }
      if (!this.lifetime.signal.aborted) fail('HOST_STOP_EVENT_STREAM_ENDED')
    })().catch((error: unknown) => {
      if (this.lifetime.signal.aborted) return
      this.failedEvents(error, performance.now())
    })
  }

  accept(session: SessionSnapshot, text: string): void { this.guard(session, false); this.events.accept(session, text); this.state(session) }

  private failedEvents(error: unknown, started: number, raw?: unknown): void {
    if (this.eventFailure) return
    const candidate = record(raw) && record(raw.data) && typeof raw.data.sessionID === 'string' ? raw.data.sessionID : undefined
    const state = candidate ? this.states.get(candidate) : undefined
    if (state?.failure) return
    const failure = this.failure('events', state ? candidate : undefined, error instanceof HostHookError ? error : new HostHookError('HOST_STOP_EVENT_STREAM_FAILED', 'failed'), state?.attempt?.event.completionID, started)
    if (state) { state.failure = failure; state.attempt?.received() }
    else { this.eventFailure = failure; for (const row of this.states.values()) row.attempt?.received() }
  }

  guard(session: SessionSnapshot, ready = true): void {
    if (this.lifetime.signal.aborted) fail('HOST_STOP_DISPOSED', 'cancelled')
    if (session.signal.aborted || session.turnSignal.aborted) fail('HOST_STOP_CANCELLED', 'cancelled')
    if (this.eventFailure) throw this.eventFailure
    const state = this.states.get(session.sessionID)
    if (state && state.signal !== session.signal) fail('HOST_STOP_SESSION_MISMATCH')
    if (state?.failure) throw state.failure
    if (ready && state?.attempt?.phase === 'dispatch' && state.attempt.owner.turnSignal.aborted) fail('HOST_STOP_INTERRUPTION_UNAVAILABLE')
    if (ready && state && [...state.histories.values()].some(row => !row.nextPromptID)) fail('HOST_STOP_HISTORY_UNAVAILABLE')
    const pending = state?.pending
    if (!pending) return
    if (pending.failure) throw pending.failure
    this.live(pending, session)
    if (ready) fail('HOST_STOP_ADMISSION_PENDING')
  }

  async idle(frame: V2IdleEvent): Promise<void> {
    const started = performance.now()
    let completionID: string | undefined
    let attempt: Attempt | undefined
    try {
      const session = this.options.runtime.sessions.get(frame.sessionID)
      this.guard(session, false)
      if (!session.turnID || !Array.isArray(frame.background)) fail('HOST_NATIVE_METADATA_UNAVAILABLE')
      if (frame.background.length) fail('HOST_STOP_BACKGROUND_UNAVAILABLE')
      const history = await runService(SERVICE_MS, session.turnSignal, signal => this.options.history(frame.sessionID, signal))
      if (history.id !== session.sessionID) fail('HOST_TRANSCRIPT_HISTORY_UNAVAILABLE')
      if (history.parentID !== undefined) fail('HOST_STOP_SUBAGENT_UNAVAILABLE')
      const last = history.messages.findLast(row => record(row) && row.type === 'assistant')
      if (!record(last) || typeof last.id !== 'string' || last.finish !== 'stop' || !Array.isArray(last.content) || last.content.length !== 1 || !record(last.content[0]) || last.content[0].type !== 'text' || typeof last.content[0].text !== 'string') fail('HOST_STOP_COMPLETION_UNAVAILABLE')
      completionID = last.id
      const event = { host: 'v2' as const, event: 'Stop' as const, cwd: this.options.directory, sessionID: session.sessionID, messageID: session.turnID, completionID: last.id }
      const path = await this.options.transcripts.prepare(event, session, session.turnSignal)
      const state = this.state(session)
      if (state.attempt?.phase === 'dispatch' && !state.attempt.owner.turnSignal.aborted && state.attempt.event.completionID !== event.completionID) fail('HOST_STOP_ADMISSION_PENDING')
      if (state.attempt?.event.completionID !== event.completionID || state.attempt.owner.turnSignal !== session.turnSignal) {
        const text = last.content[0].text, bytes = Buffer.byteLength(JSON.stringify([event, text]))
        if (this.bytes - (state.attempt?.bytes ?? 0) + bytes > MAX_BYTES) fail('HOST_STOP_LIMIT')
        let received!: () => void
        const receipt = new Promise<void>(resolve => { received = resolve })
        if (state.attempt) this.bytes -= state.attempt.bytes
        state.attempt = { owner: Object.freeze({ ...session }), event: Object.freeze(event), text, bytes, receipt, received, phase: 'dispatch' }
        this.bytes += bytes
      }
      attempt = state.attempt
      await this.options.runtime.stop({ ...event, data: { transcript_path: path, last_assistant_message: last.content[0].text, background_tasks: [], session_crons: [] } })
      if (attempt.phase !== 'interrupted') attempt.phase = 'done'
    } catch (error) {
      if (attempt?.phase === 'interrupted' && attempt.event.completionID === completionID && error instanceof HostHookError && error.outcome === 'cancelled') return
      throw this.failure('completion', frame.sessionID, error, completionID, started)
    }
  }

  async admit(delivery: StopDelivery): Promise<void> {
    const { session, event, effects } = delivery
    this.guard(session)
    if (effects.cancelled || delivery.signal.aborted) fail('HOST_STOP_CANCELLED', 'cancelled')
    if (effects.permission || effects.input || effects.block || effects.context.length || effects.feedback.length || effects.warnings.length || effects.extensions.length || effects.resultReplacements.length || effects.unresolved.length) fail('HOST_STOP_EFFECT_UNAVAILABLE')
    if (!this.options.transcripts.admitStop || !this.options.transcripts.reserveContinuation || !this.options.transcripts.stopModelInput) fail('HOST_STOP_ARTIFACT_UNAVAILABLE')
    const projection = this.options.transcripts.admitStop(delivery)
    const attempt = this.states.get(session.sessionID)?.attempt
    if (attempt?.event.completionID === event.completionID) attempt.phase = 'admitted'
    if (effects.stop || !effects.continuations.length) {
      if (projection.length) {
        const state = this.state(session)
        try {
          const blocks = this.options.transcripts.stopModelInput(delivery)
          const text = event.data?.last_assistant_message
          if (typeof text !== 'string' || state.histories.has(event.completionID)) fail('HOST_STOP_HISTORY_UNAVAILABLE')
          this.retainHistory(state, session, event.completionID, text, blocks)
        } catch (error) {
          state.failure = error instanceof HostHookError ? error : new HostHookError('HOST_STOP_HISTORY_UNAVAILABLE', 'unsupported')
          throw state.failure
        }
      }
      return
    }
    if (!projection.length) fail('HOST_STOP_MODEL_INPUT_UNAVAILABLE')
    const state = this.state(session)
    const id = 'msg_' + randomUUID()
    const input: V2SyntheticInput = Object.freeze({ id, sessionID: session.sessionID, text: 'opencode-harness-hooks:Stop:' + id, description: 'Hook feedback', metadata: Object.freeze({ source: 'opencode-harness-hooks', completionID: event.completionID, token: randomUUID() }), delivery: 'steer', resume: false })
    const bytes = Buffer.byteLength(JSON.stringify([input, projection]))
    if (this.submissions.size >= MAX_SESSIONS || this.bytes + bytes > MAX_BYTES) fail('HOST_STOP_LIMIT')
    const transcript = this.options.transcripts.reserveContinuation(delivery, { id, text: input.text, description: input.description, metadata: input.metadata })
    let model: PromptContinuationReservation
    try { model = this.options.contexts.reserveContinuation(session, id, [input.text], projection) } catch (error) { transcript.release(); throw error }
    const pending: Pending = { owner: { ...session }, signal: delivery.signal, input, completionID: event.completionID, transcript, model, bytes, phase: 'enqueue' }
    state.pending = pending
    this.bytes += bytes
    const started = performance.now()
    const work = Promise.resolve().then(async () => {
      this.live(pending)
      const ack = await this.options.synthetic(input)
      this.live(pending)
      if (!record(ack) || ack.id !== id || ack.sessionID !== input.sessionID || ack.type !== 'synthetic' || ack.delivery !== input.delivery || !record(ack.time) || typeof ack.time.created !== 'number' || !Number.isFinite(ack.time.created) || !same(ack.payload, { text: input.text, description: input.description, metadata: input.metadata })) fail('HOST_STOP_ACK_INVALID')
      pending.phase = 'queued'
    }).catch((error: unknown) => {
      pending.phase = 'failed'
      pending.model.release(); pending.transcript.release()
      pending.failure = this.failure('enqueue', session.sessionID, error, event.completionID, started)
      throw pending.failure
    })
    this.submissions.add(work)
    void work.finally(() => { this.submissions.delete(work) }).catch(() => {})
    await work
  }

  async context(session: SessionSnapshot, messages?: readonly unknown[]): Promise<void> {
    this.guard(session, false)
    const attempt = this.states.get(session.sessionID)?.attempt
    if (attempt?.phase === 'dispatch' && attempt.owner.turnSignal.aborted) {
      try { await runService(SERVICE_MS, session.turnSignal, () => attempt.receipt) } catch { fail('HOST_STOP_INTERRUPTION_UNAVAILABLE') }
      this.guard(session, false)
    }
    const state = this.states.get(session.sessionID), pending = state?.pending
    if (!pending) { this.history(session, messages); return }
    if (pending.phase !== 'queued') fail('HOST_STOP_ADMISSION_PENDING')
    pending.reading ??= (async () => {
      const started = performance.now()
      try {
        const history = await runService(SERVICE_MS, session.turnSignal, signal => this.options.history(session.sessionID, signal))
        this.live(pending, session)
        const row = history.messages.find(row => record(row) && row.id === pending.input.id)
        if (history.id !== session.sessionID || !row) fail('HOST_STOP_READBACK_UNAVAILABLE')
        pending.transcript.admit(row)
        pending.model.admit()
        this.live(pending, session)
        pending.phase = 'admitted'
        this.bytes -= pending.bytes
        delete state!.pending
      } catch (error) {
        pending.phase = 'failed'
        pending.model.release(); pending.transcript.release()
        pending.failure = this.failure('readback', session.sessionID, error, pending.completionID, started)
        throw pending.failure
      }
    })()
    await pending.reading
    this.history(session, messages)
  }

  private interrupted(receipt: V2ExecutionInterruption): void {
    const { owner } = receipt
    const state = this.states.get(owner.sessionID), attempt = state?.attempt
    if (receipt.reason !== 'user') fail('HOST_STOP_INTERRUPTION_REASON_UNAVAILABLE')
    this.options.runtime.sessions.interrupt(owner)
    if (!state || !attempt || attempt.owner.turnSignal !== owner.turnSignal || attempt.owner.turnID !== owner.turnID || attempt.owner.signal !== owner.signal || attempt.phase !== 'dispatch' || receipt.inputType !== 'user' || receipt.inputID !== owner.turnID) fail('HOST_STOP_INTERRUPTION_RECONCILIATION_UNAVAILABLE')
    if (!this.options.transcripts.admitStopInterruption) fail('HOST_STOP_ARTIFACT_UNAVAILABLE')
    const blocks = this.options.transcripts.admitStopInterruption(attempt.event, attempt.owner, { eventID: receipt.eventID, created: receipt.created, reason: 'user', source: 'sdk-cli' })
    this.retainHistory(state, owner, attempt.event.completionID, attempt.text, blocks)
    attempt.phase = 'interrupted'
    attempt.received()
  }

  private retainHistory(state: State, session: SessionSnapshot, completionID: string, text: string, blocks: StopModelBlocks & { readonly interrupted?: true }): void {
    if (!session.turnID || state.histories.has(completionID)) fail('HOST_STOP_HISTORY_UNAVAILABLE')
    const input = { completionID, turnID: session.turnID, assistantText: Object.freeze([text]), reminders: Object.freeze([...blocks.reminders]), feedback: Object.freeze([...blocks.feedback]), ...(blocks.interrupted ? { interrupted: true as const } : {}) }
    const bytes = Buffer.byteLength(JSON.stringify(input))
    if (this.historicalCount >= MAX_HISTORY || this.bytes + bytes > MAX_BYTES) fail('HOST_STOP_LIMIT')
    state.histories.set(completionID, { ...input, bytes })
    this.historicalCount++
    this.bytes += bytes
  }

  private history(session: SessionSnapshot, messages: readonly unknown[] | undefined): void {
    const state = this.states.get(session.sessionID)
    if (!state?.histories.size) return
    if (!Array.isArray(messages) || messages.length > MAX_CONTEXT_MESSAGES || !messages.every(record) || Buffer.byteLength(JSON.stringify(messages)) > MAX_BYTES) fail('HOST_STOP_HISTORY_UNAVAILABLE')
    const frames = new Map<string, { readonly row: Record<string, unknown>; readonly index: number }>()
    for (const [index, row] of messages.entries()) if (typeof row.id === 'string') {
      if (frames.has(row.id)) fail('HOST_STOP_HISTORY_UNAVAILABLE')
      frames.set(row.id, { row, index })
    }
    for (const history of state.histories.values()) {
      const original = frames.get(history.turnID), answer = frames.get(history.completionID)
      const nextID = history.nextPromptID ?? session.turnID
      const next = nextID ? frames.get(nextID) : undefined, completion = answer?.row
      if (!nextID || nextID === history.turnID || original?.row.role !== 'user' || !answer || answer.index <= original.index || next?.row.role !== 'user' || next.index !== answer.index + 1 || !completion || completion.role !== 'assistant' || !Array.isArray(completion.content) || !completion.content.every(part => record(part) && part.type === 'text' && typeof part.text === 'string') || !same(completion.content.map(part => part.text), history.assistantText)) fail('HOST_STOP_HISTORY_UNAVAILABLE')
      if (!history.nextPromptID) {
        this.options.contexts.rememberHistory(session, history)
        history.nextPromptID = nextID
      }
    }
  }

  dispose(): Promise<void> {
    this.lifetime.abort()
    this.disposing ??= (async () => {
      const started = performance.now()
      try { await runService(SERVICE_MS, undefined, async () => { await Promise.allSettled([...this.submissions, this.observing]) }) } catch { throw this.failure('drain', undefined, new HostHookError('HOST_STOP_ADMISSION_DRAIN_FAILED', 'failed'), undefined, started) }
      for (const state of this.states.values()) state.cleanup()
      this.events.dispose()
    })().finally(() => { this.disposing = undefined })
    return this.disposing
  }

  private live(pending: Pending, expected?: SessionSnapshot): void {
    const owner = pending.owner
    if (this.lifetime.signal.aborted || pending.signal.aborted || owner.signal.aborted || owner.turnSignal.aborted) fail('HOST_STOP_CANCELLED', 'cancelled')
    const current = expected ?? this.options.runtime.sessions.get(owner.sessionID)
    if (current.sessionID !== owner.sessionID || current.signal !== owner.signal || current.turnSignal !== owner.turnSignal || current.turnID !== owner.turnID) fail('HOST_STOP_CANCELLED', 'cancelled')
  }

  private state(session: SessionSnapshot): State {
    let state = this.states.get(session.sessionID)
    if (!state) {
      if (this.states.size >= MAX_SESSIONS) fail('HOST_STOP_LIMIT')
      const cleanup = () => {
        const state = this.states.get(session.sessionID)
        if (!state) return
        if (state.pending) { state.pending.model.release(); state.pending.transcript.release(); this.bytes -= state.pending.bytes }
        if (state.attempt) { this.bytes -= state.attempt.bytes; state.attempt.received() }
        for (const history of state.histories.values()) { this.bytes -= history.bytes; this.historicalCount-- }
        this.states.delete(session.sessionID)
        session.signal.removeEventListener('abort', cleanup)
      }
      state = { signal: session.signal, cleanup, histories: new Map() }
      this.states.set(session.sessionID, state)
      session.signal.addEventListener('abort', cleanup, { once: true })
    }
    return state
  }

  private failure(phase: string, sessionID: string | undefined, error: unknown, completionID: string | undefined, started: number): HostHookError {
    const failure = error instanceof HostHookError ? error : new HostHookError('HOST_STOP_FAILED', 'failed')
    console.error(JSON.stringify({ component: 'opencode-harness-hooks', host: 'v2', event: 'Stop', phase, ...(sessionID ? { sessionID } : {}), ...(completionID ? { completionID } : {}), code: failure.code, outcome: failure.outcome, durationMs: Math.round(performance.now() - started), activeSubmissions: this.submissions.size, retainedBytes: this.bytes, nativeEvents: this.events.inspect() }))
    return failure
  }
}
