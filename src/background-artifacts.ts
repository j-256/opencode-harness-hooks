import type { BackgroundDelivery } from './background-types.js'
import { HostHookError } from './host-errors.js'
import { normalizeClaudeBackgroundResponse, parseClaudeBackgroundObject } from './protocols/claude-background-output.js'
import { record } from './protocols/shared.js'
import type { JsonValue } from './types.js'
import { EXECUTION_LIMITS } from './runner.js'

export interface BackgroundArtifact { readonly created: number; readonly body: Readonly<Record<string, JsonValue>>; readonly model: readonly string[] }
function fail(code: string): never { throw new HostHookError(code, 'unsupported') }
function freeze<T>(value: T): T { if (value !== null && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) }; return value }

export function claudeBackgroundArtifact(delivery: BackgroundDelivery): BackgroundArtifact | undefined {
  const completion = delivery.completion
  if (delivery.dialect !== 'claude-code' || delivery.mode !== 'safe-point' || completion?.execution.status !== 'exited') return undefined
  const execution = completion.execution, response = normalizeClaudeBackgroundResponse(parseClaudeBackgroundObject(execution.stdout))
  if (!response) return undefined
  if (!Number.isSafeInteger(execution.processID) || execution.processID! < 1) fail('BACKGROUND_ARTIFACT_IDENTITY_UNAVAILABLE')
  if (!Number.isSafeInteger(completion.completedAt) || completion.completedAt < 0 || !Number.isSafeInteger(execution.exitCode) || execution.signal !== null || typeof execution.stderr !== 'string') fail('BACKGROUND_ARTIFACT_METADATA_INVALID')
  if (Buffer.byteLength(execution.stdout) + Buffer.byteLength(execution.stderr) > EXECUTION_LIMITS.outputBytes) fail('BACKGROUND_ARTIFACT_LIMIT')
  const specific = record(response.hookSpecificOutput) ? response.hookSpecificOutput : undefined
  const model = [response.systemMessage, specific?.additionalContext].filter((value): value is string => typeof value === 'string' && value.length > 0).map(text => `<system-reminder>\n${text}\n</system-reminder>`)
  const body: Record<string, JsonValue> = { type: 'attachment', attachment: { type: 'async_hook_response', processId: 'async_hook_' + execution.processID, hookName: delivery.event, hookEvent: delivery.event, response: { ...response }, stdout: execution.stdout, stderr: execution.stderr, exitCode: execution.exitCode! }, ...(model.length ? { rendered: model.map(content => ({ content })), renderedRole: 'system' } : {}) }
  return freeze({ created: completion.completedAt, body, model })
}
