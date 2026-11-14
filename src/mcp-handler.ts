import { expandClaudeMcp } from './claude-mcp-template.js'
import type { HostServices, McpHookRequest } from './host-services.js'
import { record } from './protocols/shared.js'
import { EXECUTION_LIMITS } from './runner.js'
import type { ExecutionResult } from './runner.js'
import { HookServiceError, runService, UnsupportedServiceError } from './service-execution.js'
import { handlerTimeoutMs } from './timeouts.js'
import type { JsonValue, NativeEvent, Registration } from './types.js'

const CLAUDE_OBSERVATIONAL_EVENTS = new Set(['InstructionsLoaded', 'Notification', 'StopFailure', 'SessionEnd', 'PostCompact', 'WorktreeRemove'])

export interface McpExecutionResult extends ExecutionResult {
  readonly sourceToolNamespace?: string
}
export class McpToolError extends HookServiceError { constructor(readonly stdout: string) { super('MCP_TOOL_FAILED') } }

function resolvePath(payload: Readonly<Record<string, JsonValue>>, path: string): JsonValue {
  let value: JsonValue = payload
  for (const key of path.split('.')) {
    if (!record(value) || !Object.hasOwn(value, key)) throw new HookServiceError('MCP_TEMPLATE_MISSING')
    value = value[key]!
  }
  return value
}

function expandTemplate(value: JsonValue, payload: Readonly<Record<string, JsonValue>>, consume: (length: number) => void): JsonValue {
  if (Array.isArray(value)) {
    consume(2 + Math.max(0, value.length - 1))
    return value.map(item => expandTemplate(item, payload, consume))
  }
  if (record(value)) {
    const entries = Object.entries(value)
    consume(2 + Math.max(0, entries.length - 1))
    return Object.fromEntries(entries.map(([key, item]) => {
      consume(JSON.stringify(key).length + 1)
      return [key, expandTemplate(item, payload, consume)]
    }))
  }
  if (typeof value !== 'string') { consume(JSON.stringify(value).length); return value }
  const matches = [...value.matchAll(/\$\{([^{}]+)\}/g)]
  const single = matches[0]
  if (matches.length === 1 && single?.[0] === value) {
    const resolved = resolvePath(payload, single[1]!)
    consume(JSON.stringify(resolved).length)
    return structuredClone(resolved)
  }
  consume(2)
  const chunks: string[] = []
  const add = (chunk: string) => { consume(JSON.stringify(chunk).length - 2); chunks.push(chunk) }
  let end = 0
  for (const match of matches) {
    add(value.slice(end, match.index))
    const resolved = resolvePath(payload, match[1]!)
    add(typeof resolved === 'string' ? resolved : JSON.stringify(resolved))
    end = match.index + match[0].length
  }
  add(value.slice(end))
  return chunks.join('')
}

export async function runMcp(registration: Registration, event: NativeEvent, payload: Readonly<Record<string, JsonValue>>, host: HostServices): Promise<McpExecutionResult> {
  const service = host.mcp
  if (!service) throw new UnsupportedServiceError('HOST_MCP_TOOL_UNAVAILABLE')
  const template = registration.handler.input ?? {}
  if (!record(template)) throw new HookServiceError('MCP_INPUT_INVALID')
  const inputLimit = host.maxInputBytes ?? EXECUTION_LIMITS.inputBytes
  const outputLimit = host.maxOutputBytes ?? EXECUTION_LIMITS.outputBytes
  if (!Number.isSafeInteger(inputLimit) || inputLimit < 1 || !Number.isSafeInteger(outputLimit) || outputLimit < 1) throw new HookServiceError('EXECUTION_INVALID_INVOCATION')
  const templateJSON = JSON.stringify(template)
  const payloadJSON = JSON.stringify(payload)
  if (Buffer.byteLength(templateJSON) > inputLimit || Buffer.byteLength(payloadJSON) > inputLimit) throw new HookServiceError('EXECUTION_INPUT_LIMIT')
  const timeoutMs = handlerTimeoutMs(registration, host)
  let remaining = inputLimit
  const consume = (length: number) => { remaining -= length; if (remaining < 0) throw new HookServiceError('EXECUTION_INPUT_LIMIT') }
  const input = registration.dialect === 'claude-code' ? expandClaudeMcp(templateJSON, payloadJSON, inputLimit, timeoutMs) : expandTemplate(template, payload, consume)
  if (!record(input)) throw new HookServiceError('MCP_INPUT_INVALID')
  if (Buffer.byteLength(JSON.stringify(input)) > inputLimit) throw new HookServiceError('EXECUTION_INPUT_LIMIT')
  const wallDeadline = registration.dialect === 'codex' ? Math.min(timeoutMs, host.remainingBudgetMs ?? timeoutMs) : timeoutMs
  const nativeThreadID = payload.session_id
  if (registration.dialect === 'codex' && (typeof nativeThreadID !== 'string' || !nativeThreadID)) throw new HookServiceError('MCP_NATIVE_SESSION_INVALID')
  const output = await runService(wallDeadline, host.signal, async signal => {
    const request: McpHookRequest = {
      dialect: registration.dialect, event: registration.event, sourceID: registration.sourceID, sessionID: event.sessionID, cwd: event.cwd,
      server: String(registration.handler.server), tool: String(registration.handler.tool), input, signal, timeoutMs,
      allowAuthentication: false,
      connectionPolicy: registration.dialect === 'codex' ? 'connected-only' : CLAUDE_OBSERVATIONAL_EVENTS.has(event.event) ? 'connect-cached-without-waiting' : 'wait-or-connect-cached',
      ...(registration.dialect === 'codex' ? { metadata: Object.freeze({ threadId: nativeThreadID as string }), allowToolApproval: false, allowHookRecursion: false } as const : {}),
    }
    try { return await service.execute(request) } catch (error) {
      if (error instanceof HookServiceError || error instanceof UnsupportedServiceError) throw error
      throw new HookServiceError('MCP_REQUEST_FAILED')
    }
  })
  if (!output || typeof output.text !== 'string' || (output.isError !== undefined && typeof output.isError !== 'boolean') || (output.sourceToolNamespace !== undefined && typeof output.sourceToolNamespace !== 'string')) throw new HookServiceError('MCP_OUTPUT_INVALID')
  if (Buffer.byteLength(output.text) > outputLimit) throw new HookServiceError('EXECUTION_OUTPUT_LIMIT')
  if (output.isError) throw new McpToolError(output.text)
  return { status: 'exited', exitCode: 0, signal: null, stdout: output.text, stderr: '', durationMs: 0, ...(output.sourceToolNamespace === undefined ? {} : { sourceToolNamespace: output.sourceToolNamespace }) }
}
