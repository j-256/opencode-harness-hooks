const DEFAULT_SESSION_LIMIT = 1024

export class SessionError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'SessionError' }
}

export interface SessionSnapshot {
  readonly sessionID: string
  readonly turnID?: string
  readonly model?: string
  readonly signal: AbortSignal
  readonly turnSignal: AbortSignal
}
interface State {
  readonly controller: AbortController
  turnController: AbortController
  turnID?: string
  model?: string
}

export class Sessions {
  private readonly states = new Map<string, State>()
  private disposed = false

  constructor(private readonly limit = DEFAULT_SESSION_LIMIT) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new SessionError('SESSION_LIMIT_INVALID')
  }

  get(sessionID: string): SessionSnapshot {
    const state = this.state(sessionID)
    return Object.freeze({ sessionID, signal: state.controller.signal, turnSignal: state.turnController.signal, ...(state.turnID ? { turnID: state.turnID } : {}), ...(state.model ? { model: state.model } : {}) })
  }

  prompt(sessionID: string, turnID: string, model?: string): void {
    if (typeof turnID !== 'string' || !turnID) throw new SessionError('SESSION_TURN_INVALID')
    const state = this.state(sessionID)
    if (state.turnID !== turnID) {
      state.turnController.abort()
      state.turnController = new AbortController()
      delete state.model
    }
    state.turnID = turnID
    if (model !== undefined) this.model(sessionID, model, turnID)
  }

  model(sessionID: string, model: string, turnID?: string): void {
    if (typeof model !== 'string' || !model) throw new SessionError('SESSION_MODEL_INVALID')
    const state = this.state(sessionID)
    if (turnID !== undefined && state.turnID !== turnID) throw new SessionError('SESSION_STALE_TURN')
    state.model = model
  }

  close(sessionID: string): void {
    if (this.disposed && !this.states.has(sessionID)) return
    const state = this.states.get(sessionID) ?? this.state(sessionID)
    state.controller.abort()
    state.turnController.abort()
    delete state.model
    delete state.turnID
  }

  dispose(): void {
    this.disposed = true
    for (const sessionID of this.states.keys()) this.close(sessionID)
  }

  inspect() {
    return Object.freeze({ disposed: this.disposed, active: [...this.states.values()].filter(state => !state.controller.signal.aborted).length, retained: this.states.size, limit: this.limit })
  }

  private state(sessionID: string): State {
    if (this.disposed) throw new SessionError('SESSION_DISPOSED')
    if (typeof sessionID !== 'string' || !sessionID) throw new SessionError('SESSION_ID_INVALID')
    let state = this.states.get(sessionID)
    if (state?.controller.signal.aborted) throw new SessionError('SESSION_CLOSED')
    if (!state) {
      if (this.states.size >= this.limit) throw new SessionError('SESSION_LIMIT')
      state = { controller: new AbortController(), turnController: new AbortController() }
      this.states.set(sessionID, state)
    }
    return state
  }
}
