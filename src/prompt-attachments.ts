import { createHash, randomUUID } from 'node:crypto'
import type { DispatchResult } from './engine.js'
import { HostHookError } from './host-errors.js'
import type { HostPromptEvent } from './prompt-types.js'
import type { SessionSnapshot } from './sessions.js'
import type { JsonValue } from './types.js'
import { SESSION_SNAPSHOT_VERSION, sessionSnapshot, snapshotCopy, snapshotID, snapshotObject } from './session-snapshot.js'
import { nativeHookRecord } from './hook-record-snapshot.js'

const SNAPSHOT_KIND = 'prompt-attachments'
const DIGEST = /^[a-f0-9]{64}$/
const MAX_SESSIONS = 1024
const MAX_TURNS = 10000
const MAX_ATTACHMENTS = 20000
const MAX_BYTES = 32 * 1024 * 1024
const SUCCESS_EXIT = 0
const BLOCKING_EXIT = 2
const MAX_EXIT = 255
const SIGNAL_EXIT = 1
const VERIFIED_SIGNALS = new Set<NodeJS.Signals>(['SIGINT', 'SIGTERM', 'SIGKILL'])
const NONBLOCKING_ERROR_PREFIX = 'Failed with non-blocking status code: '
const EMPTY_STDERR = 'No stderr output'
export interface PromptAttachment { readonly id: string; readonly created: number; readonly body: Readonly<Record<string, JsonValue>> }
interface Turn { readonly promptHash: string; readonly attachments: readonly PromptAttachment[]; readonly bytes: number }
interface State { readonly signal: AbortSignal; readonly turns: Map<string, Turn>; readonly cleanup: () => void }
function fail(code: string): never { throw new HostHookError(code, 'unsupported') }
const fingerprint = (text: string) => createHash('sha256').update(text).digest('hex')

export class PromptAttachments {
  private readonly states = new Map<string, State>()
  private turns = 0
  private attachments = 0
  private bytes = 0
  private disposed = false

  begin(session: SessionSnapshot): void { this.state(session) }

  admit(event: HostPromptEvent, session: SessionSnapshot, dispatch: DispatchResult): void {
    if (event.sessionID !== session.sessionID || event.messageID !== session.turnID || event.signal.aborted || session.turnSignal.aborted || dispatch.cancelled) fail('TRANSCRIPT_PROMPT_CANCELLED')
    if (dispatch.diagnostic.sessionID !== event.sessionID || dispatch.diagnostic.event !== event.event) fail('TRANSCRIPT_DISPATCH_MISMATCH')
    if (dispatch.actions.some(row => row.action.kind === 'block-event' || row.action.kind === 'stop-session')) fail('TRANSCRIPT_PROMPT_NOT_ADMITTED')
    const state = this.state(session)
    if (state.turns.has(event.messageID)) fail('TRANSCRIPT_PROMPT_ID_REUSED')
    const completedAt = Date.now()
    const toolUseID = randomUUID()
    const attachments: PromptAttachment[] = []
    for (const entry of [...dispatch.entries].filter(entry => entry.dialect === 'claude-code').sort((a, b) => a.completionOrder - b.completionOrder)) {
      const result = entry.result
      if (result.status === 'skipped') continue
      if (result.status !== 'success' && result.status !== 'failed') fail('TRANSCRIPT_HOOK_RESULT_UNSUPPORTED')
      const command = 'commandArtifact' in result ? result.commandArtifact : undefined
      const http = result.httpArtifact
      let exitCode: number | null | undefined
      if (http) {
        if (command || result.status !== 'success' || http.kind !== 'http' || !Number.isFinite(http.durationMs) || http.durationMs < 0 || !Number.isFinite(http.completedAt) || Number.isNaN(new Date(http.completedAt).getTime())) fail('TRANSCRIPT_HOOK_EXECUTION_UNAVAILABLE')
      } else {
        if (!command || typeof command.command !== 'string' || typeof command.stdout !== 'string' || typeof command.stderr !== 'string' || !Number.isFinite(command.durationMs) || command.durationMs < 0 || !Number.isFinite(command.completedAt) || Number.isNaN(new Date(command.completedAt).getTime())) fail('TRANSCRIPT_HOOK_EXECUTION_UNAVAILABLE')
        if (command.status === 'timeout') {
          if (result.status !== 'failed' || result.code !== 'EXECUTION_TIMEOUT' || result.actions.length || typeof command.timeoutMs !== 'number' || !Number.isFinite(command.timeoutMs) || command.timeoutMs <= 0) fail('TRANSCRIPT_HOOK_EXECUTION_UNAVAILABLE')
          attachments.push({ id: randomUUID(), created: command.completedAt, body: { type: 'attachment', attachment: {
            type: 'hook_cancelled', hookName: event.event, toolUseID, hookEvent: event.event,
            command: command.command, durationMs: command.durationMs, timedOut: true, timeoutMs: command.timeoutMs,
          } } })
          continue
        }
        if (command.status !== 'exited') fail('TRANSCRIPT_HOOK_EXECUTION_UNAVAILABLE')
        exitCode = command.exitCode
        if (command.signal !== null) {
          if (exitCode !== null || !VERIFIED_SIGNALS.has(command.signal)) fail('TRANSCRIPT_HOOK_EXECUTION_UNAVAILABLE')
          exitCode = SIGNAL_EXIT
        }
        if (typeof exitCode !== 'number' || !Number.isSafeInteger(exitCode) || exitCode < SUCCESS_EXIT || exitCode > MAX_EXIT || exitCode === BLOCKING_EXIT) fail('TRANSCRIPT_HOOK_EXECUTION_UNAVAILABLE')
        if (result.status === 'failed') {
          if (result.code !== 'COMMAND_FAILED' || exitCode === SUCCESS_EXIT || result.actions.length) fail('TRANSCRIPT_HOOK_RESULT_UNSUPPORTED')
          attachments.push({ id: randomUUID(), created: command.completedAt, body: { type: 'attachment', attachment: {
            type: 'hook_non_blocking_error', hookName: event.event, toolUseID, hookEvent: event.event,
            stderr: NONBLOCKING_ERROR_PREFIX + (command.stderr.trim() || EMPTY_STDERR), stdout: command.stdout,
            exitCode, command: command.command, durationMs: command.durationMs,
          } } })
          continue
        }
      }
      for (const action of result.actions) {
        let attachment: Record<string, JsonValue>
        let rendered: string | undefined
        if (action.kind === 'warning') {
          attachment = { type: 'hook_system_message', content: action.text, hookName: event.event, toolUseID, hookEvent: event.event }
        } else if (action.kind === 'context' && action.placement === 'model' && action.channel === 'additionalContext') {
          attachment = { type: 'hook_additional_context', content: [action.text], hookName: event.event, toolUseID: 'hook-' + randomUUID(), hookEvent: event.event }
          rendered = `<system-reminder>\n${event.event} hook additional context: ${action.text}\n</system-reminder>`
        } else if (action.kind === 'context' && action.placement === 'model' && action.channel === 'stdout') {
          if (!command || http || exitCode !== SUCCESS_EXIT) fail('TRANSCRIPT_HOOK_EFFECT_UNSUPPORTED')
          attachment = { type: 'hook_success', hookName: event.event, toolUseID, hookEvent: event.event, content: action.text, stdout: command.stdout, stderr: command.stderr, exitCode: command.exitCode, command: command.command, durationMs: command.durationMs }
          rendered = `<system-reminder>\n${event.event} hook success: ${action.text}\n</system-reminder>`
        } else fail('TRANSCRIPT_HOOK_EFFECT_UNSUPPORTED')
        attachments.push({ id: randomUUID(), created: attachment.type === 'hook_additional_context' ? completedAt : http?.completedAt ?? command!.completedAt, body: { type: 'attachment', attachment, ...(rendered === undefined ? {} : { rendered: [{ content: rendered }], renderedRole: 'system' }) } })
      }
    }
    const bytes = Buffer.byteLength(JSON.stringify([event.sessionID, event.messageID, attachments]))
    if (this.turns >= MAX_TURNS || this.attachments + attachments.length > MAX_ATTACHMENTS || this.bytes + bytes > MAX_BYTES) fail('TRANSCRIPT_PROMPT_LIMIT')
    state.turns.set(event.messageID, { promptHash: fingerprint(event.prompt), attachments, bytes })
    this.turns++
    this.attachments += attachments.length
    this.bytes += bytes
  }

  read(sessionID: string, messageID: string, prompt: string): readonly PromptAttachment[] {
    const state = this.states.get(sessionID)
    if (!state) return []
    const turn = state.turns.get(messageID)
    if (!turn || turn.promptHash !== fingerprint(prompt)) fail('TRANSCRIPT_PROMPT_HISTORY_UNAVAILABLE')
    return turn.attachments
  }

  discardPendingPrompt(session: SessionSnapshot, messageID: string): void {
    const state = this.states.get(session.sessionID), turn = state?.turns.get(messageID)
    if (!state || !turn) return
    if (state.signal !== session.signal) fail('SESSION_SNAPSHOT_OWNER_MISMATCH')
    state.turns.delete(messageID); this.turns--; this.attachments -= turn.attachments.length; this.bytes -= turn.bytes
  }

  snapshot(sessionID: string) {
    const state = this.states.get(sessionID)
    return snapshotCopy({ kind: SNAPSHOT_KIND, version: SESSION_SNAPSHOT_VERSION, sessionID, initialized: state !== undefined, turns: [...(state?.turns ?? [])].map(([messageID, turn]) => ({ messageID, promptHash: turn.promptHash, attachments: turn.attachments })) })
  }

  restore(session: SessionSnapshot, value: unknown): () => void {
    const input = sessionSnapshot(SNAPSHOT_KIND, value, session, ['initialized', 'turns'])
    if (this.disposed) fail('TRANSCRIPT_PROMPT_CANCELLED')
    if (this.states.has(session.sessionID)) throw new HostHookError('SESSION_SNAPSHOT_STATE_CONFLICT', 'unsupported')
    if (typeof input.initialized !== 'boolean' || !Array.isArray(input.turns) || !input.initialized && input.turns.length) throw new HostHookError('SESSION_SNAPSHOT_SCHEMA_INVALID', 'unsupported')
    if (this.turns + input.turns.length > MAX_TURNS || input.initialized && this.states.size >= MAX_SESSIONS) fail('TRANSCRIPT_PROMPT_LIMIT')
    const turns = new Map<string, Turn>(), identities = new Set<string>()
    let bytes = 0, attachments = 0
    for (const raw of input.turns) {
      const row = snapshotObject(raw, ['messageID', 'promptHash', 'attachments'])
      if (!snapshotID(row.messageID) || turns.has(row.messageID) || typeof row.promptHash !== 'string' || !DIGEST.test(row.promptHash) || !Array.isArray(row.attachments)) throw new HostHookError('SESSION_SNAPSHOT_SCHEMA_INVALID', 'unsupported')
      const records = row.attachments.map(value => nativeHookRecord(value, 'UserPromptSubmit'))
      for (const record of records) { if (identities.has(record.id)) throw new HostHookError('SESSION_SNAPSHOT_SCHEMA_INVALID', 'unsupported'); identities.add(record.id) }
      const charge = Buffer.byteLength(JSON.stringify([session.sessionID, row.messageID, records]))
      bytes += charge; attachments += records.length
      if (this.bytes + bytes > MAX_BYTES || this.attachments + attachments > MAX_ATTACHMENTS) fail('TRANSCRIPT_PROMPT_LIMIT')
      turns.set(row.messageID, { promptHash: row.promptHash, attachments: Object.freeze(records), bytes: charge })
    }
    if (session.signal.aborted) throw new HostHookError('SESSION_SNAPSHOT_CANCELLED', 'cancelled')
    if (!input.initialized) return () => {}
    const state = this.state(session)
    for (const [id, turn] of turns) state.turns.set(id, turn)
    this.bytes += bytes; this.turns += turns.size; this.attachments += attachments
    return () => { if (this.states.get(session.sessionID) === state) state.cleanup() }
  }

  dispose(): void { this.disposed = true; for (const state of this.states.values()) state.cleanup() }
  inspect() { return Object.freeze({ promptSessions: this.states.size, promptTurns: this.turns, promptAttachments: this.attachments, promptBytes: this.bytes }) }

  private state(session: SessionSnapshot): State {
    if (this.disposed || session.signal.aborted) fail('TRANSCRIPT_PROMPT_CANCELLED')
    let state = this.states.get(session.sessionID)
    if (state && state.signal !== session.signal) fail('TRANSCRIPT_SESSION_MISMATCH')
    if (!state) {
      if (this.states.size >= MAX_SESSIONS) fail('TRANSCRIPT_PROMPT_LIMIT')
      const cleanup = () => {
        const previous = this.states.get(session.sessionID)
        if (!previous) return
        for (const turn of previous.turns.values()) { this.turns--; this.attachments -= turn.attachments.length; this.bytes -= turn.bytes }
        this.states.delete(session.sessionID)
        session.signal.removeEventListener('abort', cleanup)
      }
      state = { signal: session.signal, turns: new Map(), cleanup }
      this.states.set(session.sessionID, state)
      session.signal.addEventListener('abort', cleanup, { once: true })
    }
    return state
  }
}
