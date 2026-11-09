import { Script } from 'node:vm'
import { HookServiceError } from './service-execution.js'
import type { JsonValue } from './types.js'

const MAX_SCRIPT_TIMEOUT_MS = 2 ** 31 - 1
// Keep native prototype lookups separate from mutable host prototypes
const TEMPLATE_SCRIPT = new Script(String.raw`
(() => {
  const payload = JSON.parse(payloadJSON)
  let remaining = outputLimit
  const consume = length => {
    remaining -= length
    if (remaining < 0) throw 'MCP_INPUT_LIMIT'
  }
  const resolve = path => {
    let value = payload
    for (const field of path.split('.')) value = value == null ? undefined : value[field]
    if (value == null) return ''
    return typeof value === 'object' ? JSON.stringify(value) : String(value)
  }
  const string = value => {
    consume(2)
    const chunks = []
    let end = 0
    const add = chunk => {
      consume(JSON.stringify(chunk).length - 2)
      chunks.push(chunk)
    }
    for (const match of value.matchAll(/\$\{([^{}]+)\}/g)) {
      add(value.slice(end, match.index))
      add(resolve(match[1]))
      end = match.index + match[0].length
    }
    add(value.slice(end))
    return chunks.join('')
  }
  const visit = value => {
    if (typeof value === 'string') return string(value)
    if (Array.isArray(value)) {
      consume(2 + Math.max(0, value.length - 1))
      return value.map(visit)
    }
    if (value !== null && typeof value === 'object') {
      const entries = Object.entries(value)
      consume(2 + Math.max(0, entries.length - 1))
      return Object.fromEntries(entries.map(([key, item]) => {
        consume(JSON.stringify(key).length + 1)
        return [key, visit(item)]
      }))
    }
    consume(JSON.stringify(value).length)
    return value
  }
  return JSON.stringify(visit(JSON.parse(templateJSON)))
})()
`)

export function expandClaudeMcp(templateJSON: string, payloadJSON: string, outputLimit: number, timeoutMs: number): Record<string, JsonValue> {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new HookServiceError('EXECUTION_INVALID_INVOCATION')
  try {
    const output = TEMPLATE_SCRIPT.runInNewContext({ templateJSON, payloadJSON, outputLimit }, { timeout: Math.max(1, Math.min(MAX_SCRIPT_TIMEOUT_MS, Math.ceil(timeoutMs))) }) as string
    return JSON.parse(output) as Record<string, JsonValue>
  } catch (error) {
    if (error === 'MCP_INPUT_LIMIT') throw new HookServiceError('EXECUTION_INPUT_LIMIT')
    if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') throw new HookServiceError('EXECUTION_TIMEOUT')
    throw new HookServiceError('MCP_TEMPLATE_FAILED')
  }
}
