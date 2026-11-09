import type { HostServices } from './host-services.js'
import { EXECUTION_LIMITS } from './runner.js'
import type { ExecutionResult } from './runner.js'
import { HookServiceError, runService } from './service-execution.js'
import { handlerTimeoutMs } from './timeouts.js'
import type { JsonValue, Registration } from './types.js'

export async function runHttp(registration: Registration, payload: Readonly<Record<string, JsonValue>>, host: HostServices): Promise<ExecutionResult> {
  const body = JSON.stringify(payload)
  const inputLimit = host.maxInputBytes ?? EXECUTION_LIMITS.inputBytes
  const outputLimit = host.maxOutputBytes ?? EXECUTION_LIMITS.outputBytes
  if (!Number.isSafeInteger(inputLimit) || inputLimit < 1 || !Number.isSafeInteger(outputLimit) || outputLimit < 1) throw new HookServiceError('EXECUTION_INVALID_INVOCATION')
  if (Buffer.byteLength(body) > inputLimit) throw new HookServiceError('EXECUTION_INPUT_LIMIT')
  const headers = new Headers({ 'Content-Type': 'application/json' })
  const allowed = new Set(registration.handler.allowedEnvVars as readonly string[] | undefined)
  for (const [name, value] of Object.entries(registration.handler.headers ?? {})) {
    headers.set(name, String(value).replace(/\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g, (_match, braced: string | undefined, bare: string | undefined) => {
      const key = braced ?? bare ?? ''
      return allowed.has(key) && Object.hasOwn(host.environment, key) ? host.environment[key] ?? '' : ''
    }))
  }
  return runService(handlerTimeoutMs(registration, host), host.signal, async signal => {
    let response: Response
    try { response = await fetch(String(registration.handler.url), { method: 'POST', headers, body, signal, redirect: 'manual' }) } catch { throw new HookServiceError('HTTP_REQUEST_FAILED') }
    try {
      if (!response.ok) throw new HookServiceError('HTTP_STATUS_FAILED')
      const reader = response.body?.getReader()
      const chunks: Uint8Array[] = []
      let bytes = 0
      if (reader) {
        try {
          while (true) {
            const { value, done } = await reader.read()
            if (done) break
            bytes += value.length
            if (bytes > outputLimit) throw new HookServiceError('EXECUTION_OUTPUT_LIMIT')
            chunks.push(value)
          }
        } finally {
          await reader.cancel().catch(() => {})
          reader.releaseLock()
        }
      }
      const stdout = Buffer.concat(chunks).toString('utf8')
      if (stdout.trim()) {
        let parsed: unknown
        try { parsed = JSON.parse(stdout) } catch { throw new HookServiceError('HTTP_OUTPUT_INVALID') }
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new HookServiceError('HTTP_OUTPUT_INVALID')
      }
      return { status: 'exited', exitCode: 0, signal: null, stdout, stderr: '', durationMs: 0 }
    } finally {
      if (!response.body?.locked) await response.body?.cancel().catch(() => {})
    }
  })
}
