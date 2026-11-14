import { snapshotJsonObject } from '../bounded-json.js'
import { EXECUTION_LIMITS } from '../runner.js'
import { HookServiceError } from '../service-execution.js'
import type { JsonValue } from '../types.js'
import { CLAUDE_SPECIFIC_OUTPUT_FIELDS } from './claude-output.js'
import { record } from './shared.js'

const STRING_FIELDS = ['stopReason', 'reason', 'systemMessage', 'terminalSequence'] as const
const DECISIONS = new Set(['approve', 'block'])

export function parseClaudeBackgroundObject(stdout: string): Record<string, unknown> | undefined {
  if (Buffer.byteLength(stdout) > EXECUTION_LIMITS.outputBytes) throw new HookServiceError('BACKGROUND_OUTPUT_LIMIT')
  try { const value: unknown = JSON.parse(stdout); return record(value) ? value : undefined } catch {}
  for (const line of stdout.split('\n')) {
    try { const value: unknown = JSON.parse(line); if (record(value)) return value } catch {}
  }
  return undefined
}

export function normalizeClaudeBackgroundResponse(raw: Record<string, unknown> | undefined): Readonly<Record<string, JsonValue>> | undefined {
  if (!raw || Object.hasOwn(raw, 'async')) return undefined
  const body = snapshotJsonObject(raw, EXECUTION_LIMITS.outputBytes, kind => { throw new HookServiceError(kind === 'size' ? 'BACKGROUND_OUTPUT_LIMIT' : 'BACKGROUND_OUTPUT_INVALID') }).value
  const response: Record<string, JsonValue> = Object.create(null)
  if (body.continue === false) response.continue = false
  if (body.suppressOutput === true) response.suppressOutput = true
  for (const key of STRING_FIELDS) if (typeof body[key] === 'string') response[key] = body[key]
  if (typeof body.decision === 'string' && DECISIONS.has(body.decision)) response.decision = body.decision
  if (record(body.hookSpecificOutput)) {
    const specific: Record<string, JsonValue> = Object.create(null)
    for (const key of CLAUDE_SPECIFIC_OUTPUT_FIELDS) {
      if (!Object.hasOwn(body.hookSpecificOutput, key)) continue
      const value = body.hookSpecificOutput[key]
      if (key === 'additionalContext' && typeof value !== 'string') continue
      specific[key] = value!
    }
    response.hookSpecificOutput = specific
  }
  return Object.keys(response).length ? response : undefined
}
