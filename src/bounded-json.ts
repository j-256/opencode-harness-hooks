import type { JsonValue } from './types.js'

const MAX_JSON_DEPTH = 128
export interface BoundedJsonSnapshot { readonly value: Readonly<Record<string, JsonValue>>; readonly text: string; readonly bytes: number }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }

export function snapshotJsonObject(value: unknown, maxBytes: number, fail: (kind: 'size' | 'schema') => never): BoundedJsonSnapshot {
  const visiting = new Set<object>()
  let bytes = 0
  const charge = (count: number) => { bytes += count; if (bytes > maxBytes) fail('size') }
  const string = (text: string) => {
    charge(2)
    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index)
      if (code === 0x22 || code === 0x5c || [0x08, 0x09, 0x0a, 0x0c, 0x0d].includes(code)) charge(2)
      else if (code < 0x20) charge(6)
      else if (code < 0x80) charge(1)
      else if (code < 0x800) charge(2)
      else if (code >= 0xd800 && code <= 0xdbff && text.charCodeAt(index + 1) >= 0xdc00 && text.charCodeAt(index + 1) <= 0xdfff) { charge(4); index++ }
      else charge(code >= 0xd800 && code <= 0xdfff ? 6 : 3)
    }
  }
  const visit = (item: unknown, depth: number): JsonValue => {
    if (depth > MAX_JSON_DEPTH || item === undefined || typeof item === 'function' || typeof item === 'symbol' || typeof item === 'bigint' || typeof item === 'number' && !Number.isFinite(item)) return fail('schema')
    if (typeof item === 'string') { string(item); return item }
    if (item === null || typeof item !== 'object') { charge(JSON.stringify(item).length); return item as JsonValue }
    if (visiting.has(item) || !Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item))) return fail('schema')
    visiting.add(item)
    charge(2)
    let result: JsonValue
    if (Array.isArray(item)) {
      const array: JsonValue[] = []
      for (let index = 0; index < item.length; index++) {
        if (index) charge(1)
        const entry = Object.getOwnPropertyDescriptor(item, String(index))
        if (entry && !('value' in entry)) return fail('schema')
        array.push(visit(entry ? entry.value : null, depth + 1))
      }
      result = array
    } else {
      const object: Record<string, JsonValue> = Object.create(null)
      let first = true
      for (const key in item) {
        if (!Object.hasOwn(item, key)) continue
        const entry = Object.getOwnPropertyDescriptor(item, key)!
        if (!entry.enumerable) continue
        if (!('value' in entry)) return fail('schema')
        if (!first) charge(1)
        first = false
        string(key)
        charge(1)
        object[key] = visit(entry.value, depth + 1)
      }
      result = object
    }
    visiting.delete(item)
    return result
  }
  if (!record(value)) return fail('schema')
  const snapshot = visit(value, 0) as Readonly<Record<string, JsonValue>>
  const result = { value: snapshot, text: JSON.stringify(snapshot), bytes }
  return result
}

