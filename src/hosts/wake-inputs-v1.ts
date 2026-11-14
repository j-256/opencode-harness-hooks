import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { snapshotJsonObject } from '../bounded-json.js'
import { HostHookError } from '../host-errors.js'
import { SESSION_SNAPSHOT_VERSION, sessionSnapshot, snapshotID } from '../session-snapshot.js'
import type { SessionSnapshot } from '../sessions.js'

export const V1_WAKE_METADATA = 'harnessHooksWake'
const KIND = 'v1-wake-inputs'
const MAX_INPUTS = 10000
const MAX_SESSIONS = 1024
const DEFAULT_BYTES = 8 * 1024 * 1024
const MAX_BYTES = 32 * 1024 * 1024
const DATE_LIMIT = 8640000000000000
const PHASE = Object.freeze({ ISSUED: 'issued', EVALUATING: 'evaluating', SAVED: 'saved', RESUMING: 'resuming', RUNNING: 'running', FINISHED: 'finished', FAILED: 'failed' } as const)
const PARTIAL_PHASES = new Set<string>([PHASE.ISSUED, PHASE.EVALUATING, PHASE.FAILED])
const UNRESOLVED_PHASES = new Set<string>([PHASE.ISSUED, PHASE.EVALUATING, PHASE.RESUMING, PHASE.RUNNING])
const ID = z.string().refine(snapshotID)
const UUID = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
const MODEL = z.object({ providerID: ID, modelID: ID, variant: z.string().optional() }).strict()
const TOOLS = z.record(z.string(), z.boolean())
const DATE = z.number().int().nonnegative().max(DATE_LIMIT)
const ROW = z.object({ sessionID: ID, jobID: ID, saveNonce: UUID, resumeNonce: UUID, previousTurnID: ID.nullable(), textHash: z.string().regex(/^[a-f0-9]{64}$/), model: MODEL.nullable(), agent: ID.nullable(), tools: TOOLS.nullable(), promptIndex: z.number().int().nonnegative(), turnIndex: z.number().int().positive(), messageID: ID.nullable(), partID: ID.nullable(), created: DATE.nullable(), phase: z.enum(PHASE) }).strict()
export type V1WakeInput = Readonly<z.infer<typeof ROW>>
export interface V1WakeInputOptions { readonly jobID: string; readonly prompt: string; readonly model?: { readonly providerID: string; readonly modelID: string; readonly variant?: string }; readonly agent?: string; readonly tools?: Readonly<Record<string, boolean>>; readonly promptIndex: number; readonly turnIndex: number }
interface Options { readonly maxInputs?: number; readonly maxBytes?: number; readonly maxSessions?: number }
interface State { readonly owner: AbortSignal; readonly rows: Map<string, V1WakeInput>; bytes: number; revision: number }
interface HostMessage { readonly messageID: string; readonly partID: string | null; readonly created: number; readonly model: z.infer<typeof MODEL>; readonly agent: string; readonly tools: z.infer<typeof TOOLS> | null }
export interface V1WakeInputClaim { readonly phase: 'evaluate' | 'resume'; readonly input: V1WakeInput }
function fail(code: string, reason = ''): never { throw new HostHookError(code, code === 'HOST_WAKE_INPUT_CLOSED' ? 'cancelled' : 'unsupported', reason) }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function hash(value: string): string { return createHash('sha256').update(value).digest('hex') }
function freeze<T>(value: T): T { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) }; return value }
function equal(a: unknown, b: unknown): boolean { if (a === b) return true; if (!record(a) || !record(b)) return false; const keys = Object.keys(a); return keys.length === Object.keys(b).length && keys.every(key => a[key] === b[key]) }
function modelSelection(value: unknown): z.infer<typeof MODEL> {
  const parsed = MODEL.safeParse(record(value) ? { providerID: value.providerID, modelID: value.modelID, ...(value.variant !== undefined ? { variant: value.variant } : {}) } : value)
  if (!parsed.success) fail('HOST_WAKE_INPUT_OWNER_MISMATCH', 'model')
  return parsed.data
}
function rowBytes(row: V1WakeInput): number { return Buffer.byteLength(JSON.stringify(row)) + 1 }
function headerBytes(sessionID: string): number { return Buffer.byteLength(JSON.stringify({ kind: KIND, version: SESSION_SNAPSHOT_VERSION, sessionID, rows: [] })) }

export function wakeInputPart(input: V1WakeInput, prompt: string, phase: 'save' | 'resume') {
  if (typeof prompt !== 'string' || hash(prompt) !== input.textHash || phase !== 'save' && phase !== 'resume' || phase === 'resume' && !input.partID) fail('HOST_WAKE_INPUT_OWNER_MISMATCH')
  return freeze({ type: 'text' as const, text: prompt, synthetic: true as const, metadata: { [V1_WAKE_METADATA]: phase === 'save' ? input.saveNonce : input.resumeNonce }, ...(phase === 'resume' ? { id: input.partID! } : {}) })
}

export class V1WakeInputs {
  private readonly states = new Map<string, State>()
  private readonly closed = new Set<string>()
  private readonly maxInputs: number
  private readonly maxBytes: number
  private readonly maxSessions: number
  private closedBytes = 0
  private disposed = false
  constructor(options: Options = {}) {
    this.maxInputs = options.maxInputs ?? MAX_INPUTS; this.maxBytes = options.maxBytes ?? DEFAULT_BYTES; this.maxSessions = options.maxSessions ?? MAX_SESSIONS
    if (!Number.isSafeInteger(this.maxInputs) || this.maxInputs < 1 || this.maxInputs > MAX_INPUTS || !Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1 || this.maxBytes > MAX_BYTES || !Number.isSafeInteger(this.maxSessions) || this.maxSessions < 1 || this.maxSessions > MAX_SESSIONS) fail('HOST_WAKE_INPUT_LIMIT')
  }
  prepare(session: SessionSnapshot, input: V1WakeInputOptions): V1WakeInput {
    const state = this.state(session)
    if (typeof input.prompt !== 'string' || Buffer.byteLength(input.prompt) > MAX_BYTES) fail('HOST_WAKE_INPUT_OWNER_MISMATCH')
    if (state && [...state.rows.values()].some(row => row.jobID === input.jobID)) fail('HOST_WAKE_INPUT_PENDING')
    const row = this.row({ sessionID: session.sessionID, jobID: input.jobID, saveNonce: randomUUID(), resumeNonce: randomUUID(), previousTurnID: session.turnID ?? null, textHash: hash(input.prompt), model: input.model ? modelSelection(input.model) : null, agent: input.agent ?? null, tools: input.tools ?? null, promptIndex: input.promptIndex, turnIndex: input.turnIndex, messageID: null, partID: null, created: null, phase: PHASE.ISSUED }, session.sessionID)
    const bytes = rowBytes(row) + (state ? 0 : headerBytes(session.sessionID))
    if (this.count() >= this.maxInputs || this.bytes() + bytes > this.maxBytes) fail('HOST_WAKE_INPUT_LIMIT')
    this.unique(row, this.nonces())
    const current = state ?? this.create(session); current.rows.set(row.saveNonce, row); current.bytes += rowBytes(row); current.revision++
    return row
  }
  discardIssued(session: SessionSnapshot, nonce: string): void {
    const { state, row } = this.owned(session, nonce)
    if (row.phase !== PHASE.ISSUED || row.messageID !== null) fail('HOST_WAKE_INPUT_REUSED')
    state.rows.delete(nonce); state.bytes -= rowBytes(row); state.revision++
    if (!state.rows.size) this.states.delete(session.sessionID)
  }
  claim(session: SessionSnapshot, message: unknown, parts: unknown): V1WakeInputClaim | undefined {
    const state = this.state(session), markers = this.markers(parts)
    if (!markers.length) {
      if (record(message) && [...(state?.rows.values() ?? [])].some(row => row.messageID !== null && row.messageID === message.id)) fail('HOST_WAKE_INPUT_OWNER_MISMATCH')
      return undefined
    }
    if (markers.length !== 1 || typeof markers[0] !== 'string') fail('HOST_WAKE_INPUT_OWNER_MISMATCH')
    const nonce = markers[0], row = [...(state?.rows.values() ?? [])].find(row => row.saveNonce === nonce || row.resumeNonce === nonce)
    if (!state || !row) fail('HOST_WAKE_INPUT_OWNER_MISMATCH', 'nonce')
    const saving = nonce === row.saveNonce
    if (row.phase !== (saving ? PHASE.ISSUED : PHASE.RESUMING)) fail('HOST_WAKE_INPUT_REUSED')
    if (session.turnSignal.aborted || (session.turnID ?? null) !== (saving ? row.previousTurnID : row.messageID)) fail('HOST_WAKE_INPUT_OWNER_MISMATCH', 'generation')
    const observed = this.verify(row, message, parts, nonce, !saving)
    if (saving && (observed.messageID === row.previousTurnID || [...state.rows.values()].some(other => other !== row && other.messageID === observed.messageID))) fail('HOST_WAKE_INPUT_OWNER_MISMATCH', 'message-identity')
    if (!saving) {
      const descriptor = record(message) && record(message.time) ? Object.getOwnPropertyDescriptor(message.time, 'created') : undefined
      if (!descriptor || !('value' in descriptor) || descriptor.writable !== true) fail('HOST_WAKE_INPUT_OWNER_MISMATCH', 'timestamp-mutation')
    }
    const next = this.update(state, row, { ...row, ...observed, phase: saving ? PHASE.EVALUATING : PHASE.RUNNING })
    if (!saving) (message as { time: { created: number } }).time.created = row.created!
    return Object.freeze({ phase: saving ? 'evaluate' : 'resume', input: next })
  }
  saved(session: SessionSnapshot, nonce: string, value: unknown): V1WakeInput {
    const { state, row } = this.owned(session, nonce)
    if (row.phase !== PHASE.EVALUATING) fail('HOST_WAKE_INPUT_REUSED')
    if (!record(value)) fail('HOST_WAKE_INPUT_OWNER_MISMATCH')
    const observed = this.verify(row, value.info, value.parts, row.saveNonce, true)
    return this.update(state, row, { ...row, ...observed, phase: PHASE.SAVED })
  }
  resume(session: SessionSnapshot, nonce: string): V1WakeInput {
    const { state, row } = this.owned(session, nonce)
    if (row.phase !== PHASE.SAVED) fail('HOST_WAKE_INPUT_REUSED')
    if (session.turnSignal.aborted || session.turnID !== row.messageID) fail('HOST_WAKE_INPUT_OWNER_MISMATCH')
    return this.update(state, row, { ...row, phase: PHASE.RESUMING })
  }
  cancelResume(session: SessionSnapshot, nonce: string): void {
    const { state, row } = this.owned(session, nonce)
    if (row.phase !== PHASE.RESUMING) fail('HOST_WAKE_INPUT_REUSED')
    this.update(state, row, { ...row, phase: PHASE.SAVED })
  }
  finish(session: SessionSnapshot, nonce: string, value: unknown): V1WakeInput {
    const { state, row } = this.owned(session, nonce)
    if (row.phase !== PHASE.SAVED && row.phase !== PHASE.RUNNING) fail('HOST_WAKE_INPUT_REUSED')
    if (!record(value)) fail('HOST_WAKE_INPUT_OWNER_MISMATCH')
    this.verify(row, value.info, value.parts, row.phase === PHASE.SAVED ? row.saveNonce : row.resumeNonce, true)
    return this.update(state, row, { ...row, phase: PHASE.FINISHED })
  }
  fail(session: SessionSnapshot, nonce: string): void { const { state, row } = this.owned(session, nonce); if (row.phase !== PHASE.FINISHED && row.phase !== PHASE.FAILED) this.update(state, row, { ...row, phase: PHASE.FAILED }) }
  normalize<T>(sessionID: string, input: T): T {
    if (this.disposed || this.closed.has(sessionID)) fail('HOST_WAKE_INPUT_CLOSED')
    if (!Array.isArray(input) || input.length > MAX_INPUTS) fail('HOST_WAKE_INPUT_OWNER_MISMATCH')
    const state = this.states.get(sessionID), rows = new Map<string, V1WakeInput>(), messages = new Set<string>(), seen = new Set<string>()
    if (state?.owner.aborted) fail('HOST_WAKE_INPUT_CLOSED')
    for (const row of state?.rows.values() ?? []) { rows.set(row.saveNonce, row); rows.set(row.resumeNonce, row); if (row.messageID) messages.add(row.messageID) }
    return input.map(raw => {
      const markers = this.markers(record(raw) ? raw.parts : undefined)
      if (!markers.length) {
        if (record(raw) && record(raw.info) && typeof raw.info.id === 'string' && messages.has(raw.info.id)) fail('HOST_WAKE_INPUT_OWNER_MISMATCH')
        return raw
      }
      if (!record(raw) || markers.length !== 1 || typeof markers[0] !== 'string') fail('HOST_WAKE_INPUT_OWNER_MISMATCH')
      const nonce = markers[0], row = rows.get(nonce)
      if (!row || !row.messageID || !row.partID || seen.has(row.messageID)) fail('HOST_WAKE_INPUT_OWNER_MISMATCH')
      this.verify(row, raw.info, raw.parts, nonce, true); seen.add(row.messageID)
      const part = { ...(raw.parts as Record<string, unknown>[])[0] }; delete part.synthetic
      return { ...raw, parts: [part] }
    }) as T
  }
  read(session: SessionSnapshot): readonly V1WakeInput[] { return Object.freeze([...(this.state(session)?.rows.values() ?? [])]) }
  hasUnresolved(session: SessionSnapshot): boolean { return this.read(session).some(row => UNRESOLVED_PHASES.has(row.phase)) }
  requiresProjection(sessionID: string): boolean { return !this.disposed && !this.closed.has(sessionID) && (this.states.get(sessionID)?.rows.size ?? 0) > 0 }
  discardPendingPrompt(session: SessionSnapshot, messageID: string): void { if (!snapshotID(messageID) || this.read(session).some(row => row.messageID === messageID)) fail('SESSION_SNAPSHOT_PROMPT_RECONCILIATION_UNAVAILABLE') }
  snapshotV1(sessionID: string): unknown {
    if (this.disposed || this.closed.has(sessionID) || !snapshotID(sessionID) || this.states.get(sessionID)?.owner.aborted) fail('HOST_WAKE_INPUT_CLOSED')
    return this.copy({ kind: KIND, version: SESSION_SNAPSHOT_VERSION, sessionID, rows: [...(this.states.get(sessionID)?.rows.values() ?? [])] })
  }
  restoreV1(session: SessionSnapshot, value: unknown): () => void {
    if (this.state(session)) fail('SESSION_SNAPSHOT_STATE_CONFLICT')
    const input = sessionSnapshot(KIND, this.copy(value), session, ['rows'])
    if (!Array.isArray(input.rows)) fail('SESSION_SNAPSHOT_SCHEMA_INVALID')
    if (this.count() + input.rows.length > this.maxInputs) fail('HOST_WAKE_INPUT_LIMIT')
    const rows = new Map<string, V1WakeInput>(), jobs = new Set<string>(), nonces = this.nonces(), messages = new Set<string>(); let bytes = headerBytes(session.sessionID)
    for (const value of input.rows) {
      const row = this.row(value, session.sessionID)
      if (jobs.has(row.jobID) || row.messageID && messages.has(row.messageID)) fail('SESSION_SNAPSHOT_SCHEMA_INVALID')
      jobs.add(row.jobID); if (row.messageID) messages.add(row.messageID)
      this.unique(row, nonces); rows.set(row.saveNonce, row); bytes += rowBytes(row)
    }
    if (!rows.size) return () => {}
    if (this.bytes() + bytes > this.maxBytes) fail('HOST_WAKE_INPUT_LIMIT')
    const state = this.create(session); for (const [id, row] of rows) state.rows.set(id, row); state.bytes = bytes
    return () => { if (this.states.get(session.sessionID) !== state || state.revision !== 0) fail('HOST_WAKE_INPUT_STATE_CHANGED'); this.states.delete(session.sessionID) }
  }
  removeSession(sessionID: string): void {
    if (this.disposed || !snapshotID(sessionID)) fail('HOST_WAKE_INPUT_CLOSED')
    if (this.closed.has(sessionID)) return
    const state = this.states.get(sessionID), bytes = Buffer.byteLength(JSON.stringify(sessionID)) + 1
    if (!state && this.states.size + this.closed.size >= this.maxSessions || this.bytes() - (state?.bytes ?? 0) + bytes > this.maxBytes) fail('HOST_WAKE_INPUT_LIMIT')
    this.states.delete(sessionID); this.closed.add(sessionID); this.closedBytes += bytes
  }
  dispose(): void { this.disposed = true; this.states.clear(); this.closed.clear(); this.closedBytes = 0 }
  inspect() { return Object.freeze({ sessions: this.states.size, inputs: this.count(), bytes: this.bytes(), closed: this.closed.size, disposed: this.disposed }) }
  private markers(parts: unknown): readonly unknown[] { return Array.isArray(parts) ? parts.flatMap(part => record(part) && record(part.metadata) && Object.hasOwn(part.metadata, V1_WAKE_METADATA) ? [part.metadata[V1_WAKE_METADATA]] : []) : [] }
  private verify(row: V1WakeInput, message: unknown, parts: unknown, nonce: string, complete: boolean): HostMessage {
    if (!record(message) || message.role !== 'user' || message.sessionID !== row.sessionID || !snapshotID(message.id) || row.messageID && message.id !== row.messageID || !record(message.time) || !DATE.safeParse(message.time.created).success || !Array.isArray(parts) || parts.length !== 1) fail('HOST_WAKE_INPUT_OWNER_MISMATCH', 'message')
    const part: unknown = parts[0], model = modelSelection(message.model), agent = ID.safeParse(message.agent), tools = TOOLS.nullable().safeParse(message.tools ?? null)
    if (!record(part) || part.type !== 'text' || part.synthetic !== true || part.ignored === true || !record(part.metadata) || part.metadata[V1_WAKE_METADATA] !== nonce || typeof part.text !== 'string' || hash(part.text) !== row.textHash) fail('HOST_WAKE_INPUT_OWNER_MISMATCH', 'part')
    if (row.model && (row.phase === PHASE.ISSUED ? row.model.providerID !== model.providerID || row.model.modelID !== model.modelID || row.model.variant !== undefined && row.model.variant !== model.variant : !equal(row.model, model))) fail('HOST_WAKE_INPUT_OWNER_MISMATCH', 'model')
    if (!agent.success || row.agent && row.agent !== agent.data) fail('HOST_WAKE_INPUT_OWNER_MISMATCH', 'agent')
    if (!tools.success || (row.tools !== null || row.phase !== PHASE.ISSUED) && !equal(row.tools, tools.data)) fail('HOST_WAKE_INPUT_OWNER_MISMATCH', 'tools')
    const partID = snapshotID(part.id) ? part.id : null
    if (complete && !partID || row.partID && partID !== row.partID) fail('HOST_WAKE_INPUT_OWNER_MISMATCH', 'part-identity')
    if (complete && row.created !== null && message.time.created !== row.created && row.phase !== PHASE.RESUMING) fail('HOST_WAKE_INPUT_OWNER_MISMATCH', 'timestamp')
    return { messageID: message.id, partID, created: row.phase === PHASE.RESUMING ? row.created! : message.time.created as number, model, agent: agent.data, tools: tools.data }
  }
  private owned(session: SessionSnapshot, nonce: string): { readonly state: State; readonly row: V1WakeInput } { const state = this.state(session), row = state?.rows.get(nonce); if (!state || !row) fail('HOST_WAKE_INPUT_OWNER_MISMATCH'); return { state, row } }
  private row(value: unknown, sessionID: string): V1WakeInput {
    const parsed = ROW.safeParse(this.copy(value)); if (!parsed.success) fail('SESSION_SNAPSHOT_SCHEMA_INVALID')
    const row = parsed.data, issued = row.phase === PHASE.ISSUED, identified = row.messageID !== null
    if (row.sessionID !== sessionID || row.saveNonce === row.resumeNonce || row.turnIndex <= row.promptIndex || identified && row.messageID === row.previousTurnID || issued && identified || !issued && row.phase !== PHASE.FAILED && !identified || identified !== (row.created !== null) || identified && (!row.model || !row.agent) || !identified && row.partID !== null || !PARTIAL_PHASES.has(row.phase) && !row.partID) fail('SESSION_SNAPSHOT_SCHEMA_INVALID')
    return freeze(row)
  }
  private update(state: State, previous: V1WakeInput, input: V1WakeInput): V1WakeInput {
    const row = this.row(input, previous.sessionID), delta = rowBytes(row) - rowBytes(previous)
    if (this.bytes() + delta > this.maxBytes) fail('HOST_WAKE_INPUT_LIMIT')
    state.rows.set(row.saveNonce, row); state.bytes += delta; state.revision++; return row
  }
  private unique(row: V1WakeInput, nonces: Set<string>): void { for (const nonce of [row.saveNonce, row.resumeNonce]) { if (nonces.has(nonce)) fail('SESSION_SNAPSHOT_SCHEMA_INVALID'); nonces.add(nonce) } }
  private nonces(): Set<string> { return new Set([...this.states.values()].flatMap(state => [...state.rows.values()].flatMap(row => [row.saveNonce, row.resumeNonce]))) }
  private state(session: SessionSnapshot): State | undefined { if (this.disposed || this.closed.has(session.sessionID) || session.signal.aborted || !snapshotID(session.sessionID)) fail('HOST_WAKE_INPUT_CLOSED'); const state = this.states.get(session.sessionID); if (state && state.owner !== session.signal) fail('HOST_WAKE_INPUT_OWNER_MISMATCH'); return state }
  private create(session: SessionSnapshot): State { if (this.states.size + this.closed.size >= this.maxSessions) fail('HOST_WAKE_INPUT_LIMIT'); const state: State = { owner: session.signal, rows: new Map(), bytes: headerBytes(session.sessionID), revision: 0 }; this.states.set(session.sessionID, state); return state }
  private copy(value: unknown): unknown { return snapshotJsonObject({ value }, this.maxBytes, kind => fail(kind === 'size' ? 'HOST_WAKE_INPUT_LIMIT' : 'SESSION_SNAPSHOT_SCHEMA_INVALID')).value.value }
  private count(): number { return [...this.states.values()].reduce((sum, state) => sum + state.rows.size, 0) }
  private bytes(): number { return this.closedBytes + [...this.states.values()].reduce((sum, state) => sum + state.bytes, 0) }
}
