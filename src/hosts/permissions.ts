import { runService } from '../service-execution.js'
import type { SessionSnapshot } from '../sessions.js'
import { HostHookError } from './tools.js'
import type { HostToolEvent, ToolHostOptions } from './tools.js'

const MAX_GRANTS = 1024
const MAX_REQUESTS = 4096
const REPLY_MS = 5000

export interface PermissionEvaluation {
  readonly sessionID: string
  readonly agent?: string | undefined
  readonly action: string
  readonly resources: readonly string[]
  readonly source?: { readonly type: 'tool'; readonly id: string; readonly messageID: string } | undefined
  effect: 'allow' | 'deny' | 'ask'
}
export interface PermissionReply {
  readonly sessionID: string
  readonly requestID: string
  readonly signal: AbortSignal
}
interface Grant {
  readonly sessionID: string
  readonly callID: string
  readonly agent?: string
  messageID?: string
  readonly signal: AbortSignal
  readonly requests: Set<string>
}
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function nonempty(value: unknown): value is string { return typeof value === 'string' && value.length > 0 }
function key(host: string, sessionID: string, callID: string): string { return JSON.stringify([host, sessionID, callID]) }

export class CallApprovals {
  private readonly grants = new Map<string, Grant>()
  private readonly active = new Set<Promise<void>>()
  private readonly lifetime = new AbortController()
  private readonly diagnostic: ToolHostOptions['diagnostic']
  private requests = 0
  private replies = 0
  private evaluations = 0
  private failures = 0
  private observerFailures = 0

  constructor(options: { readonly diagnostic?: ToolHostOptions['diagnostic'] } = {}) { this.diagnostic = options.diagnostic }

  remember(event: HostToolEvent, session: SessionSnapshot): void {
    if (this.lifetime.signal.aborted || event.signal.aborted || session.signal.aborted || session.turnSignal.aborted) throw new HostHookError('HOST_TOOL_CANCELLED', 'cancelled')
    if (event.event !== 'PreToolUse' || event.sessionID !== session.sessionID || !nonempty(event.callID) || !nonempty(session.turnID) || event.host === 'v2' && !nonempty(event.messageID)) throw new HostHookError('HOST_PERMISSION_SOURCE_UNAVAILABLE', 'unsupported')
    const id = key(event.host, event.sessionID, event.callID)
    if (this.grants.has(id)) throw new HostHookError('HOST_PERMISSION_CALL_BUSY', 'failed')
    if (this.grants.size >= MAX_GRANTS) throw new HostHookError('HOST_PERMISSION_CALL_LIMIT', 'unsupported')
    const signal = AbortSignal.any([event.signal, session.signal, session.turnSignal, this.lifetime.signal])
    const grant: Grant = { sessionID: event.sessionID, callID: event.callID, signal, requests: new Set(), ...(event.messageID ? { messageID: event.messageID } : {}), ...(event.agent ? { agent: event.agent } : {}) }
    this.grants.set(id, grant)
    const abort = () => {
      if (this.grants.get(id) !== grant) return
      this.grants.delete(id)
      this.requests -= grant.requests.size
      grant.requests.clear()
    }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  }

  async replyV1(input: unknown, reply: (request: PermissionReply) => Promise<void>): Promise<void> {
    if (!record(input) || !nonempty(input.id) || !nonempty(input.sessionID) || !record(input.tool) || !nonempty(input.tool.callID) || !nonempty(input.tool.messageID)) return
    const grant = this.grants.get(key('v1', input.sessionID, input.tool.callID))
    if (!grant || grant.signal.aborted || grant.messageID && grant.messageID !== input.tool.messageID || grant.requests.has(input.id)) return
    if (this.requests >= MAX_REQUESTS) { this.report(grant, 'HOST_PERMISSION_REQUEST_LIMIT', 'unsupported'); return }
    const requestID = input.id
    grant.messageID ??= input.tool.messageID
    grant.requests.add(requestID)
    this.requests++
    const pending = runService(REPLY_MS, grant.signal, signal => reply({ sessionID: grant.sessionID, requestID, signal })).then(() => {
      if (!grant.signal.aborted) this.replies++
    }).catch(() => {
      if (grant.signal.aborted) this.report(grant, 'HOST_PERMISSION_REPLY_CANCELLED', 'cancelled')
      else { this.failures++; this.report(grant, 'HOST_PERMISSION_REPLY_FAILED', 'failed') }
    })
    this.active.add(pending)
    try { await pending } finally { this.active.delete(pending) }
  }

  applyV2(input: PermissionEvaluation): void {
    if (input.effect !== 'ask' || input.source?.type !== 'tool') return
    const grant = this.grants.get(key('v2', input.sessionID, input.source.id))
    if (!grant || grant.signal.aborted || grant.messageID !== input.source.messageID || grant.agent && input.agent && grant.agent !== input.agent) return
    input.effect = 'allow'
    this.evaluations++
  }

  async dispose(): Promise<void> { this.lifetime.abort(); await Promise.allSettled([...this.active]) }
  inspect() { return Object.freeze({ grants: this.grants.size, requests: this.requests, pending: this.active.size, replies: this.replies, evaluations: this.evaluations, failures: this.failures, observerFailures: this.observerFailures }) }

  private report(grant: Grant, code: string, outcome: 'failed' | 'cancelled' | 'unsupported'): void {
    try {
      const result = this.diagnostic?.(Object.freeze({ code, outcome, sessionID: grant.sessionID, callID: grant.callID, event: 'PreToolUse' }))
      if (result) void Promise.resolve(result).catch(() => { this.observerFailures++ })
    } catch { this.observerFailures++ }
  }
}
