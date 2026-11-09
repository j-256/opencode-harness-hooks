import { randomUUID } from 'node:crypto'
import { HostHookError } from './hosts/tools.js'
import type { SessionSnapshot } from './sessions.js'

const MAX_SESSIONS = 1024
const MAX_TURNS = 10000
const MAX_BYTES = 8 * 1024 * 1024
const MAX_YEAR = 9999
export interface ModelDate { readonly id: string; readonly date: string; readonly created: number }
interface Receipt { readonly date: ModelDate | null; readonly bytes: number }
interface State { readonly signal: AbortSignal; readonly turns: Map<string, Receipt>; readonly cleanup: () => void; date?: string; lastTurnID?: string }
function fail(code: string): never { throw new HostHookError(code, code === 'TRANSCRIPT_MODEL_CANCELLED' ? 'cancelled' : 'unsupported') }

export class ModelContext {
  private readonly states = new Map<string, State>()
  private turns = 0
  private dates = 0
  private bytes = 0
  private disposed = false

  constructor(private readonly now: () => number = Date.now) {}

  observe(session: SessionSnapshot): void {
    if (this.disposed || session.signal.aborted || session.turnSignal.aborted) fail('TRANSCRIPT_MODEL_CANCELLED')
    if (!session.turnID) fail('TRANSCRIPT_MODEL_CONTEXT_UNAVAILABLE')
    let state = this.states.get(session.sessionID)
    if (state && state.signal !== session.signal) fail('TRANSCRIPT_SESSION_MISMATCH')
    let created: number
    try { created = this.now() } catch { return fail('TRANSCRIPT_MODEL_CLOCK_UNAVAILABLE') }
    if (this.disposed || session.signal.aborted || session.turnSignal.aborted) fail('TRANSCRIPT_MODEL_CANCELLED')
    const time = new Date(created)
    if (!Number.isFinite(created) || Number.isNaN(time.getTime()) || time.getFullYear() < 0 || time.getFullYear() > MAX_YEAR) fail('TRANSCRIPT_MODEL_CLOCK_UNAVAILABLE')
    const date = [String(time.getFullYear()).padStart(4, '0'), String(time.getMonth() + 1).padStart(2, '0'), String(time.getDate()).padStart(2, '0')].join('-')
    if (state?.turns.has(session.turnID)) {
      if (state.lastTurnID !== session.turnID) fail('TRANSCRIPT_MODEL_TURN_REUSED')
      if (state.date !== date) fail('TRANSCRIPT_DATE_BOUNDARY_UNVERIFIED')
      return
    }
    const attachment = state?.date === date ? null : Object.freeze({ id: randomUUID(), date, created })
    const bytes = Buffer.byteLength(JSON.stringify([session.sessionID, session.turnID, attachment]))
    if (this.turns >= MAX_TURNS || this.bytes + bytes > MAX_BYTES || !state && this.states.size >= MAX_SESSIONS) fail('TRANSCRIPT_MODEL_LIMIT')
    if (!state) {
      const cleanup = () => {
        const previous = this.states.get(session.sessionID)
        if (!previous) return
        for (const receipt of previous.turns.values()) { this.turns--; this.bytes -= receipt.bytes; if (receipt.date) this.dates-- }
        this.states.delete(session.sessionID)
        session.signal.removeEventListener('abort', cleanup)
      }
      state = { signal: session.signal, turns: new Map(), cleanup }
      this.states.set(session.sessionID, state)
      session.signal.addEventListener('abort', cleanup, { once: true })
    }
    state.turns.set(session.turnID, { date: attachment, bytes })
    state.lastTurnID = session.turnID
    state.date = date
    this.turns++
    this.bytes += bytes
    if (attachment) this.dates++
  }

  read(sessionID: string, turnID: string, required: boolean): ModelDate | undefined {
    const receipt = this.states.get(sessionID)?.turns.get(turnID)
    if (!receipt && required) fail('TRANSCRIPT_MODEL_CONTEXT_UNAVAILABLE')
    return receipt?.date ?? undefined
  }

  dispose(): void { this.disposed = true; for (const state of this.states.values()) state.cleanup() }
  inspect() { return Object.freeze({ modelSessions: this.states.size, modelTurns: this.turns, modelDates: this.dates, modelBytes: this.bytes }) }
}
