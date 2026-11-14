import type { BackgroundDelivery } from './background-types.js'
import { isBackground } from './background-types.js'
import type { ClaudeWakeText } from './claude-wake.js'
import { claudeWakeText } from './claude-wake.js'
import type { SessionSnapshot } from './sessions.js'
import type { Registration } from './types.js'
import { createHash, randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { z } from 'zod'
import { HostHookError } from './host-errors.js'
import { snapshotJsonObject } from './bounded-json.js'
import { EXECUTION_LIMITS } from './runner.js'
import { SESSION_SNAPSHOT_VERSION, sessionSnapshot, snapshotID } from './session-snapshot.js'
import { backgroundAnchor } from './background-records.js'
import type { BackgroundAnchor, BackgroundBinding } from './background-records.js'
import type { BackgroundArtifact } from './background-artifacts.js'
import { claudeQueuedWake, claudeSystemWake } from './claude-wake.js'
import { wakeAttempt, wakeAttemptResult } from './wake-attempts.js'
import type { WakeAttempt } from './wake-attempts.js'
import type { HostNotificationEvent } from './notification.js'
import type { DispatchResult } from './engine.js'
import { runService } from './service-execution.js'

export type WakePlacement = { readonly kind: 'queued'; readonly human: boolean } | { readonly kind: 'system'; readonly promptIndex: number; readonly turnIndex: number }
interface BindingInput { readonly attemptID: string; readonly anchor: BackgroundAnchor; readonly placement: WakePlacement }
export interface WakeAdmission extends BindingInput { readonly artifact: BackgroundArtifact; readonly model: readonly string[]; readonly developer: readonly string[] }
export interface WakeEntry { readonly delivery: BackgroundDelivery; readonly sourceUUID: string; readonly deliveryID: string; readonly text: ClaudeWakeText; readonly attempts: readonly WakeAttempt[]; readonly binding?: WakeAdmission }
interface Options { readonly registrations?: readonly Registration[]; readonly maxRecords?: number; readonly maxBytes?: number; readonly maxSessions?: number }
interface State { readonly owner: AbortSignal; readonly rows: Map<string, WakeEntry>; readonly receipts: Map<string, string>; bytes: number; revision: number; binding?: symbol; bindingDone?: { readonly promise: Promise<void>; readonly resolve: () => void } }
const KIND = 'wake-records-v1'
const MAX_RECORDS = 10000
const DEFAULT_BYTES = 8 * 1024 * 1024
const MAX_BYTES = 32 * 1024 * 1024
const MAX_SESSIONS = 1024
const DATE_LIMIT = 8640000000000000
const MAX_ATTEMPTS = 2
const RESERVATION = Object.freeze({ OPEN: 'open', COMMITTED: 'committed', RELEASED: 'released' } as const)
const DIGEST = /^[a-f0-9]{64}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ID = z.string().refine(snapshotID)
const HASH = z.string().regex(DIGEST)
const DELIVERY = z.object({
  id: ID, sourceID: ID, sourceDigest: HASH, registrationID: ID, dialect: z.literal('claude-code'), event: ID, hookName: ID.optional(), mode: z.literal('wake'),
  actions: z.tuple([z.object({ kind: z.literal('native-extension'), name: z.literal('asyncRewake'), value: z.string() }).strict()]),
  completion: z.object({ completedAt: z.number().int().nonnegative().max(DATE_LIMIT), execution: z.object({ status: z.literal('exited'), exitCode: z.literal(2), signal: z.null(), stdout: z.string(), stderr: z.string(), durationMs: z.number().finite().nonnegative(), processID: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict() }).strict(),
}).strict()
const PLACEMENT = z.discriminatedUnion('kind', [z.object({ kind: z.literal('queued'), human: z.boolean() }).strict(), z.object({ kind: z.literal('system'), promptIndex: z.number().int().nonnegative(), turnIndex: z.number().int().positive() }).strict()])
const BINDING = z.object({ attemptID: ID, anchor: z.unknown(), placement: PLACEMENT }).strict()
const ROW = z.object({ delivery: DELIVERY, sourceUUID: z.string().regex(UUID), deliveryID: z.string().regex(UUID), attempts: z.array(z.unknown()).max(MAX_ATTEMPTS), binding: BINDING.nullable() }).strict()
type Delivery = Omit<z.infer<typeof DELIVERY>, 'hookName'> & { readonly hookName?: string }
function fail(code: string): never { throw new HostHookError(code, code === 'WAKE_SESSION_CLOSED' ? 'cancelled' : 'unsupported') }
function freeze<T>(value: T): T { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) }; return value }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key])).join(',') + '}'
  return JSON.stringify(value) ?? fail('WAKE_DELIVERY_INVALID')
}
function hash(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex') }
function sourceKey(value: { readonly sourceID: string; readonly sourceDigest?: string; readonly registrationID?: string; readonly id?: string; readonly dialect: string; readonly event: string }): string { return JSON.stringify([value.sourceID, value.sourceDigest, value.registrationID ?? value.id, value.dialect, value.event]) }
function snapshotRow(row: WakeEntry) { return { delivery: row.delivery, sourceUUID: row.sourceUUID, deliveryID: row.deliveryID, attempts: row.attempts, binding: row.binding ? { attemptID: row.binding.attemptID, anchor: row.binding.anchor, placement: row.binding.placement } : null } }
function fingerprint(sessionID: string, row: WakeEntry): string { return hash({ sessionID, ...snapshotRow(row) }) }
function rowBytes(row: WakeEntry): number { return Buffer.byteLength(JSON.stringify(row)) + 1 }
function receiptBytes(id: string, hash: string): number { return Buffer.byteLength(JSON.stringify({ id, hash })) + 1 }
function headerBytes(sessionID: string): number { return Buffer.byteLength(JSON.stringify({ value: { kind: KIND, version: SESSION_SNAPSHOT_VERSION, sessionID, rows: [], receipts: [] } })) }

export class WakeRecords {
  private readonly states = new Map<string, State>()
  private readonly authorized = new Map<string, string>()
  private readonly closed = new Set<string>()
  private readonly bindingScope = new AsyncLocalStorage<symbol>()
  private readonly maxRecords: number
  private readonly maxBytes: number
  private readonly maxSessions: number
  private authorityBytes = 0
  private closedBytes = 0
  private disposed = false
  constructor(options: Options = {}) {
    this.maxRecords = options.maxRecords ?? MAX_RECORDS; this.maxBytes = options.maxBytes ?? DEFAULT_BYTES; this.maxSessions = options.maxSessions ?? MAX_SESSIONS
    if (!Number.isSafeInteger(this.maxRecords) || this.maxRecords < 1 || this.maxRecords > MAX_RECORDS || !Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1 || this.maxBytes > MAX_BYTES || !Number.isSafeInteger(this.maxSessions) || this.maxSessions < 1 || this.maxSessions > MAX_SESSIONS) fail('WAKE_RECORD_LIMIT_INVALID')
    this.configure(options.registrations ?? [])
  }
  configure(registrations: readonly Registration[]): void {
    if (this.disposed) fail('WAKE_SESSION_CLOSED')
    if (registrations.length > MAX_RECORDS) fail('WAKE_RECORD_LIMIT')
    const next = new Map<string, string>(); let bytes = 0
    for (const input of registrations) {
      const value = snapshotJsonObject(input, EXECUTION_LIMITS.inputBytes, () => fail('WAKE_SOURCE_INVALID')).value as unknown as Registration
      if (!snapshotID(value.id) || !snapshotID(value.sourceID) || !value.sourceDigest || !DIGEST.test(value.sourceDigest) || value.dialect !== 'claude-code' || !isBackground(value) || value.handler.asyncRewake !== true) fail('WAKE_SOURCE_INVALID')
      const id = sourceKey(value), digest = hash(value); if (next.has(id)) fail('WAKE_SOURCE_INVALID')
      next.set(id, digest); bytes += Buffer.byteLength(id) + digest.length
    }
    if (this.usedBytes() - this.authorityBytes + bytes > this.maxBytes) fail('WAKE_RECORD_LIMIT')
    this.authorized.clear(); for (const [id, digest] of next) this.authorized.set(id, digest); this.authorityBytes = bytes
  }
  assertRegistration(input: Registration): void {
    if (this.disposed) fail('WAKE_SESSION_CLOSED')
    const value = snapshotJsonObject(input, EXECUTION_LIMITS.inputBytes, () => fail('WAKE_SOURCE_INVALID')).value
    if (this.authorized.get(sourceKey(input)) !== hash(value)) fail('WAKE_SOURCE_UNAVAILABLE')
  }
  admit(session: SessionSnapshot, input: BackgroundDelivery): boolean {
    const current = this.state(session), delivery = this.delivery(input), previous = current?.rows.get(delivery.id)
    if (current?.binding) fail('WAKE_BINDING_PENDING')
    if (previous) { if (hash(previous.delivery) !== hash(delivery)) fail('WAKE_DELIVERY_REUSED'); return false }
    if (!this.authorized.has(sourceKey(delivery))) fail('WAKE_SOURCE_UNAVAILABLE')
    const row = this.entry(delivery, randomUUID(), randomUUID()), digest = fingerprint(session.sessionID, row)
    this.unique(row, this.identities())
    const bytes = rowBytes(row) + receiptBytes(delivery.id, digest), header = current ? 0 : headerBytes(session.sessionID)
    if (this.receiptCount() >= this.maxRecords || this.usedBytes() + bytes + header > this.maxBytes) fail('WAKE_RECORD_LIMIT')
    const state = current ?? this.create(session); state.rows.set(delivery.id, row); state.receipts.set(delivery.id, digest); state.bytes += bytes; state.revision++
    return true
  }
  begin(session: SessionSnapshot, jobID: string, input: BackgroundAnchor): WakeAttempt {
    const state = this.state(session), previous = state?.rows.get(jobID)
    if (!state || !previous) fail('WAKE_DELIVERY_UNAVAILABLE')
    if (state.binding) fail('WAKE_BINDING_PENDING')
    const anchor = this.anchor(session, input), last = previous.attempts.at(-1)
    if (previous.binding || previous.attempts.length >= MAX_ATTEMPTS || last && !(last.result?.outcome === 'stop' && last.anchor.kind === 'tool' && anchor.kind === 'prompt' && last.promptID !== anchor.turnID)) fail('WAKE_ATTEMPT_UNRESOLVED')
    if (anchor.kind === 'prompt' && anchor.signature !== createHash('sha256').update(JSON.stringify([previous.text.prompt])).digest('hex')) fail('WAKE_ATTEMPT_OWNER_MISMATCH')
    const attempt = wakeAttempt({ id: randomUUID(), promptID: session.turnID, created: Date.now(), anchor, result: null }, session.sessionID)
    this.replace(session.sessionID, state, previous, freeze({ ...previous, attempts: [...previous.attempts, attempt] }))
    return attempt
  }
  capture(session: SessionSnapshot, event: HostNotificationEvent, dispatch: DispatchResult): boolean {
    const state = this.state(session), previous = [...(state?.rows.values() ?? [])].find(row => row.attempts.some(attempt => attempt.id === event.notificationID))
    if (!state || !previous || event.sessionID !== session.sessionID || event.prompt !== previous.text.prompt) fail('WAKE_ATTEMPT_OWNER_MISMATCH')
    if (state.binding) fail('WAKE_BINDING_PENDING')
    const attempt = previous.attempts.find(attempt => attempt.id === event.notificationID)!
    if (event.messageID !== attempt.promptID || hash(event.anchor) !== hash(attempt.anchor)) fail('WAKE_ATTEMPT_OWNER_MISMATCH')
    const copied = this.copy(dispatch, 'WAKE_DISPATCH_INVALID') as DispatchResult, digest = hash(copied)
    if (attempt.result) { if (attempt.result.dispatchHash !== digest) fail('WAKE_ATTEMPT_REUSED'); return false }
    const result = wakeAttemptResult(event, copied, digest)
    this.replace(session.sessionID, state, previous, freeze({ ...previous, attempts: previous.attempts.map(value => value === attempt ? { ...attempt, result } : value) }))
    return true
  }
  reserveBind(session: SessionSnapshot, jobID: string, attemptID: string, input: BackgroundAnchor, placement: WakePlacement = { kind: 'queued', human: false }): BackgroundBinding {
    const state = this.state(session), previous = state?.rows.get(jobID)
    if (!state || !previous) fail('WAKE_DELIVERY_UNAVAILABLE')
    if (state.binding) fail('WAKE_BINDING_PENDING')
    const anchor = this.anchor(session, input), attempt = previous.attempts.find(attempt => attempt.id === attemptID)
    if (!attempt?.result || attempt.result.outcome !== 'allow') fail('WAKE_NOTIFICATION_NOT_ADMITTED')
    if (previous.binding || hash(attempt.anchor) !== hash(anchor)) fail('WAKE_BINDING_OWNER_MISMATCH')
    const row = this.entry(this.delivery(previous.delivery), previous.sourceUUID, previous.deliveryID, session.sessionID, previous.attempts, { attemptID, anchor, placement })
    this.replace(session.sessionID, state, previous, row)
    const token = Symbol(); let resolve!: () => void, status: typeof RESERVATION[keyof typeof RESERVATION] = RESERVATION.OPEN
    state.binding = token; state.bindingDone = { promise: new Promise<void>(done => { resolve = done }), resolve: () => resolve() }
    const close = () => { delete state.binding; state.bindingDone!.resolve(); delete state.bindingDone; state.revision++ }
    return Object.freeze({
      persist: <T>(operation: () => Promise<T>) => { if (status !== RESERVATION.OPEN || this.state(session) !== state || state.binding !== token) fail('WAKE_BINDING_STALE'); return this.bindingScope.run(token, operation) },
      commit: () => { if (status === RESERVATION.COMMITTED) return; if (status !== RESERVATION.OPEN || this.state(session) !== state || state.binding !== token || session.turnSignal.aborted) fail('WAKE_BINDING_STALE'); status = RESERVATION.COMMITTED; close() },
      release: () => { if (status !== RESERVATION.OPEN) return; status = RESERVATION.RELEASED; if (this.states.get(session.sessionID) !== state || state.binding !== token) return; this.replace(session.sessionID, state, row, previous); close() },
    })
  }
  read(session: SessionSnapshot): readonly WakeEntry[] { const state = this.state(session); if (state?.binding) fail('WAKE_BINDING_PENDING'); return Object.freeze([...(state?.rows.values() ?? [])]) }
  snapshotV1(sessionID: string): unknown {
    if (this.disposed || this.closed.has(sessionID) || !snapshotID(sessionID)) fail('WAKE_SESSION_CLOSED')
    const state = this.states.get(sessionID); if (state?.owner.aborted) fail('WAKE_SESSION_CLOSED')
    if (state?.binding && this.bindingScope.getStore() !== state.binding) fail('WAKE_BINDING_PENDING')
    return this.copy({ kind: KIND, version: SESSION_SNAPSHOT_VERSION, sessionID, rows: [...(state?.rows.values() ?? [])].map(snapshotRow), receipts: [...(state?.receipts ?? [])].map(([id, hash]) => ({ id, hash })) })
  }
  async snapshotReady(session: SessionSnapshot, signal: AbortSignal): Promise<void> {
    let state = this.state(session)
    while (state?.binding && this.bindingScope.getStore() !== state.binding) { await runService(null, AbortSignal.any([session.signal, signal]), () => state!.bindingDone!.promise); state = this.state(session) }
  }
  restoreV1(session: SessionSnapshot, value: unknown): () => void {
    if (this.state(session)) fail('WAKE_STATE_CONFLICT')
    const input = sessionSnapshot(KIND, this.copy(value), session, ['rows', 'receipts'])
    const parsedRows = z.array(ROW).max(this.maxRecords).safeParse(input.rows), parsedReceipts = z.array(z.object({ id: ID, hash: HASH }).strict()).max(this.maxRecords).safeParse(input.receipts)
    if (!parsedRows.success || !parsedReceipts.success || parsedRows.data.length !== parsedReceipts.data.length) fail('SESSION_SNAPSHOT_SCHEMA_INVALID')
    const rows = new Map<string, WakeEntry>(), receipts = new Map<string, string>(), identities = this.identities(); let bytes = headerBytes(session.sessionID)
    for (const receipt of parsedReceipts.data) { if (receipts.has(receipt.id)) fail('SESSION_SNAPSHOT_SCHEMA_INVALID'); receipts.set(receipt.id, receipt.hash); bytes += receiptBytes(receipt.id, receipt.hash) }
    for (const item of parsedRows.data) {
      const row = this.entry(this.delivery(item.delivery), item.sourceUUID, item.deliveryID, session.sessionID, item.attempts, item.binding ?? undefined)
      if (rows.has(row.delivery.id) || receipts.get(row.delivery.id) !== fingerprint(session.sessionID, row)) fail('SESSION_SNAPSHOT_SCHEMA_INVALID')
      this.unique(row, identities); rows.set(row.delivery.id, row); bytes += rowBytes(row)
    }
    if (!rows.size) return () => {}
    if (this.receiptCount() + receipts.size > this.maxRecords || this.usedBytes() + bytes > this.maxBytes) fail('WAKE_RECORD_LIMIT')
    const state = this.create(session); for (const [id, row] of rows) state.rows.set(id, row); for (const [id, digest] of receipts) state.receipts.set(id, digest); state.bytes = bytes
    return () => { if (this.states.get(session.sessionID) !== state || state.revision !== 0) fail('WAKE_STATE_CHANGED'); this.states.delete(session.sessionID) }
  }
  removeSession(sessionID: string): void {
    if (!snapshotID(sessionID) || this.disposed) fail('WAKE_SESSION_CLOSED')
    if (this.closed.has(sessionID)) return
    const state = this.states.get(sessionID), bytes = Buffer.byteLength(JSON.stringify(sessionID)) + 1
    if ((!state && this.states.size + this.closed.size >= this.maxSessions) || this.usedBytes() - (state?.bytes ?? 0) + bytes > this.maxBytes) fail('WAKE_RECORD_LIMIT')
    state?.bindingDone?.resolve(); this.states.delete(sessionID); this.closed.add(sessionID); this.closedBytes += bytes
  }
  dispose(): void { this.disposed = true; for (const state of this.states.values()) state.bindingDone?.resolve(); this.states.clear(); this.authorized.clear(); this.closed.clear(); this.authorityBytes = 0; this.closedBytes = 0 }
  inspect() { return Object.freeze({ sessions: this.states.size, records: [...this.states.values()].reduce((sum, state) => sum + state.rows.size, 0), receipts: this.receiptCount(), bytes: this.usedBytes(), closed: this.closed.size, disposed: this.disposed }) }
  private copy(value: unknown, invalid = 'WAKE_DELIVERY_INVALID'): unknown { return snapshotJsonObject({ value }, this.maxBytes, kind => fail(kind === 'size' ? 'WAKE_RECORD_LIMIT' : invalid)).value.value }
  private delivery(value: unknown): Delivery {
    const parsed = DELIVERY.safeParse(this.copy(value)); if (!parsed.success) fail('WAKE_DELIVERY_INVALID')
    const execution = parsed.data.completion.execution
    if (Buffer.byteLength(execution.stdout) + Buffer.byteLength(execution.stderr) > EXECUTION_LIMITS.outputBytes || parsed.data.actions[0].value !== (execution.stderr.trim() ? execution.stderr : execution.stdout)) fail('WAKE_DELIVERY_INVALID')
    const { hookName, ...base } = parsed.data
    return freeze({ ...base, ...(hookName !== undefined ? { hookName } : {}) })
  }
  private entry(delivery: Delivery, sourceUUID: string, deliveryID: string, sessionID?: string, inputs: readonly unknown[] = [], bindingInput?: unknown): WakeEntry {
    const text = claudeWakeText({ hookName: delivery.hookName ?? delivery.event, text: delivery.actions[0].value }), attempts = inputs.map(value => wakeAttempt(value, sessionID!))
    if (attempts.length > MAX_ATTEMPTS || attempts.length === MAX_ATTEMPTS && !(attempts[0]!.result?.outcome === 'stop' && attempts[0]!.anchor.kind === 'tool' && attempts[1]!.anchor.kind === 'prompt' && attempts[0]!.promptID !== attempts[1]!.promptID)) fail('SESSION_SNAPSHOT_SCHEMA_INVALID')
    let binding: WakeAdmission | undefined
    if (bindingInput !== undefined) {
      const parsed = BINDING.safeParse(bindingInput); if (!parsed.success) fail('SESSION_SNAPSHOT_SCHEMA_INVALID')
      const value = parsed.data, anchor = backgroundAnchor(value.anchor), attempt = attempts.find(attempt => attempt.id === value.attemptID)
      if (!attempt?.result || attempt.result.outcome !== 'allow' || hash(attempt.anchor) !== hash(anchor)) fail('WAKE_BINDING_OWNER_MISMATCH')
      const placement = value.placement, input = { hookName: delivery.hookName ?? delivery.event, text: delivery.actions[0].value }
      let artifact: BackgroundArtifact
      if (placement.kind === 'queued') {
        if (placement.human !== (anchor.kind === 'prompt')) fail('WAKE_BINDING_OWNER_MISMATCH')
        const queued = claudeQueuedWake({ ...input, sourceUUID, deliveryID, created: attempt.created })
        artifact = { ...queued, model: placement.human ? queued.humanModel : queued.model }
      } else {
        if (anchor.kind !== 'prompt') fail('WAKE_BINDING_OWNER_MISMATCH')
        artifact = { created: attempt.created, body: claudeSystemWake({ ...input, promptID: attempt.promptID, promptIndex: placement.promptIndex, turnIndex: placement.turnIndex }), model: [text.model] }
      }
      const model = [...artifact.model, ...attempt.result.attachments.flatMap(row => { const rendered = row.body.rendered; return Array.isArray(rendered) ? rendered.map(value => (value as { readonly content: string }).content) : [] })]
      binding = { attemptID: attempt.id, anchor, placement, artifact, model, developer: attempt.result.developer }
    }
    return freeze({ delivery, sourceUUID, deliveryID, text, attempts, ...(binding ? { binding } : {}) })
  }
  private unique(row: WakeEntry, identities: Set<string>): void {
    for (const id of this.rowIdentities(row)) { if (identities.has(id)) fail('WAKE_IDENTITY_REUSED'); identities.add(id) }
  }
  private rowIdentities(row: WakeEntry): readonly string[] { return [row.sourceUUID, row.deliveryID, ...row.attempts.flatMap(attempt => [attempt.id, ...(attempt.result?.attachments.map(row => row.id) ?? [])])] }
  private identities(except?: WakeEntry): Set<string> { return new Set([...this.states.values()].flatMap(state => [...state.rows.values()].filter(row => row !== except).flatMap(row => this.rowIdentities(row)))) }
  private replace(sessionID: string, state: State, previous: WakeEntry, row: WakeEntry): void {
    this.unique(row, this.identities(previous))
    const delta = rowBytes(row) - rowBytes(previous)
    if (this.usedBytes() + delta > this.maxBytes) fail('WAKE_RECORD_LIMIT')
    state.rows.set(row.delivery.id, row); state.receipts.set(row.delivery.id, fingerprint(sessionID, row)); state.bytes += delta; state.revision++
  }
  private anchor(session: SessionSnapshot, input: BackgroundAnchor): BackgroundAnchor {
    const anchor = backgroundAnchor(this.copy(input))
    if (!session.turnID || session.turnSignal.aborted || anchor.sessionID !== session.sessionID || anchor.turnID !== session.turnID || (anchor.kind === 'prompt' ? anchor.messageID !== session.turnID : anchor.messageID === session.turnID)) fail('WAKE_ATTEMPT_OWNER_MISMATCH')
    return anchor
  }
  private state(session: SessionSnapshot): State | undefined {
    if (this.disposed || session.signal.aborted || !snapshotID(session.sessionID) || this.closed.has(session.sessionID)) fail('WAKE_SESSION_CLOSED')
    const state = this.states.get(session.sessionID); if (state && state.owner !== session.signal) fail('WAKE_OWNER_MISMATCH'); return state
  }
  private create(session: SessionSnapshot): State {
    if (this.states.size + this.closed.size >= this.maxSessions) fail('WAKE_RECORD_LIMIT')
    const state: State = { owner: session.signal, rows: new Map(), receipts: new Map(), bytes: headerBytes(session.sessionID), revision: 0 }; this.states.set(session.sessionID, state); return state
  }
  private usedBytes(): number { return this.authorityBytes + this.closedBytes + [...this.states.values()].reduce((sum, state) => sum + state.bytes, 0) }
  private receiptCount(): number { return [...this.states.values()].reduce((sum, state) => sum + state.receipts.size, 0) }
}
