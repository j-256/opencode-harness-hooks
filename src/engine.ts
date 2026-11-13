import { randomUUID } from 'node:crypto'
import { setMaxListeners } from 'node:events'
import { performance } from 'node:perf_hooks'
import type { Dialect } from './contracts.js'
import type { HookAction, PermissionDecision } from './effect-types.js'
import { executeRegistration } from './handlers.js'
import type { HandlerResult } from './handlers.js'
import type { HostServices } from './host-services.js'
import { snapshotCommandContexts } from './host-services.js'
import { MatcherError, selectRegistrations } from './matchers.js'
import { eventForDialect } from './native-event.js'
import type { LoadedSource, NativeEvent, Registration } from './types.js'

const CLAUDE_MODEL_CONCURRENCY = 12
const PERMISSION_PRIORITY: Readonly<Record<PermissionDecision, number>> = Object.freeze({ allow: 0, ask: 1, defer: 2, deny: 3 })

export interface DispatchOrigin {
  readonly sourceID: string
  readonly sourceDigest: string
  readonly registrationID: string
  readonly dialect: Dialect
  readonly configuredOrder: number
  readonly completionOrder: number
}
export interface DispatchEntry extends DispatchOrigin {
  readonly result: HandlerResult
}
export interface AttributedAction<T extends HookAction = HookAction> extends DispatchOrigin {
  readonly action: T
}
export interface DispatchResult {
  readonly entries: readonly DispatchEntry[]
  readonly actions: readonly AttributedAction[]
  readonly permission?: AttributedAction<Extract<HookAction, { kind: 'permission' }>>
  readonly cancelled: boolean
  readonly diagnostic: {
    readonly dispatchID: string
    readonly sessionID: string
    readonly event: string
    readonly durationMs: number
    readonly cancelled: boolean
    readonly failed: number
    readonly unsupported: number
    readonly skipped: number
    readonly background: number
    readonly handlers: readonly (DispatchOrigin & HandlerResult['diagnostic'])[]
  }
}

class ModelSlots {
  private active = 0
  private readonly waiting: (() => void)[] = []

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.active < CLAUDE_MODEL_CONCURRENCY) this.active++
    else await new Promise<void>(resolve => this.waiting.push(resolve))
    try { return await operation() } finally {
      const next = this.waiting.shift()
      if (next) next()
      else this.active--
    }
  }
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(freeze)
    Object.freeze(value)
  }
  return value
}

function matcherFailure(registration: Registration, code: string): HandlerResult {
  return { status: 'failed', code, actions: [], diagnostic: { sourceID: registration.sourceID, ...(registration.sourceDigest ? { sourceDigest: registration.sourceDigest } : {}), registrationID: registration.id, dialect: registration.dialect, event: registration.event, code, durationMs: 0, outcome: 'failed' } }
}

export async function dispatchEvent(inputSources: readonly LoadedSource[], inputEvent: NativeEvent, services: HostServices): Promise<DispatchResult> {
  const started = performance.now()
  const dispatchID = randomUUID()
  const sources = structuredClone(inputSources)
  const event = structuredClone(inputEvent)
  const parent = services.signal
  const controller = new AbortController()
  const host = snapshotCommandContexts({ ...services, environment: { ...services.environment }, signal: controller.signal })
  // This private signal deliberately fans out to every independently configured handler
  setMaxListeners(0, controller.signal)
  const abort = () => controller.abort()
  parent?.addEventListener('abort', abort, { once: true })
  if (parent?.aborted) abort()
  const slots = new ModelSlots()
  const pending: Promise<DispatchEntry>[] = []
  let completed = 0
  try {
    for (const source of sources) {
      if (!source.enabled) continue
      const nativeEvent = eventForDialect(event, source.dialect)
      for (const original of source.registrations) {
        if (original.event !== nativeEvent.event) continue
        const registration = { ...original, sourceDigest: source.digest }
        let failure: HandlerResult | undefined
        try {
          if (!selectRegistrations([{ ...source, registrations: [registration] }], nativeEvent).length) continue
        } catch (error) {
          failure = matcherFailure(registration, error instanceof MatcherError ? 'MATCHER_INVALID' : 'MATCHER_FAILED')
        }
        const configuredOrder = pending.length
        const selectedFailure = failure
        const run = async (): Promise<DispatchEntry> => {
          const result = selectedFailure ?? await executeRegistration(registration, nativeEvent, host)
          return { sourceID: source.id, sourceDigest: source.digest, registrationID: registration.id, dialect: registration.dialect, configuredOrder, completionOrder: completed++, result }
        }
        const limited = registration.dialect === 'claude-code' && (registration.handler.type === 'prompt' || registration.handler.type === 'agent')
        pending.push(limited ? slots.run(run) : run())
      }
    }
    const entries = await Promise.all(pending)
    const cancelled = controller.signal.aborted
    const actions: AttributedAction[] = cancelled ? [] : entries.flatMap(({ result, ...origin }) => result.actions.map(action => ({ ...origin, action })))
    let permission: DispatchResult['permission']
    for (const row of actions) {
      if (row.action.kind !== 'permission') continue
      if (!permission || PERMISSION_PRIORITY[row.action.decision] > PERMISSION_PRIORITY[permission.action.decision]) permission = { ...row, action: row.action }
    }
    const count = (status: HandlerResult['status']) => entries.filter(entry => entry.result.status === status).length
    return freeze({ entries, actions, ...(permission ? { permission } : {}), cancelled, diagnostic: {
      dispatchID, sessionID: event.sessionID, event: event.event, durationMs: Math.round(performance.now() - started), cancelled,
      failed: count('failed'), unsupported: count('unsupported'), skipped: count('skipped'), background: count('background'),
      handlers: entries.map(({ result, ...origin }) => ({ ...result.diagnostic, ...origin })),
    } })
  } finally {
    parent?.removeEventListener('abort', abort)
  }
}
