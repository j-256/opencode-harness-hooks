import { randomUUID } from 'node:crypto'
import { HostHookError } from './tools.js'
import { runService } from '../service-execution.js'
import type { createRuntime } from '../runtime.js'
import type { PromptContexts, PromptContinuationReservation } from '../prompt-contexts.js'
import type { SessionSnapshot } from '../sessions.js'
import type { StopDelivery } from '../stop.js'
import type { TranscriptHistory, TranscriptService, TranscriptContinuationReservation } from '../transcript.js'

const SERVICE_MS = 5000
const MAX_SESSIONS = 1024
const MAX_BYTES = 32 * 1024 * 1024
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
interface State { readonly signal: AbortSignal; readonly cleanup: () => void; pending?: Pending; historical: boolean }
interface Options {
  readonly directory: string
  readonly runtime: Pick<Runtime, 'sessions' | 'stop'>
  readonly transcripts: TranscriptService
  readonly contexts: PromptContexts
  readonly history: (sessionID: string, signal: AbortSignal) => Promise<TranscriptHistory>
  readonly synthetic: (input: V2SyntheticInput) => Promise<unknown>
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
  private disposing: Promise<void> | undefined

  constructor(private readonly options: Options) {}

  guard(session: SessionSnapshot, ready = true): void {
    if (this.lifetime.signal.aborted) fail('HOST_STOP_DISPOSED', 'cancelled')
    if (session.signal.aborted || session.turnSignal.aborted) fail('HOST_STOP_CANCELLED', 'cancelled')
    const state = this.states.get(session.sessionID)
    if (state && state.signal !== session.signal) fail('HOST_STOP_SESSION_MISMATCH')
    if (state?.historical) fail('HOST_STOP_HISTORY_PROJECTION_UNAVAILABLE')
    const pending = state?.pending
    if (!pending) return
    if (pending.failure) throw pending.failure
    this.live(pending, session)
    if (ready) fail('HOST_STOP_ADMISSION_PENDING')
  }

  async idle(frame: V2IdleEvent): Promise<void> {
    const started = performance.now()
    let completionID: string | undefined
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
      await this.options.runtime.stop({ ...event, data: { transcript_path: path, last_assistant_message: last.content[0].text, background_tasks: [], session_crons: [] } })
    } catch (error) { throw this.failure('completion', frame.sessionID, error, completionID, started) }
  }

  async admit(delivery: StopDelivery): Promise<void> {
    const { session, event, effects } = delivery
    this.guard(session)
    if (effects.cancelled || delivery.signal.aborted) fail('HOST_STOP_CANCELLED', 'cancelled')
    if (effects.permission || effects.input || effects.block || effects.context.length || effects.feedback.length || effects.warnings.length || effects.extensions.length || effects.resultReplacements.length || effects.unresolved.length) fail('HOST_STOP_EFFECT_UNAVAILABLE')
    if (!this.options.transcripts.admitStop || !this.options.transcripts.reserveContinuation) fail('HOST_STOP_ARTIFACT_UNAVAILABLE')
    const projection = this.options.transcripts.admitStop(delivery)
    if (effects.stop || !effects.continuations.length) {
      if (projection.length) this.state(session).historical = true
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

  async context(session: SessionSnapshot): Promise<void> {
    this.guard(session, false)
    const state = this.states.get(session.sessionID), pending = state?.pending
    if (!pending) return
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
  }

  dispose(): Promise<void> {
    this.lifetime.abort()
    this.disposing ??= (async () => {
      const started = performance.now()
      try { await runService(SERVICE_MS, undefined, async () => { await Promise.allSettled([...this.submissions]) }) } catch { throw this.failure('drain', undefined, new HostHookError('HOST_STOP_ADMISSION_DRAIN_FAILED', 'failed'), undefined, started) }
      for (const state of this.states.values()) state.cleanup()
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
        this.states.delete(session.sessionID)
        session.signal.removeEventListener('abort', cleanup)
      }
      state = { signal: session.signal, cleanup, historical: false }
      this.states.set(session.sessionID, state)
      session.signal.addEventListener('abort', cleanup, { once: true })
    }
    return state
  }

  private failure(phase: string, sessionID: string | undefined, error: unknown, completionID: string | undefined, started: number): HostHookError {
    const failure = error instanceof HostHookError ? error : new HostHookError('HOST_STOP_FAILED', 'failed')
    console.error(JSON.stringify({ component: 'opencode-harness-hooks', host: 'v2', event: 'Stop', phase, ...(sessionID ? { sessionID } : {}), ...(completionID ? { completionID } : {}), code: failure.code, outcome: failure.outcome, durationMs: Math.round(performance.now() - started), activeSubmissions: this.submissions.size, retainedBytes: this.bytes }))
    return failure
  }
}
