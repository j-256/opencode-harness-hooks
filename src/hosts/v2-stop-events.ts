import { createHash } from 'node:crypto'
import type { SessionSnapshot } from '../sessions.js'
import { HostHookError } from './tools.js'

const MAX_SESSIONS = 1024
const MAX_ENTRIES = 10000
const MAX_ID_BYTES = 4096
const MAX_BYTES = 32 * 1024 * 1024
export const V2_STOP_EVENT_TYPES = Object.freeze(['session.inbox.enqueued', 'session.inbox.delivered', 'session.inbox.cancelled', 'session.execution.started', 'session.execution.interrupted', 'session.execution.succeeded', 'session.execution.failed'] as const)
const TYPES = new Set<string>(V2_STOP_EVENT_TYPES)
const REASONS = new Set(['user', 'shutdown', 'superseded', 'inactivity'])
const INPUT_TYPES = new Set(['user', 'synthetic'])
const DELIVERIES = new Set(['steer', 'queue'])
interface Input { readonly type: 'user' | 'synthetic'; readonly textHash: string; phase: 'queued' | 'delivered' | 'cancelled' }
interface Owner { readonly snapshot: SessionSnapshot; readonly textHash: string }
interface Execution { ownerID?: string; inputID?: string }
interface State {
  readonly inputs: Map<string, Input>
  readonly owners: Map<string, Owner>
  signal?: AbortSignal
  cleanup?: () => void
  closed?: boolean
  last?: { readonly seq: number; readonly hash: string }
  execution?: Execution
  bytes: number
}
export interface V2ExecutionInterruption { readonly owner: SessionSnapshot; readonly inputID: string; readonly inputType: Input['type']; readonly eventID: string; readonly created: number; readonly reason: 'user' | 'shutdown' | 'superseded' | 'inactivity' }
function fail(code: string): never { throw new HostHookError(code, code === 'HOST_STOP_EVENT_CANCELLED' ? 'cancelled' : 'unsupported') }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function id(value: unknown): value is string { return typeof value === 'string' && !!value && !value.includes('\0') && Buffer.byteLength(value) <= MAX_ID_BYTES }
function hash(value: unknown): string {
  try {
    const text = JSON.stringify(value, (_key, item: unknown) => record(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)
    if (text === undefined || Buffer.byteLength(text) > MAX_BYTES) fail('HOST_STOP_EVENT_LIMIT')
    return createHash('sha256').update(text).digest('hex')
  } catch (error) { if (error instanceof HostHookError) throw error; return fail('HOST_STOP_EVENT_INVALID') }
}

export class V2StopEvents {
  private readonly states = new Map<string, State>()
  private inputs = 0
  private owners = 0
  private bytes = 0
  private disposed = false

  accept(owner: SessionSnapshot, text: string): void {
    owner = Object.freeze({ ...owner })
    if (this.disposed || owner.signal.aborted || owner.turnSignal.aborted) fail('HOST_STOP_EVENT_CANCELLED')
    if (!id(owner.sessionID) || !id(owner.turnID) || typeof text !== 'string') fail('HOST_STOP_EVENT_INVALID')
    const state = this.state(owner.sessionID), textHash = hash(text), previous = state.owners.get(owner.turnID), input = state.inputs.get(owner.turnID)
    if (state.closed || state.signal && state.signal !== owner.signal || previous && (previous.snapshot.turnSignal !== owner.turnSignal || previous.textHash !== textHash) || input && (input.type !== 'user' || input.textHash !== textHash)) fail('HOST_STOP_EVENT_OWNER_CHANGED')
    if (previous) return
    const bytes = Buffer.byteLength(JSON.stringify([owner.sessionID, owner.turnID, textHash]))
    if (this.owners >= MAX_ENTRIES || this.bytes + bytes > MAX_BYTES) fail('HOST_STOP_EVENT_LIMIT')
    if (!state.signal) {
      state.signal = owner.signal
      const cleanup = () => {
        if (state.closed) return
        state.closed = true
        this.inputs -= state.inputs.size; this.owners -= state.owners.size; this.bytes -= state.bytes
        state.inputs.clear(); state.owners.clear(); state.bytes = 0
        delete state.execution; delete state.last
        owner.signal.removeEventListener('abort', cleanup)
      }
      state.cleanup = cleanup
      owner.signal.addEventListener('abort', cleanup, { once: true })
    }
    state.owners.set(owner.turnID, { snapshot: owner, textHash })
    state.bytes += bytes; this.bytes += bytes; this.owners++
  }

  event(raw: unknown): V2ExecutionInterruption | undefined {
    if (this.disposed) fail('HOST_STOP_EVENT_CANCELLED')
    if (!record(raw) || !id(raw.id) || typeof raw.created !== 'number' || !Number.isFinite(raw.created) || Number.isNaN(new Date(raw.created).getTime()) || typeof raw.type !== 'string' || !TYPES.has(raw.type) || !record(raw.data) || !id(raw.data.sessionID) || !record(raw.durable) || raw.durable.aggregateID !== raw.data.sessionID || raw.durable.version !== 1 || typeof raw.durable.seq !== 'number' || !Number.isSafeInteger(raw.durable.seq) || raw.durable.seq < 1) fail('HOST_STOP_EVENT_INVALID')
    const state = this.state(raw.data.sessionID)
    if (state.closed) return
    const fingerprint = hash(raw), seq = raw.durable.seq, data = raw.data
    if (state.last && seq <= state.last.seq) {
      if (seq === state.last.seq && fingerprint === state.last.hash) return
      fail('HOST_STOP_EVENT_ORDER_INVALID')
    }
    let result: V2ExecutionInterruption | undefined
    switch (raw.type) {
      case 'session.inbox.enqueued': {
        if (!id(data.inboxID) || !record(data.item) || typeof data.item.type !== 'string' || !INPUT_TYPES.has(data.item.type) || typeof data.item.delivery !== 'string' || !DELIVERIES.has(data.item.delivery) || !record(data.item.payload) || typeof data.item.payload.text !== 'string') fail('HOST_STOP_EVENT_INVALID')
        if (state.inputs.has(data.inboxID)) fail('HOST_STOP_EVENT_INPUT_REUSED')
        const type = data.item.type as Input['type'], textHash = hash(data.item.payload.text), owner = state.owners.get(data.inboxID)
        if (owner && (type !== 'user' || owner.textHash !== textHash)) fail('HOST_STOP_EVENT_OWNER_CHANGED')
        const bytes = Buffer.byteLength(JSON.stringify([raw.data.sessionID, data.inboxID, type, textHash]))
        if (this.inputs >= MAX_ENTRIES || this.bytes + bytes > MAX_BYTES) fail('HOST_STOP_EVENT_LIMIT')
        state.inputs.set(data.inboxID, { type, textHash, phase: 'queued' })
        state.bytes += bytes; this.bytes += bytes; this.inputs++
        break
      }
      case 'session.inbox.delivered': {
        if (!id(data.inboxID)) fail('HOST_STOP_EVENT_INVALID')
        const input = state.inputs.get(data.inboxID), execution = state.execution
        if (!input || input.phase !== 'queued') fail('HOST_STOP_EVENT_INPUT_UNAVAILABLE')
        if (!execution) fail('HOST_STOP_EVENT_EXECUTION_CHANGED')
        input.phase = 'delivered'
        execution.inputID = data.inboxID
        if (input.type === 'user') execution.ownerID = data.inboxID
        break
      }
      case 'session.inbox.cancelled': {
        if (!id(data.inboxID)) fail('HOST_STOP_EVENT_INVALID')
        const input = state.inputs.get(data.inboxID)
        if (!input || input.phase !== 'queued') fail('HOST_STOP_EVENT_INPUT_UNAVAILABLE')
        input.phase = 'cancelled'
        break
      }
      case 'session.execution.started':
        if (state.execution) fail('HOST_STOP_EVENT_EXECUTION_CHANGED')
        state.execution = {}
        break
      case 'session.execution.interrupted': {
        if (typeof data.reason !== 'string' || !REASONS.has(data.reason)) fail('HOST_STOP_EVENT_INVALID')
        const execution = state.execution
        if (!execution) fail('HOST_STOP_EVENT_EXECUTION_CHANGED')
        const owner = execution.ownerID ? state.owners.get(execution.ownerID) : undefined, input = execution.inputID ? state.inputs.get(execution.inputID) : undefined
        if (!owner || !input) fail('HOST_STOP_EVENT_OWNER_UNAVAILABLE')
        result = Object.freeze({ owner: owner.snapshot, inputID: execution.inputID!, inputType: input.type, eventID: raw.id, created: raw.created, reason: data.reason as V2ExecutionInterruption['reason'] })
        delete state.execution
        break
      }
      case 'session.execution.succeeded':
      case 'session.execution.failed':
        if (!state.execution) fail('HOST_STOP_EVENT_EXECUTION_CHANGED')
        delete state.execution
        break
    }
    state.last = { seq, hash: fingerprint }
    return result
  }

  inspect() { return Object.freeze({ sessions: this.states.size, inputs: this.inputs, owners: this.owners, bytes: this.bytes }) }
  dispose(): void { this.disposed = true; for (const state of this.states.values()) state.cleanup?.(); this.states.clear(); this.inputs = 0; this.owners = 0; this.bytes = 0 }
  private state(sessionID: string): State {
    let state = this.states.get(sessionID)
    if (!state) {
      if (this.states.size >= MAX_SESSIONS) fail('HOST_STOP_EVENT_LIMIT')
      state = { inputs: new Map(), owners: new Map(), bytes: 0 }
      this.states.set(sessionID, state)
    }
    return state
  }
}
