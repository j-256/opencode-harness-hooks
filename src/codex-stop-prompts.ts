import { isAbsolute } from 'node:path'
import type { DispatchEntry, DispatchOrigin, DispatchResult } from './engine.js'
import { resolveEffects } from './effects.js'
import { HostHookError } from './hosts/tools.js'
import type { LoadedSource, Registration } from './types.js'

const MAX_BYTES = 32 * 1024 * 1024
const MAX_FRAGMENTS = 10000
const MAX_ID_BYTES = 4096

export interface CodexStopRegistrationIdentity {
  readonly sourceID: string
  readonly sourceDigest: string
  readonly sourcePath: string
  readonly registrationID: string
  readonly ordinal: number
}
export interface CodexStopPromptIdentity {
  readonly threadID: string
  readonly turnID: string
  readonly messageID: string
  readonly createTime: number
  readonly startedAtMs: number
  readonly completedAtMs: number
}
export interface CodexStopPromptInput {
  readonly dispatch: DispatchResult
  readonly sources: readonly LoadedSource[]
  readonly registrations: readonly CodexStopRegistrationIdentity[]
  readonly identity: CodexStopPromptIdentity
  readonly maxBytes?: number
}
interface InputText { readonly type: 'input_text'; readonly text: string }
interface Message {
  readonly type: 'message'
  readonly id: string
  readonly role: 'user'
  readonly content: readonly InputText[]
}
interface MessageMetadata {
  readonly turn_id: string
  readonly create_time: number
  readonly content_item_kinds: readonly 'unknown'[]
  readonly content_item_metadata: readonly { readonly provenance: { readonly type: 'harness'; readonly hook: true } }[]
}
export interface CodexStopFragmentOrigin extends CodexStopRegistrationIdentity {
  readonly configuredOrder: number
}
export interface CodexStopPromptArtifacts {
  readonly model: Message
  readonly response: Message & { readonly internal_chat_message_metadata_passthrough: MessageMetadata }
  readonly event: {
    readonly type: 'item_completed'
    readonly thread_id: string
    readonly turn_id: string
    readonly item: { readonly type: 'HookPrompt'; readonly id: string; readonly fragments: readonly { readonly text: string; readonly hookRunId: string }[] }
    readonly started_at_ms: number
    readonly completed_at_ms: number
  }
  readonly origins: readonly CodexStopFragmentOrigin[]
}

function fail(code: string): never { throw new HostHookError(code, 'unsupported') }
function validID(value: unknown): value is string { return typeof value === 'string' && !!value && !value.includes('\0') && Buffer.byteLength(value) <= MAX_ID_BYTES }
function validTime(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 0 && !Number.isNaN(new Date(value).getTime()) }
function key(value: Pick<DispatchOrigin, 'sourceID' | 'registrationID'>): string { return JSON.stringify([value.sourceID, value.registrationID]) }
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) }
  return value
}
function escapeText(value: string): string { return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;') }
export function renderCodexHookPrompt(text: string, hookRunID: string): string { return `<hook_prompt hook_run_id="${escapeText(hookRunID).replaceAll('"', '&quot;')}">${escapeText(text)}</hook_prompt>` }

export function compileCodexStopPrompt(input: CodexStopPromptInput): CodexStopPromptArtifacts | undefined {
  const { dispatch, identity } = input
  if (dispatch.diagnostic.event !== 'Stop') fail('CODEX_STOP_EVENT_UNSUPPORTED')
  const effects = resolveEffects(dispatch)
  const continuations = effects.proceed ? effects.continuations.filter(row => row.dialect === 'codex').sort((a, b) => a.configuredOrder - b.configuredOrder) : []
  if (!continuations.length) return undefined
  const maxBytes = input.maxBytes ?? MAX_BYTES
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_BYTES) fail('CODEX_STOP_LIMIT_INVALID')
  if (continuations.length > MAX_FRAGMENTS || dispatch.entries.length > MAX_FRAGMENTS || input.sources.length > MAX_FRAGMENTS || input.registrations.length > MAX_FRAGMENTS) fail('CODEX_STOP_ARTIFACT_LIMIT')
  if (!validID(identity.threadID) || !validID(identity.turnID) || !validID(identity.messageID) || typeof identity.createTime !== 'number' || !validTime(identity.createTime * 1000) || !validTime(identity.startedAtMs) || !validTime(identity.completedAtMs) || !Number.isSafeInteger(identity.startedAtMs) || !Number.isSafeInteger(identity.completedAtMs) || identity.completedAtMs < identity.startedAtMs) fail('CODEX_STOP_METADATA_UNAVAILABLE')
  const sources = new Map<string, LoadedSource>()
  const sourceRegistrations = new Map<string, Registration>()
  for (const source of input.sources) {
    if (sources.has(source.id)) fail('CODEX_STOP_IDENTITY_UNAVAILABLE')
    sources.set(source.id, source)
    for (const row of source.registrations) if (row.event === 'Stop') {
      const id = JSON.stringify([source.id, row.id])
      if (sourceRegistrations.has(id) || row.sourceID !== source.id || row.dialect !== source.dialect) fail('CODEX_STOP_IDENTITY_UNAVAILABLE')
      sourceRegistrations.set(id, row)
      if (sourceRegistrations.size > MAX_FRAGMENTS) fail('CODEX_STOP_ARTIFACT_LIMIT')
    }
  }
  const identities = new Map<string, CodexStopRegistrationIdentity>()
  const nativeRegistrations = new Map<string, number>()
  const nativeOrdinals = new Map<string, string>()
  for (const registration of input.registrations) {
    const source = sources.get(registration.sourceID)
    if (identities.has(key(registration)) || !Number.isSafeInteger(registration.ordinal) || registration.ordinal < 0 || !source || source.digest !== registration.sourceDigest || source.path !== registration.sourcePath || source.dialect !== 'codex' || !source.enabled || !validID(source.path) || !isAbsolute(source.path) || !sourceRegistrations.has(key(registration))) fail('CODEX_STOP_IDENTITY_UNAVAILABLE')
    identities.set(key(registration), registration)
    const row = sourceRegistrations.get(key(registration))!
    const nativeKey = JSON.stringify([source.path, row.groupIndex, row.handlerIndex])
    const ordinalKey = JSON.stringify([source.path, registration.ordinal])
    if ((nativeRegistrations.has(nativeKey) && nativeRegistrations.get(nativeKey) !== registration.ordinal) || (nativeOrdinals.has(ordinalKey) && nativeOrdinals.get(ordinalKey) !== nativeKey)) fail('CODEX_STOP_IDENTITY_UNAVAILABLE')
    nativeRegistrations.set(nativeKey, registration.ordinal)
    nativeOrdinals.set(ordinalKey, nativeKey)
  }
  const fragments: { text: string; hookRunId: string }[] = []
  const content: InputText[] = []
  const origins: CodexStopFragmentOrigin[] = []
  const entries = new Map<number, DispatchEntry>()
  for (const entry of dispatch.entries) {
    if (!Number.isSafeInteger(entry.configuredOrder) || entry.configuredOrder < 0 || entries.has(entry.configuredOrder)) fail('CODEX_STOP_IDENTITY_UNAVAILABLE')
    entries.set(entry.configuredOrder, entry)
  }
  let inputBytes = 0
  for (const row of continuations) {
    const registration = identities.get(key(row)), source = sources.get(row.sourceID)
    const entry = entries.get(row.configuredOrder)
    if (!registration || !source || registration.sourceDigest !== row.sourceDigest || !entry || entry.sourceID !== row.sourceID || entry.registrationID !== row.registrationID || entry.sourceDigest !== row.sourceDigest || entry.dialect !== row.dialect || entry.completionOrder !== row.completionOrder || !entry.result.actions.some(action => action.kind === 'continue-turn' && action.mode === row.action.mode && action.text === row.action.text) || row.action.mode !== 'user' || typeof row.action.text !== 'string') fail('CODEX_STOP_IDENTITY_UNAVAILABLE')
    inputBytes += Buffer.byteLength(row.action.text) + Buffer.byteLength(source.path)
    if (inputBytes > maxBytes) fail('CODEX_STOP_ARTIFACT_LIMIT')
    const hookRunId = `stop:${registration.ordinal}:${source.path}`
    fragments.push({ text: row.action.text, hookRunId })
    content.push({ type: 'input_text', text: renderCodexHookPrompt(row.action.text, hookRunId) })
    origins.push({ sourceID: registration.sourceID, sourceDigest: registration.sourceDigest, registrationID: registration.registrationID, ordinal: registration.ordinal, sourcePath: source.path, configuredOrder: row.configuredOrder })
  }
  const model: Message = { type: 'message', id: identity.messageID, role: 'user', content }
  const result: CodexStopPromptArtifacts = {
    model,
    response: { ...model, internal_chat_message_metadata_passthrough: { turn_id: identity.turnID, create_time: identity.createTime, content_item_kinds: fragments.map(() => 'unknown'), content_item_metadata: fragments.map(() => ({ provenance: { type: 'harness', hook: true } })) } },
    event: { type: 'item_completed', thread_id: identity.threadID, turn_id: identity.turnID, item: { type: 'HookPrompt', id: identity.messageID, fragments }, started_at_ms: identity.startedAtMs, completed_at_ms: identity.completedAtMs },
    origins,
  }
  if (Buffer.byteLength(JSON.stringify(result)) > maxBytes) fail('CODEX_STOP_ARTIFACT_LIMIT')
  return freeze(result)
}
