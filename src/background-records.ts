import { createHash } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { z } from 'zod'
import { claudeBackgroundArtifact } from './background-artifacts.js'
import type { BackgroundArtifact } from './background-artifacts.js'
import type { BackgroundCompletion, BackgroundDelivery } from './background-types.js'
import { isBackground } from './background-types.js'
import { snapshotJsonObject } from './bounded-json.js'
import { HostHookError } from './host-errors.js'
import { EXECUTION_LIMITS } from './runner.js'
import { SESSION_SNAPSHOT_VERSION, sessionSnapshot, snapshotID } from './session-snapshot.js'
import type { SessionSnapshot } from './sessions.js'
import type { Registration } from './types.js'
import { runService } from './service-execution.js'

const KIND = 'background-records-v1'
const DEFAULT_RECORDS = 10000
const DEFAULT_BYTES = 8 * 1024 * 1024
const DEFAULT_SESSIONS = 1024
const MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024
const DATE_LIMIT = 8640000000000000
const DIGEST = /^[a-f0-9]{64}$/
const BINDING = Object.freeze({ OPEN: 'open', COMMITTED: 'committed', RELEASED: 'released' } as const)
const ID = z.string().refine(snapshotID)
const HASH = z.string().regex(DIGEST)
const CONTEXT = z.object({ kind: z.literal('context'), text: z.string(), placement: z.literal('model'), channel: z.enum(['stdout', 'additionalContext', 'systemMessage']).optional() }).strict()
const WARNING = z.object({ kind: z.literal('warning'), text: z.string() }).strict()
const DELIVERY = z.object({
  id: ID, sourceID: ID, sourceDigest: HASH, registrationID: ID, dialect: z.enum(['claude-code', 'codex']), event: ID, hookName: ID.optional(), mode: z.literal('safe-point'), actions: z.array(z.union([CONTEXT, WARNING])).max(DEFAULT_RECORDS),
  completion: z.object({ completedAt: z.number().int().min(0).max(DATE_LIMIT), execution: z.object({ status: z.literal('exited'), exitCode: z.number().int().nullable(), signal: z.null(), stdout: z.string(), stderr: z.string(), durationMs: z.number().int().nonnegative(), processID: z.number().int().positive().optional() }).strict() }).strict(),
}).strict()
const ANCHOR_FIELDS = { sessionID: ID, turnID: ID, messageID: ID, signature: HASH }
const ANCHOR = z.discriminatedUnion('kind', [z.object({ kind: z.literal('prompt'), ...ANCHOR_FIELDS }).strict(), z.object({ kind: z.literal('tool'), ...ANCHOR_FIELDS, callID: ID }).strict()])
type Delivery = BackgroundDelivery & { readonly sourceDigest: string; readonly mode: 'safe-point'; readonly completion: BackgroundCompletion }
export type BackgroundAnchor = z.infer<typeof ANCHOR>
export interface BackgroundEntry {
  readonly id: string; readonly sourceID: string; readonly sourceDigest: string; readonly registrationID: string; readonly dialect: Delivery['dialect']; readonly event: string
  readonly anchor?: BackgroundAnchor; readonly artifact?: BackgroundArtifact; readonly model: readonly string[]; readonly warnings: readonly string[]; readonly warningsDelivered: boolean
  readonly completedAt: number
}
interface Row { readonly delivery: Delivery; readonly artifact?: BackgroundArtifact; readonly model: readonly string[]; readonly warnings: readonly string[]; anchor?: BackgroundAnchor; warningsDelivered: boolean }
interface State { readonly owner: AbortSignal; readonly rows: Map<string, Row>; readonly receipts: Map<string, string>; bytes: number; revision: number; binding?: symbol; bindingDone?: { readonly promise: Promise<void>; readonly resolve: () => void } }
export interface BackgroundBinding { readonly commit: () => void; readonly release: () => void; readonly persist: <T>(operation: () => Promise<T>) => Promise<T> }
interface Options { readonly registrations?: readonly Registration[]; readonly maxRecords?: number; readonly maxBytes?: number; readonly maxSessions?: number }
function fail(code: string): never { throw new HostHookError(code, code === 'BACKGROUND_TURN_UNAVAILABLE' || code === 'BACKGROUND_SESSION_CLOSED' ? 'cancelled' : 'unsupported') }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value !== null && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key])).join(',') + '}'
  return JSON.stringify(value) ?? fail('BACKGROUND_DELIVERY_INVALID')
}
function hash(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex') }
function key(value: { readonly sourceID: string; readonly sourceDigest?: string; readonly id?: string; readonly registrationID?: string; readonly dialect: string; readonly event: string }): string { return JSON.stringify([value.sourceID, value.sourceDigest, value.registrationID ?? value.id, value.dialect, value.event]) }
function freeze<T>(value: T): T { if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value) }; return value }
function snapshotRow(row: Row) { return { delivery: row.delivery, anchor: row.anchor ?? null, warningsDelivered: row.warningsDelivered } }
function rowBytes(row: Row): number { return Buffer.byteLength(JSON.stringify(snapshotRow(row))) }
function receiptBytes(id: string, hash: string): number { return Buffer.byteLength(JSON.stringify({ id, hash })) }
function headerBytes(sessionID: string): number { return Buffer.byteLength(JSON.stringify({ value: { kind: KIND, version: SESSION_SNAPSHOT_VERSION, sessionID, rows: [], receipts: [] } })) }
export function backgroundAnchor(value: unknown): BackgroundAnchor {
  const parsed = ANCHOR.safeParse(value); if (!parsed.success) fail('BACKGROUND_ANCHOR_INVALID')
  return freeze(parsed.data)
}
function reservation(commit: () => void, release: () => void, persist: BackgroundBinding['persist'] = operation => operation()): BackgroundBinding {
  let status: typeof BINDING[keyof typeof BINDING] = BINDING.OPEN
  return Object.freeze({ commit: () => { if (status === BINDING.COMMITTED) return; if (status === BINDING.RELEASED) fail('BACKGROUND_BINDING_STALE'); commit(); status = BINDING.COMMITTED }, release: () => { if (status !== BINDING.OPEN) return; release(); status = BINDING.RELEASED }, persist: <T>(operation: () => Promise<T>) => { if (status !== BINDING.OPEN) fail('BACKGROUND_BINDING_STALE'); return persist(operation) } })
}

export class BackgroundRecords {
  private readonly states = new Map<string, State>()
  private readonly closed = new Set<string>()
  private readonly authorized = new Map<string, string>()
  // Only the reserving operation may checkpoint a provisional anchor
  private readonly bindingScope = new AsyncLocalStorage<symbol>()
  private authorizedBytes = 0
  private readonly maxRecords: number
  private readonly maxBytes: number
  private readonly maxSessions: number
  private disposed = false
  constructor(options: Options = {}) {
    this.maxRecords = options.maxRecords ?? DEFAULT_RECORDS; this.maxBytes = options.maxBytes ?? DEFAULT_BYTES; this.maxSessions = options.maxSessions ?? DEFAULT_SESSIONS
    if (!Number.isSafeInteger(this.maxRecords) || this.maxRecords < 1 || this.maxRecords > DEFAULT_RECORDS || !Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1 || this.maxBytes > MAX_SNAPSHOT_BYTES || !Number.isSafeInteger(this.maxSessions) || this.maxSessions < 1) fail('BACKGROUND_RECORD_LIMIT_INVALID')
    this.configure(options.registrations ?? [])
  }
  configure(registrations: readonly Registration[]): void {
    if (this.disposed || registrations.length > DEFAULT_RECORDS) fail('BACKGROUND_RECORD_LIMIT')
    const next = new Map<string, string>(); let bytes = 0
    for (const input of registrations) {
      const value = snapshotJsonObject(input, EXECUTION_LIMITS.inputBytes, () => fail('BACKGROUND_SOURCE_INVALID')).value as unknown as Registration
      if (!snapshotID(value.id) || !snapshotID(value.sourceID) || !value.sourceDigest || !DIGEST.test(value.sourceDigest) || !isBackground(value) || value.handler.asyncRewake === true) fail('BACKGROUND_SOURCE_INVALID')
      const id = key(value), signature = hash(value); if (next.has(id)) fail('BACKGROUND_SOURCE_INVALID'); next.set(id, signature); bytes += Buffer.byteLength(id) + signature.length
    }
    if (this.usedBytes() - this.authorizedBytes + bytes > this.maxBytes) fail('BACKGROUND_RECORD_LIMIT')
    this.authorized.clear(); for (const [id, signature] of next) this.authorized.set(id, signature)
    this.authorizedBytes = bytes
  }
  assertRegistration(input: Registration): void {
    const value = snapshotJsonObject(input, EXECUTION_LIMITS.inputBytes, () => fail('BACKGROUND_SOURCE_INVALID')).value
    if (this.authorized.get(key(input)) !== hash(value)) fail('BACKGROUND_SOURCE_UNAVAILABLE')
  }
  admit(session: SessionSnapshot, input: BackgroundDelivery): boolean {
    const current = this.state(session), delivery = this.delivery(input), digest = hash(delivery), previous = current?.receipts.get(delivery.id)
    if (previous) { if (previous !== digest) fail('BACKGROUND_DELIVERY_REUSED'); return false }
    if (!this.authorized.has(key(delivery))) fail('BACKGROUND_SOURCE_UNAVAILABLE')
    const row = this.row(delivery), meaningful = !!row.artifact || row.model.length > 0 || row.warnings.length > 0, state = current ?? this.create(session)
    const bytes = receiptBytes(delivery.id, digest) + 1 + (meaningful ? rowBytes(row) + 1 : 0)
    if (this.receiptCount() >= this.maxRecords || this.usedBytes() + bytes > this.maxBytes) { if (!current) this.states.delete(session.sessionID); fail('BACKGROUND_RECORD_LIMIT') }
    state.receipts.set(delivery.id, digest); if (meaningful) state.rows.set(delivery.id, row); state.bytes += bytes; state.revision++
    return meaningful
  }
  reserveBind(session: SessionSnapshot, input: BackgroundAnchor): BackgroundBinding {
    this.turn(session)
    const anchor = backgroundAnchor(this.copy(input))
    if (anchor.sessionID !== session.sessionID || anchor.turnID !== session.turnID || anchor.kind === 'prompt' && anchor.messageID !== anchor.turnID || anchor.kind === 'tool' && anchor.messageID === anchor.turnID) fail('BACKGROUND_ANCHOR_INVALID')
    const state = this.state(session)
    if (!state) return reservation(() => { this.turn(session) }, () => {})
    if (state.binding) fail('BACKGROUND_BINDING_PENDING')
    const pending = [...state.rows.values()].filter(row => !row.anchor && (row.artifact || row.model.length)), bytes = pending.reduce((total, row) => total + rowBytes({ ...row, anchor }) - rowBytes(row), 0)
    if (this.usedBytes() + bytes > this.maxBytes) fail('BACKGROUND_RECORD_LIMIT')
    const token = Symbol(), generation = state.owner
    let resolve!: () => void
    state.bindingDone = { promise: new Promise<void>(done => { resolve = done }), resolve: () => resolve() }
    state.binding = token; for (const row of pending) row.anchor = anchor; state.bytes += bytes; state.revision++
    const release = () => {
      if (this.states.get(session.sessionID) !== state || state.owner !== generation || state.binding !== token) return
      for (const row of pending) if (row.anchor === anchor) delete row.anchor
      state.bytes -= bytes; delete state.binding; state.bindingDone!.resolve(); delete state.bindingDone; state.revision++
    }
    return reservation(() => { this.turn(session); if (this.state(session) !== state || state.binding !== token) fail('BACKGROUND_BINDING_STALE'); delete state.binding; state.bindingDone!.resolve(); delete state.bindingDone; state.revision++ }, release, operation => this.bindingScope.run(token, operation))
  }
  read(session: SessionSnapshot): readonly BackgroundEntry[] {
    const state = this.state(session); if (state?.binding) fail('BACKGROUND_BINDING_PENDING')
    return Object.freeze([...(state?.rows.values() ?? [])].map(row => freeze({ id: row.delivery.id, sourceID: row.delivery.sourceID, sourceDigest: row.delivery.sourceDigest, registrationID: row.delivery.registrationID, dialect: row.delivery.dialect, event: row.delivery.event, completedAt: row.delivery.completion.completedAt, ...(row.anchor ? { anchor: row.anchor } : {}), ...(row.artifact ? { artifact: row.artifact } : {}), model: row.model, warnings: row.warnings, warningsDelivered: row.warningsDelivered })))
  }
  warnings(session: SessionSnapshot): readonly { readonly id: string; readonly texts: readonly string[] }[] { return Object.freeze(this.read(session).filter(row => row.warnings.length && !row.warningsDelivered).map(row => Object.freeze({ id: row.id, texts: row.warnings }))) }
  hasPending(session: SessionSnapshot): boolean { return this.read(session).some(row => !row.anchor && (row.artifact || row.model.length)) }
  requiresProjection(sessionID: string): boolean { if (this.disposed || this.closed.has(sessionID)) return false; return [...(this.states.get(sessionID)?.rows.values() ?? [])].some(row => row.model.length || !row.anchor && row.artifact) }
  discardPendingPrompt(session: SessionSnapshot, messageID: string): void {
    if (!snapshotID(messageID) || this.read(session).some(row => row.anchor?.turnID === messageID)) fail('SESSION_SNAPSHOT_PROMPT_RECONCILIATION_UNAVAILABLE')
  }
  acknowledgeWarnings(session: SessionSnapshot, ids: readonly string[]): void {
    const state = this.state(session); if (state?.binding) fail('BACKGROUND_BINDING_PENDING')
    if (new Set(ids).size !== ids.length || ids.some(id => !state?.receipts.has(id) || state.rows.has(id) && !state.rows.get(id)!.warnings.length)) fail('BACKGROUND_WARNING_OWNER_MISMATCH')
    for (const id of ids) {
      const row = state!.rows.get(id); if (!row || row.warningsDelivered) continue
      const previous = rowBytes(row)
      if (!row.artifact && !row.model.length) { state!.rows.delete(id); state!.bytes -= previous + 1 }
      else { row.warningsDelivered = true; state!.bytes += rowBytes(row) - previous }
      state!.revision++
    }
  }
  snapshotV1(sessionID: string): unknown {
    if (this.disposed || this.closed.has(sessionID) || !snapshotID(sessionID)) fail('BACKGROUND_SESSION_CLOSED')
    const state = this.states.get(sessionID)
    if (state?.binding && this.bindingScope.getStore() !== state.binding) fail('BACKGROUND_BINDING_PENDING')
    return this.copy({ kind: KIND, version: SESSION_SNAPSHOT_VERSION, sessionID, rows: [...(state?.rows.values() ?? [])].map(snapshotRow), receipts: [...(state?.receipts ?? [])].map(([id, hash]) => ({ id, hash })) })
  }
  async snapshotReady(session: SessionSnapshot, signal: AbortSignal): Promise<void> {
    let state = this.state(session)
    while (state?.binding && this.bindingScope.getStore() !== state.binding) {
      const done = state.bindingDone!.promise
      await runService(null, AbortSignal.any([session.signal, signal]), () => done)
      state = this.state(session)
    }
  }
  restoreV1(session: SessionSnapshot, value: unknown): () => void {
    if (this.state(session)) fail('SESSION_SNAPSHOT_STATE_CONFLICT')
    const input = sessionSnapshot(KIND, this.copy(value), session, ['rows', 'receipts'])
    const receiptSchema = z.array(z.object({ id: ID, hash: HASH }).strict()).max(this.maxRecords), rowSchema = z.array(z.object({ delivery: DELIVERY, anchor: ANCHOR.nullable(), warningsDelivered: z.boolean() }).strict()).max(this.maxRecords)
    const parsedReceipts = receiptSchema.safeParse(input.receipts), parsedRows = rowSchema.safeParse(input.rows)
    if (!parsedReceipts.success || !parsedRows.success) fail('SESSION_SNAPSHOT_SCHEMA_INVALID')
    const receipts = new Map<string, string>(), rows = new Map<string, Row>(); let bytes = headerBytes(session.sessionID)
    for (const item of parsedReceipts.data) { if (receipts.has(item.id)) fail('SESSION_SNAPSHOT_SCHEMA_INVALID'); receipts.set(item.id, item.hash); bytes += receiptBytes(item.id, item.hash) + 1 }
    for (const item of parsedRows.data) {
      const delivery = this.delivery(item.delivery), digest = hash(delivery)
      if (rows.has(delivery.id) || receipts.get(delivery.id) !== digest) fail('SESSION_SNAPSHOT_SCHEMA_INVALID')
      const row = this.row(delivery)
      if (!row.artifact && !row.model.length && !row.warnings.length || item.warningsDelivered && !row.warnings.length) fail('SESSION_SNAPSHOT_SCHEMA_INVALID')
      if (item.anchor) {
        if (item.anchor.sessionID !== session.sessionID || item.anchor.kind === 'prompt' && item.anchor.messageID !== item.anchor.turnID || item.anchor.kind === 'tool' && item.anchor.messageID === item.anchor.turnID) fail('SESSION_SNAPSHOT_OWNER_MISMATCH')
        row.anchor = freeze(item.anchor)
      }
      row.warningsDelivered = item.warningsDelivered; bytes += rowBytes(row) + 1; rows.set(delivery.id, row)
    }
    if (this.usedBytes() + bytes > this.maxBytes || this.receiptCount() + receipts.size > this.maxRecords) fail('BACKGROUND_RECORD_LIMIT')
    if (!receipts.size) return () => {}
    const state = this.create(session); for (const [id, receipt] of receipts) state.receipts.set(id, receipt); for (const [id, row] of rows) state.rows.set(id, row); state.bytes = bytes
    return () => { if (this.states.get(session.sessionID) !== state || state.revision !== 0) fail('BACKGROUND_STATE_CHANGED'); this.states.delete(session.sessionID) }
  }
  removeSession(sessionID: string): void { if (!snapshotID(sessionID)) fail('BACKGROUND_SESSION_CLOSED'); if (!this.closed.has(sessionID) && this.closed.size >= this.maxSessions) fail('BACKGROUND_RECORD_LIMIT'); const state = this.states.get(sessionID); this.states.delete(sessionID); this.closed.add(sessionID); state?.bindingDone?.resolve() }
  dispose(): void { this.disposed = true; for (const state of this.states.values()) state.bindingDone?.resolve(); this.states.clear(); this.authorized.clear(); this.authorizedBytes = 0; this.closed.clear(); this.bindingScope.disable() }
  inspect() { return Object.freeze({ sessions: this.states.size, records: [...this.states.values()].reduce((sum, state) => sum + state.rows.size, 0), receipts: this.receiptCount(), bytes: this.usedBytes(), pendingBindings: [...this.states.values()].filter(state => state.binding).length, closed: this.closed.size, disposed: this.disposed }) }
  private copy(value: unknown): unknown { return snapshotJsonObject({ value }, this.maxBytes, kind => fail(kind === 'size' ? 'BACKGROUND_RECORD_LIMIT' : 'BACKGROUND_DELIVERY_INVALID')).value.value }
  private delivery(value: unknown): Delivery {
    const parsed = DELIVERY.safeParse(this.copy(value)); if (!parsed.success) fail('BACKGROUND_DELIVERY_INVALID')
    if (Buffer.byteLength(parsed.data.completion.execution.stdout) + Buffer.byteLength(parsed.data.completion.execution.stderr) > EXECUTION_LIMITS.outputBytes) fail('BACKGROUND_RECORD_LIMIT')
    const { processID, ...execution } = parsed.data.completion.execution
    const { hookName, ...base } = parsed.data
    const actions = parsed.data.actions.map(action => { if (action.kind === 'warning') return action; const { channel, ...context } = action; return { ...context, ...(channel !== undefined ? { channel } : {}) } })
    return freeze({ ...base, ...(hookName !== undefined ? { hookName } : {}), actions, completion: { completedAt: parsed.data.completion.completedAt, execution: { ...execution, ...(processID !== undefined ? { processID } : {}) } } })
  }
  private row(delivery: Delivery): Row {
    if (delivery.dialect === 'claude-code' && delivery.actions.some(action => action.kind !== 'context')) fail('BACKGROUND_DELIVERY_INVALID')
    const artifact = delivery.dialect === 'claude-code' ? claudeBackgroundArtifact(delivery) : undefined
    return { delivery, ...(artifact ? { artifact } : {}), model: artifact?.model ?? Object.freeze(delivery.dialect === 'codex' ? delivery.actions.flatMap(action => action.kind === 'context' ? [action.text] : []) : []), warnings: Object.freeze(delivery.dialect === 'codex' ? delivery.actions.flatMap(action => action.kind === 'warning' ? [action.text] : []) : []), warningsDelivered: false }
  }
  private state(session: SessionSnapshot): State | undefined {
    if (this.disposed || session.signal.aborted || this.closed.has(session.sessionID) || !snapshotID(session.sessionID)) fail('BACKGROUND_SESSION_CLOSED')
    const state = this.states.get(session.sessionID); if (state && state.owner !== session.signal) fail('BACKGROUND_SESSION_OWNER_MISMATCH'); return state
  }
  private usedBytes(): number { return this.authorizedBytes + [...this.states.values()].reduce((sum, state) => sum + state.bytes, 0) }
  private receiptCount(): number { return [...this.states.values()].reduce((sum, state) => sum + state.receipts.size, 0) }
  private create(session: SessionSnapshot): State { const bytes = headerBytes(session.sessionID); if (this.states.size >= this.maxSessions || this.usedBytes() + bytes > this.maxBytes) fail('BACKGROUND_RECORD_LIMIT'); const state: State = { owner: session.signal, rows: new Map(), receipts: new Map(), bytes, revision: 0 }; this.states.set(session.sessionID, state); return state }
  private turn(session: SessionSnapshot): void { this.state(session); if (!snapshotID(session.turnID) || session.turnSignal.aborted) fail('BACKGROUND_TURN_UNAVAILABLE') }
}
