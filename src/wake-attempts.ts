import { z } from 'zod'
import { backgroundAnchor } from './background-records.js'
import type { BackgroundAnchor } from './background-records.js'
import type { DispatchResult } from './engine.js'
import { resolveEffects } from './effects.js'
import { HostHookError } from './host-errors.js'
import { nativeHookRecord } from './hook-record-snapshot.js'
import type { HostNotificationEvent } from './notification.js'
import { claudePromptAttachments } from './prompt-attachments.js'
import type { PromptAttachment } from './prompt-attachments.js'
import { snapshotID } from './session-snapshot.js'

export interface WakeAttemptResult {
  readonly outcome: 'allow' | 'block' | 'stop' | 'cancelled'; readonly dispatchHash: string; readonly reason: string | null; readonly completedAt: number
  readonly attachments: readonly PromptAttachment[]; readonly warnings: readonly string[]; readonly feedback: readonly string[]; readonly developer: readonly string[]
}
export interface WakeAttempt { readonly id: string; readonly promptID: string; readonly created: number; readonly anchor: BackgroundAnchor; readonly result: WakeAttemptResult | null }
const ID = z.string().refine(snapshotID)
const DATE_LIMIT = 8640000000000000
const HASH = z.string().regex(/^[a-f0-9]{64}$/)
const UUID = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
const RESULT = z.object({ outcome: z.enum(['allow', 'block', 'stop', 'cancelled']), dispatchHash: HASH, reason: z.string().nullable(), completedAt: z.number().int().nonnegative().max(DATE_LIMIT), attachments: z.array(z.unknown()), warnings: z.array(z.string()), feedback: z.array(z.string()), developer: z.array(z.string()) }).strict()
const ATTEMPT = z.object({ id: UUID, promptID: ID, created: z.number().int().nonnegative().max(DATE_LIMIT), anchor: z.unknown(), result: RESULT.nullable() }).strict()
const ACTIONS = new Set(['context', 'feedback', 'warning', 'block-event', 'stop-session', 'native-extension'])
const ORIGIN_FIELDS = ['sourceID', 'sourceDigest', 'registrationID', 'dialect', 'configuredOrder', 'completionOrder'] as const
function fail(code: string): never { throw new HostHookError(code, 'unsupported') }
function freeze<T>(value: T): T { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) }; return value }

export function wakeAttempt(value: unknown, sessionID: string): WakeAttempt {
  const parsed = ATTEMPT.safeParse(value); if (!parsed.success) fail('SESSION_SNAPSHOT_SCHEMA_INVALID')
  const input = parsed.data, anchor = backgroundAnchor(input.anchor)
  if (anchor.sessionID !== sessionID || anchor.turnID !== input.promptID || (anchor.kind === 'prompt' ? anchor.messageID !== input.promptID : anchor.messageID === input.promptID)) fail('WAKE_ATTEMPT_OWNER_MISMATCH')
  let result: WakeAttemptResult | null = null
  if (input.result) {
    const raw = input.result, accepted = raw.outcome === 'allow'
    if ((raw.outcome === 'block' || raw.outcome === 'stop') !== (raw.reason !== null) || !accepted && (raw.attachments.length || raw.developer.length)) fail('SESSION_SNAPSHOT_SCHEMA_INVALID')
    result = { ...raw, attachments: raw.attachments.map(value => nativeHookRecord(value, 'UserPromptSubmit')) }
  }
  return freeze({ id: input.id, promptID: input.promptID, created: input.created, anchor, result })
}

export function wakeAttemptResult(event: HostNotificationEvent, dispatch: DispatchResult, dispatchHash: string): WakeAttemptResult {
  if (dispatch.diagnostic.sessionID !== event.sessionID || dispatch.diagnostic.event !== event.event || !snapshotID(dispatch.diagnostic.dispatchID)) fail('WAKE_ATTEMPT_OWNER_MISMATCH')
  if (event.event !== 'UserPromptSubmit' || dispatch.cancelled !== dispatch.diagnostic.cancelled) fail('WAKE_DISPATCH_INVALID')
  const completed = new Set<number>()
  for (const [index, entry] of dispatch.entries.entries()) {
    const diagnostic = entry.result.diagnostic
    if (entry.configuredOrder !== index || !Number.isSafeInteger(entry.completionOrder) || entry.completionOrder < 0 || entry.completionOrder >= dispatch.entries.length || completed.has(entry.completionOrder) || !snapshotID(entry.sourceID) || !snapshotID(entry.registrationID) || !HASH.safeParse(entry.sourceDigest).success || diagnostic.sourceID !== entry.sourceID || diagnostic.sourceDigest !== entry.sourceDigest || diagnostic.registrationID !== entry.registrationID || diagnostic.dialect !== entry.dialect || diagnostic.event !== event.event) fail('WAKE_DISPATCH_INVALID')
    completed.add(entry.completionOrder)
  }
  const expected = dispatch.cancelled ? [] : dispatch.entries.flatMap(({ result, ...origin }) => result.actions.map(action => ({ ...origin, action })))
  if (expected.length !== dispatch.actions.length || expected.some((row, index) => ORIGIN_FIELDS.some(field => row[field] !== dispatch.actions[index]![field]) || JSON.stringify(row.action) !== JSON.stringify(dispatch.actions[index]!.action))) fail('WAKE_DISPATCH_INVALID')
  const resolution = resolveEffects(dispatch)
  if (dispatch.actions.some(row => !ACTIONS.has(row.action.kind) || row.action.kind === 'native-extension' && row.action.name !== 'mcpSourceNamespace')) fail('WAKE_EFFECT_UNSUPPORTED')
  if (resolution.context.some(row => row.action.placement !== 'model') || !['default', 'block', 'stop', 'cancelled'].includes(resolution.control)) fail('WAKE_EFFECT_UNSUPPORTED')
  const outcome = resolution.control === 'default' ? 'allow' : resolution.control as 'block' | 'stop' | 'cancelled'
  return freeze({ outcome, dispatchHash, reason: resolution.stop?.action.reason ?? resolution.block?.action.reason ?? null, completedAt: Date.now(),
    attachments: outcome === 'allow' ? claudePromptAttachments(event, dispatch) : [], warnings: resolution.warnings.map(row => row.action.text), feedback: resolution.feedback.map(row => row.action.text),
    developer: outcome === 'allow' ? resolution.context.filter(row => row.dialect === 'codex').map(row => row.action.text) : [],
  })
}
