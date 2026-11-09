import { createHash } from 'node:crypto'
import type { SessionSnapshot } from '../sessions.js'
import type { JsonValue } from '../types.js'
import { HostHookError } from './tools.js'

const MAX_SESSIONS = 1024
const MAX_ENTRIES = 10000
const MAX_ID_BYTES = 4096
const MAX_BYTES = 32 * 1024 * 1024
export const V2_STOP_EVENT_TYPES = Object.freeze(['session.inbox.enqueued', 'session.inbox.delivered', 'session.inbox.cancelled', 'session.execution.started', 'session.execution.interrupted', 'session.execution.succeeded', 'session.execution.failed', 'session.step.started', 'session.step.streamed', 'session.step.ended', 'session.step.failed'] as const)
const TYPES = new Set<string>(V2_STOP_EVENT_TYPES)
const REASONS = new Set(['user', 'shutdown', 'superseded', 'inactivity'])
const INPUT_TYPES = new Set(['user', 'synthetic'])
const DELIVERIES = new Set(['steer', 'queue'])
interface Input { readonly type: 'user' | 'synthetic'; readonly textHash: string; phase: 'queued' | 'delivered' | 'cancelled' }
interface Owner { readonly snapshot: SessionSnapshot; readonly textHash: string }
export interface V2ObservedStep { readonly id: string; readonly agent: string; readonly model: Readonly<Record<string, JsonValue>>; readonly started: number; readonly inputID: string; readonly phase: 'started' | 'streamed' | 'ended' | 'failed'; readonly eventID?: string; readonly completed?: number; readonly finish?: string; readonly error?: Readonly<Record<string, JsonValue>> }
interface Execution { ownerID?: string; inputID?: string; step?: V2ObservedStep; stepBytes?: number }
interface State {
  readonly inputs: Map<string, Input>
  readonly owners: Map<string, Owner>
  readonly steps: Set<string>
  signal?: AbortSignal
  cleanup?: () => void
  closed?: boolean
  last?: { readonly seq: number; readonly hash: string }
  execution?: Execution
  bytes: number
}
export interface V2ExecutionInterruption { readonly owner: SessionSnapshot; readonly inputID: string; readonly inputType: Input['type']; readonly eventID: string; readonly created: number; readonly reason: 'user' | 'shutdown' | 'superseded' | 'inactivity'; readonly step?: V2ObservedStep }
function fail(code: string): never { throw new HostHookError(code, code === 'HOST_STOP_EVENT_CANCELLED' ? 'cancelled' : 'unsupported') }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function id(value: unknown): value is string { return typeof value === 'string' && !!value && !value.includes('\0') && Buffer.byteLength(value) <= MAX_ID_BYTES }
function freeze<T>(value: T): T { if (value !== null && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) } return value }
function capture(value: Record<string, unknown>): Readonly<Record<string, JsonValue>> { return freeze(JSON.parse(JSON.stringify(value)) as Record<string, JsonValue>) }
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
  private steps = 0
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
        this.inputs -= state.inputs.size; this.owners -= state.owners.size; this.steps -= state.steps.size; this.bytes -= state.bytes
        state.inputs.clear(); state.owners.clear(); state.steps.clear(); state.bytes = 0
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
      case 'session.step.started': {
        const execution = state.execution
        if (!id(data.assistantMessageID) || !id(data.agent) || !record(data.model) || !id(data.model.id) || !id(data.model.providerID) || data.model.variant !== undefined && (typeof data.model.variant !== 'string' || Buffer.byteLength(data.model.variant) > MAX_ID_BYTES) || typeof data.started !== 'number' || !Number.isSafeInteger(data.started) || data.started < 0) fail('HOST_STOP_EVENT_INVALID')
        if (!execution?.inputID || execution.step && ['started', 'streamed'].includes(execution.step.phase)) fail('HOST_STOP_EVENT_STEP_CHANGED')
        if (state.steps.has(data.assistantMessageID) || state.inputs.has(data.assistantMessageID)) fail('HOST_STOP_EVENT_STEP_REUSED')
        const step: V2ObservedStep = Object.freeze({ id: data.assistantMessageID, agent: data.agent, model: capture(data.model), started: data.started, inputID: execution.inputID, phase: 'started' })
        const bytes = Buffer.byteLength(JSON.stringify(step))
        if (this.steps >= MAX_ENTRIES || this.bytes + bytes > MAX_BYTES) fail('HOST_STOP_EVENT_LIMIT')
        state.steps.add(step.id); this.steps++; state.bytes += bytes; this.bytes += bytes
        execution.step = step; execution.stepBytes = bytes
        break
      }
      case 'session.step.streamed':
      case 'session.step.ended':
      case 'session.step.failed': {
        const execution = state.execution, step = execution?.step
        if (!id(data.assistantMessageID)) fail('HOST_STOP_EVENT_INVALID')
        if (!execution || !step || step.id !== data.assistantMessageID || !['started', 'streamed'].includes(step.phase) || raw.type === 'session.step.streamed' && step.phase !== 'started') fail('HOST_STOP_EVENT_STEP_CHANGED')
        if (raw.type === 'session.step.ended' && (typeof data.finish !== 'string' || !data.finish) || raw.type === 'session.step.failed' && (!record(data.error) || !id(data.error.type))) fail('HOST_STOP_EVENT_INVALID')
        const next: V2ObservedStep = Object.freeze({ ...step, phase: raw.type === 'session.step.streamed' ? 'streamed' : raw.type === 'session.step.ended' ? 'ended' : 'failed', ...(raw.type === 'session.step.streamed' ? {} : { eventID: raw.id, completed: raw.created }), ...(raw.type === 'session.step.ended' ? { finish: data.finish as string } : {}), ...(raw.type === 'session.step.failed' ? { error: capture(data.error as Record<string, unknown>) } : {}) })
        const bytes = Math.max(execution.stepBytes!, Buffer.byteLength(JSON.stringify(next))), extra = bytes - execution.stepBytes!
        if (this.bytes + extra > MAX_BYTES) fail('HOST_STOP_EVENT_LIMIT')
        state.bytes += extra; this.bytes += extra; execution.stepBytes = bytes; execution.step = next
        break
      }
      case 'session.execution.interrupted': {
        if (typeof data.reason !== 'string' || !REASONS.has(data.reason)) fail('HOST_STOP_EVENT_INVALID')
        const execution = state.execution
        if (!execution) fail('HOST_STOP_EVENT_EXECUTION_CHANGED')
        const owner = execution.ownerID ? state.owners.get(execution.ownerID) : undefined, input = execution.inputID ? state.inputs.get(execution.inputID) : undefined
        if (!owner || !input) fail('HOST_STOP_EVENT_OWNER_UNAVAILABLE')
        result = Object.freeze({ owner: owner.snapshot, inputID: execution.inputID!, inputType: input.type, eventID: raw.id, created: raw.created, reason: data.reason as V2ExecutionInterruption['reason'], ...(execution.step ? { step: execution.step } : {}) })
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

  inspect() { return Object.freeze({ sessions: this.states.size, inputs: this.inputs, owners: this.owners, steps: this.steps, bytes: this.bytes }) }
  dispose(): void { this.disposed = true; for (const state of this.states.values()) state.cleanup?.(); this.states.clear(); this.inputs = 0; this.owners = 0; this.steps = 0; this.bytes = 0 }
  private state(sessionID: string): State {
    let state = this.states.get(sessionID)
    if (!state) {
      if (this.states.size >= MAX_SESSIONS) fail('HOST_STOP_EVENT_LIMIT')
      state = { inputs: new Map(), owners: new Map(), steps: new Set(), bytes: 0 }
      this.states.set(sessionID, state)
    }
    return state
  }
}
