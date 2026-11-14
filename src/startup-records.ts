import { createHash, randomUUID } from 'node:crypto'
import { HostHookError } from './host-errors.js'
import type { SessionStartDelivery } from './session-start.js'
import type { JsonValue } from './types.js'
import type { CommandArtifact } from './effect-types.js'
import type { SessionSnapshot } from './sessions.js'
import { SESSION_SNAPSHOT_VERSION, sessionSnapshot, snapshotCopy, snapshotID, snapshotObject } from './session-snapshot.js'
import { nativeHookRecord } from './hook-record-snapshot.js'

const MAX_SESSIONS = 1024
const MAX_BATCHES = 4096
const MAX_BYTES = 32 * 1024 * 1024
const MAX_EXIT = 255
const MAX_ID_BYTES = 4096
const SNAPSHOT_KIND = 'startup-records'
const DIGEST = /^[a-f0-9]{64}$/
const SOURCES = new Set(['startup', 'resume', 'clear', 'compact'])
const SIGNALS = new Set<NodeJS.Signals>(['SIGINT', 'SIGTERM', 'SIGKILL'])
export interface StartupRecord {
  readonly id: string
  readonly created: number
  readonly body: { readonly type: 'attachment'; readonly attachment: Readonly<Record<string, JsonValue>>; readonly rendered?: readonly { readonly content: string }[]; readonly renderedRole?: 'system' }
}
export interface StartupBatch {
  readonly activationID: string
  readonly records: readonly StartupRecord[]
  readonly model: { readonly claude: readonly string[]; readonly codex: readonly string[] }
}
interface State { readonly signal: AbortSignal; readonly batches: Map<string, StartupBatch>; readonly bindings: Map<string, string>; readonly failures: Set<string>; readonly failureBatches: Map<string, readonly string[]>; readonly cleanup: () => void; bytes: number }
function fail(code: string): never { throw new HostHookError(code, code === 'STARTUP_CANCELLED' ? 'cancelled' : 'unsupported') }
function id(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && !value.includes('\0') && Buffer.byteLength(value) <= MAX_ID_BYTES }
function time(value: number): boolean { return Number.isFinite(value) && !Number.isNaN(new Date(value).getTime()) }
function freeze<T>(value: T): T { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) } return value }
function exit(command: CommandArtifact | undefined): number {
  if (!command || typeof command.command !== 'string' || typeof command.stdout !== 'string' || typeof command.stderr !== 'string' || !time(command.completedAt) || !Number.isFinite(command.durationMs) || command.durationMs < 0) fail('STARTUP_EXECUTION_UNAVAILABLE')
  if (command.status !== 'exited') fail('STARTUP_EXECUTION_UNAVAILABLE')
  if (command.signal !== null) {
    if (command.exitCode !== null || !SIGNALS.has(command.signal)) fail('STARTUP_EXECUTION_UNAVAILABLE')
    return 1
  }
  if (typeof command.exitCode !== 'number' || !Number.isSafeInteger(command.exitCode) || command.exitCode < 0 || command.exitCode > MAX_EXIT) fail('STARTUP_EXECUTION_UNAVAILABLE')
  return command.exitCode
}

export class StartupRecords {
  private readonly states = new Map<string, State>()
  private bytes = 0
  private batches = 0
  private disposed = false

  admit(delivery: SessionStartDelivery): StartupBatch {
    const { event, session, dispatch, signal } = delivery
    if (this.disposed || signal.aborted || session.signal.aborted || dispatch.cancelled) fail('STARTUP_CANCELLED')
    if (event.event !== 'SessionStart' || event.sessionID !== session.sessionID || dispatch.diagnostic.sessionID !== session.sessionID || dispatch.diagnostic.event !== 'SessionStart' || !id(event.activationID)) fail('STARTUP_OWNER_MISMATCH')
    const source = event.dialectData?.['claude-code']?.source ?? event.data?.source
    if (typeof source !== 'string' || !SOURCES.has(source)) fail('STARTUP_SOURCE_UNAVAILABLE')
    const existing = this.states.get(session.sessionID)
    if (existing && existing.signal !== session.signal) fail('STARTUP_OWNER_MISMATCH')
    if (existing?.batches.has(event.activationID)) fail('STARTUP_ACTIVATION_REUSED')
    const records: StartupRecord[] = [], additional: StartupRecord[] = [], claude: string[] = [], deferred: string[] = [], codex: string[] = []
    const toolUseID = randomUUID(), hookName = 'SessionStart:' + source
    const append = (attachment: Record<string, JsonValue>, created: number, rendered?: string, target = records) => target.push({ id: randomUUID(), created, body: { type: 'attachment', attachment, ...(rendered === undefined ? {} : { rendered: [{ content: rendered }], renderedRole: 'system' }) } })
    const seen = new Set<string>(), completions = new Set<number>()
    const failures = new Set<string>()
    for (const entry of [...dispatch.entries].sort((a, b) => a.completionOrder - b.completionOrder)) {
      const result = entry.result
      if (!id(entry.sourceID) || !id(entry.registrationID) || result.diagnostic.sourceID !== entry.sourceID || result.diagnostic.registrationID !== entry.registrationID || result.diagnostic.dialect !== entry.dialect || result.diagnostic.event !== 'SessionStart' || !Number.isSafeInteger(entry.completionOrder) || entry.completionOrder < 0 || completions.has(entry.completionOrder) || seen.has(entry.registrationID)) fail('STARTUP_OWNER_MISMATCH')
      seen.add(entry.registrationID); completions.add(entry.completionOrder)
      if (result.status === 'background') { if (result.code !== 'BACKGROUND_QUEUED' || !id(result.jobID) || result.actions.length) fail('STARTUP_EXECUTION_UNAVAILABLE'); continue }
      if (entry.dialect === 'codex') {
        if (result.status === 'skipped') continue
        if (result.status !== 'success' || result.actions.some(action => action.kind !== 'context' || action.placement !== 'model')) fail('STARTUP_EFFECT_UNAVAILABLE')
        for (const action of result.actions) if (action.kind === 'context') codex.push(action.text)
        continue
      }
      const failure = 'nativeFailureArtifact' in result ? result.nativeFailureArtifact : undefined
      if (failure) {
        if (result.status !== 'skipped' || result.actions.length || failure.type !== 'hook_non_blocking_error' || !time(failure.completedAt) || typeof failure.stdout !== 'string' || typeof failure.stderr !== 'string' || failure.exitCode !== 1 || failure.durationMs !== undefined && (!Number.isFinite(failure.durationMs) || failure.durationMs < 0)) fail('STARTUP_EXECUTION_UNAVAILABLE')
        const { completedAt, ...body } = failure
        const identity = createHash('sha256').update(JSON.stringify([entry.sourceID, entry.sourceDigest, entry.registrationID, failure.type, failure.stdout, failure.stderr, failure.exitCode, failure.command])).digest('hex')
        if (source === 'resume' && existing?.failures.has(identity)) continue
        failures.add(identity)
        append({ ...body, hookName, toolUseID, hookEvent: 'SessionStart' }, completedAt)
        continue
      }
      if (result.status === 'skipped') continue
      if (result.status !== 'success' && result.status !== 'failed') fail('STARTUP_EFFECT_UNAVAILABLE')
      const command = result.commandArtifact
      if (command?.status === 'timeout') {
        if (result.status !== 'failed' || result.code !== 'EXECUTION_TIMEOUT' || result.actions.length || !time(command.completedAt) || !Number.isFinite(command.durationMs) || command.durationMs < 0 || typeof command.timeoutMs !== 'number' || command.timeoutMs <= 0 || !Number.isFinite(command.timeoutMs)) fail('STARTUP_EXECUTION_UNAVAILABLE')
        append({ type: 'hook_cancelled', hookName, toolUseID, hookEvent: 'SessionStart', command: command.command, durationMs: command.durationMs, timedOut: true, timeoutMs: command.timeoutMs }, command.completedAt)
        continue
      }
      const exitCode = exit(command)
      if (result.actions.some(action => action.kind === 'block-event' || action.kind === 'stop-session')) fail('STARTUP_BLOCKED')
      if (result.status === 'failed') {
        if (result.code !== 'COMMAND_FAILED' || exitCode === 0 || result.actions.length) fail('STARTUP_EFFECT_UNAVAILABLE')
        append({ type: 'hook_non_blocking_error', hookName, toolUseID, hookEvent: 'SessionStart', stdout: command!.stdout, stderr: 'Failed with non-blocking status code: ' + (command!.stderr.trim() || 'No stderr output'), exitCode, command: command!.command, durationMs: command!.durationMs }, command!.completedAt)
        continue
      }
      let content = ''
      for (const action of result.actions) {
        if (action.kind !== 'context' || action.placement !== 'model' || !['stdout', 'additionalContext'].includes(action.channel ?? '')) fail('STARTUP_EFFECT_UNAVAILABLE')
        if (action.channel === 'stdout') {
          if (content || exitCode !== 0) fail('STARTUP_EFFECT_UNAVAILABLE')
          content = action.text
        } else {
          const rendered = `<system-reminder>\nSessionStart hook additional context: ${action.text}\n</system-reminder>`
          append({ type: 'hook_additional_context', content: [action.text], hookName: 'SessionStart', toolUseID: 'hook-' + randomUUID(), hookEvent: 'SessionStart' }, command!.completedAt, rendered, additional)
          deferred.push(rendered)
        }
      }
      const rendered = content ? `<system-reminder>\n${hookName} hook success: ${content}\n</system-reminder>` : undefined
      append({ type: 'hook_success', hookName, toolUseID, hookEvent: 'SessionStart', content, stdout: command!.stdout, stderr: command!.stderr, exitCode, command: command!.command, durationMs: command!.durationMs }, command!.completedAt, rendered)
      if (rendered) claude.push(rendered)
    }
    const batch = freeze({ activationID: event.activationID, records: [...records, ...additional], model: { claude: [...claude, ...deferred], codex } })
    const bytes = Buffer.byteLength(JSON.stringify(batch))
    if (this.batches >= MAX_BATCHES || this.bytes + bytes > MAX_BYTES || !existing && this.states.size >= MAX_SESSIONS) fail('STARTUP_LIMIT')
    if (signal.aborted || session.signal.aborted) fail('STARTUP_CANCELLED')
    let state = existing
    if (!state) {
      state = this.createState(session)
    }
    state.batches.set(event.activationID, batch); for (const identity of failures) state.failures.add(identity)
    state.failureBatches.set(event.activationID, [...failures])
    state.bytes += bytes; this.bytes += bytes; this.batches++
    return batch
  }

  snapshot(sessionID: string) {
    const state = this.states.get(sessionID)
    return snapshotCopy({ kind: SNAPSHOT_KIND, version: SESSION_SNAPSHOT_VERSION, sessionID, batches: [...(state?.batches ?? [])].map(([activationID, batch]) => ({ batch, binding: state?.bindings.get(activationID) ?? null, failures: state?.failureBatches.get(activationID) ?? [] })) })
  }

  restore(session: SessionSnapshot, value: unknown): () => void {
    const input = sessionSnapshot(SNAPSHOT_KIND, value, session, ['batches'])
    if (this.disposed) fail('STARTUP_CANCELLED')
    if (this.states.has(session.sessionID)) throw new HostHookError('SESSION_SNAPSHOT_STATE_CONFLICT', 'unsupported')
    if (!Array.isArray(input.batches)) throw new HostHookError('SESSION_SNAPSHOT_SCHEMA_INVALID', 'unsupported')
    if (this.batches + input.batches.length > MAX_BATCHES || input.batches.length && this.states.size >= MAX_SESSIONS) fail('STARTUP_LIMIT')
    const batches = new Map<string, StartupBatch>(), bindings = new Map<string, string>(), failures = new Map<string, readonly string[]>(), identities = new Set<string>()
    let bytes = 0
    for (const raw of input.batches) {
      const row = snapshotObject(raw, ['batch', 'binding', 'failures']), item = snapshotObject(row.batch, ['activationID', 'records', 'model']), model = snapshotObject(item.model, ['claude', 'codex'])
      if (!snapshotID(item.activationID) || batches.has(item.activationID) || !Array.isArray(item.records) || !Array.isArray(model.claude) || !model.claude.every(text => typeof text === 'string') || !Array.isArray(model.codex) || !model.codex.every(text => typeof text === 'string') || row.binding !== null && !snapshotID(row.binding) || !Array.isArray(row.failures) || row.failures.some(hash => typeof hash !== 'string' || !DIGEST.test(hash)) || new Set(row.failures).size !== row.failures.length) throw new HostHookError('SESSION_SNAPSHOT_SCHEMA_INVALID', 'unsupported')
      const records = item.records.map(value => nativeHookRecord(value, 'SessionStart'))
      for (const record of records) { if (identities.has(record.id)) throw new HostHookError('SESSION_SNAPSHOT_SCHEMA_INVALID', 'unsupported'); identities.add(record.id) }
      const rendered = records.flatMap(record => record.body.rendered?.map(row => row.content) ?? [])
      if (JSON.stringify(rendered) !== JSON.stringify(model.claude)) throw new HostHookError('SESSION_SNAPSHOT_SCHEMA_INVALID', 'unsupported')
      const batch: StartupBatch = freeze({ activationID: item.activationID, records, model: { claude: [...model.claude] as string[], codex: [...model.codex] as string[] } })
      bytes += Buffer.byteLength(JSON.stringify(batch))
      if (this.bytes + bytes > MAX_BYTES) fail('STARTUP_LIMIT')
      batches.set(batch.activationID, batch)
      if (row.binding !== null) bindings.set(batch.activationID, row.binding)
      failures.set(batch.activationID, [...row.failures] as string[])
    }
    if (session.signal.aborted) throw new HostHookError('SESSION_SNAPSHOT_CANCELLED', 'cancelled')
    if (!batches.size) return () => {}
    const state = this.createState(session)
    for (const [id, batch] of batches) state.batches.set(id, batch)
    for (const [id, binding] of bindings) state.bindings.set(id, binding)
    for (const [id, hashes] of failures) { state.failureBatches.set(id, hashes); for (const hash of hashes) state.failures.add(hash) }
    state.bytes = bytes; this.bytes += bytes; this.batches += batches.size
    return () => { if (this.states.get(session.sessionID) === state) state.cleanup() }
  }

  pending(sessionID: string): readonly StartupBatch[] {
    const state = this.states.get(sessionID)
    return Object.freeze([...(state?.batches ?? [])].flatMap(([id, batch]) => state?.bindings.has(id) ? [] : [batch]))
  }

  private createState(session: SessionSnapshot): State {
    const cleanup = () => { const current = this.states.get(session.sessionID); if (!current) return; this.bytes -= current.bytes; this.batches -= current.batches.size; this.states.delete(session.sessionID); session.signal.removeEventListener('abort', cleanup) }
    const state: State = { signal: session.signal, batches: new Map(), bindings: new Map(), failures: new Set(), failureBatches: new Map(), cleanup, bytes: 0 }
    this.states.set(session.sessionID, state)
    session.signal.addEventListener('abort', cleanup, { once: true })
    return state
  }

  read(sessionID: string): readonly StartupBatch[] { return Object.freeze([...(this.states.get(sessionID)?.batches.values() ?? [])]) }

  revoke(session: SessionSnapshot, activationID: string): void {
    const state = this.states.get(session.sessionID)
    if (!state) return
    if (state.signal !== session.signal || state.bindings.has(activationID)) fail('STARTUP_BINDING_INVALID')
    const batch = state.batches.get(activationID)
    if (!batch) return
    const bytes = Buffer.byteLength(JSON.stringify(batch))
    state.batches.delete(activationID); state.failureBatches.delete(activationID)
    state.failures.clear()
    for (const identities of state.failureBatches.values()) for (const identity of identities) state.failures.add(identity)
    state.bytes -= bytes; this.bytes -= bytes; this.batches--
    if (!state.batches.size) { this.states.delete(session.sessionID); session.signal.removeEventListener('abort', state.cleanup) }
  }

  unbind(session: SessionSnapshot, activationID: string, messageID: string): void {
    const state = this.states.get(session.sessionID)
    if (!state) return
    if (state.signal !== session.signal || state.bindings.get(activationID) !== messageID) fail('STARTUP_BINDING_INVALID')
    state.bindings.delete(activationID)
  }

  releasePrompt(session: SessionSnapshot, messageID: string): void {
    const state = this.states.get(session.sessionID)
    if (!state) return
    if (state.signal !== session.signal) fail('SESSION_SNAPSHOT_OWNER_MISMATCH')
    for (const [id, binding] of state.bindings) if (binding === messageID) state.bindings.delete(id)
  }

  bind(session: SessionSnapshot, activationID: string, messageID: string): void {
    if (this.disposed || session.signal.aborted || session.turnSignal.aborted) fail('STARTUP_CANCELLED')
    const state = this.states.get(session.sessionID), previous = state?.bindings.get(activationID)
    if (!state || state.signal !== session.signal || !state.batches.has(activationID) || !id(messageID) || session.turnID !== messageID || previous !== undefined && previous !== messageID) fail('STARTUP_BINDING_INVALID')
    state.bindings.set(activationID, messageID)
  }

  beforePrompt(sessionID: string, messageID: string): readonly StartupRecord[] {
    const state = this.states.get(sessionID)
    return Object.freeze([...(state?.batches.entries() ?? [])].flatMap(([id, batch]) => state?.bindings.get(id) === messageID ? batch.records : []))
  }

  unbound(sessionID: string): readonly StartupRecord[] {
    const state = this.states.get(sessionID)
    return Object.freeze([...(state?.batches.entries() ?? [])].flatMap(([id, batch]) => state?.bindings.has(id) ? [] : batch.records))
  }
  dispose(): void { this.disposed = true; for (const state of this.states.values()) state.signal.removeEventListener('abort', state.cleanup); this.states.clear(); this.bytes = 0; this.batches = 0 }
}
