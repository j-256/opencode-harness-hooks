import { HostHookError } from '../host-errors.js'
import type { CodexTranscriptHistory, CodexTranscriptMessage, CodexTranscriptTool } from '../codex-transcript.js'

const BOOKKEEPING = new Set(['step-start', 'step-finish'])
const MAX_MESSAGES = 10000
function fail(code = 'CODEX_TRANSCRIPT_CONTENT_UNSUPPORTED'): never { throw new HostHookError(code, 'unsupported') }
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) fail(); return value as Record<string, unknown> }
function string(value: unknown): string { if (typeof value !== 'string') fail(); return value }
function time(value: unknown): number { if (typeof value !== 'number' || !Number.isFinite(value) || Number.isNaN(new Date(value).getTime())) fail(); return value }
function array(value: unknown): readonly unknown[] { if (!Array.isArray(value)) fail(); return value }

export function codexHistoryV1(info: unknown, input: unknown): CodexTranscriptHistory {
  const session = object(info), id = string(session.id), raw = array(input)
  if (!id || session.parentID !== undefined || raw.length > MAX_MESSAGES) fail()
  let turnID: string | undefined
  const seen = new Set<string>()
  const messages: CodexTranscriptMessage[] = raw.map(value => {
    const row = object(value), meta = object(row.info)
    if (meta.sessionID !== id) fail('CODEX_TRANSCRIPT_SESSION_MISMATCH')
    const role = meta.role, messageID = string(meta.id)
    if (!['user', 'assistant'].includes(String(role)) || !messageID || seen.has(messageID)) fail()
    seen.add(messageID)
    if (role === 'user') turnID = messageID
    if (!turnID || role === 'assistant' && meta.parentID !== turnID) fail('CODEX_TRANSCRIPT_TURN_UNAVAILABLE')
    const created = time(object(meta.time).created), content: (string | CodexTranscriptTool)[] = []
    for (const value of array(row.parts)) {
      const part = object(value)
      if (BOOKKEEPING.has(String(part.type))) continue
      if (part.type === 'text' && part.synthetic !== true && part.ignored !== true) content.push(string(part.text))
      else if (part.type === 'tool' && role === 'assistant') {
        const state = object(part.state), timing = object(state.time ?? {})
        if (!['pending', 'running', 'completed', 'error'].includes(String(state.status))) fail()
        const output = state.status === 'completed' ? string(state.output) : state.status === 'error' ? typeof state.error === 'string' ? state.error : string(object(state.error).message) : undefined
        content.push({ id: string(part.callID), name: string(part.tool), status: state.status as CodexTranscriptTool['status'], created: timing.start === undefined ? created : time(timing.start), ...(output !== undefined ? { output, completed: time(timing.end) } : {}) })
      } else fail()
    }
    return { id: messageID, turnID, role: role as 'user' | 'assistant', created, content }
  })
  return { id, messages }
}
