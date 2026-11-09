import type { HookAction, InterpretedOutput } from '../effect-types.js'
import type { JsonValue } from '../types.js'

export function record(value: unknown): value is Record<string, JsonValue> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function success(actions: readonly HookAction[] = []): InterpretedOutput {
  return { status: 'success', code: 'OK', actions }
}

export function failure(code: string, actions: readonly HookAction[] = []): InterpretedOutput {
  return { status: 'failed', code, actions }
}

export function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export function knownFields(value: Record<string, JsonValue>, fields: readonly string[]): boolean {
  return Object.keys(value).every(key => fields.includes(key))
}

export function optionalStrings(value: Record<string, JsonValue>, fields: readonly string[], nullable = false): boolean {
  return fields.every(key => value[key] === undefined || (nullable && value[key] === null) || typeof value[key] === 'string')
}

export function optionalBooleans(value: Record<string, JsonValue>, fields: readonly string[]): boolean {
  return fields.every(key => value[key] === undefined || typeof value[key] === 'boolean')
}
