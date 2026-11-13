import { snapshotJsonObject } from './bounded-json.js'
import { HostHookError } from './host-errors.js'
import type { SessionSnapshot } from './sessions.js'
import type { JsonValue } from './types.js'

export const SESSION_SNAPSHOT_VERSION = 1
const MAX_BYTES = 32 * 1024 * 1024
const MAX_ID_BYTES = 4096
const HEADER = ['kind', 'version', 'sessionID']
function fail(code: string): never { throw new HostHookError(code, code === 'SESSION_SNAPSHOT_CANCELLED' ? 'cancelled' : 'unsupported') }
function freeze<T>(value: T): T { if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value) } return value }
export function snapshotID(value: unknown): value is string { return typeof value === 'string' && !!value && !value.includes('\0') && Buffer.byteLength(value) <= MAX_ID_BYTES }
export function snapshotCopy<T>(value: T): T { return freeze(snapshotJsonObject({ value }, MAX_BYTES, kind => fail(kind === 'size' ? 'SESSION_SNAPSHOT_LIMIT' : 'SESSION_SNAPSHOT_SCHEMA_INVALID')).value.value as T) }
export function snapshotObject(value: unknown, fields: readonly string[]): Readonly<Record<string, JsonValue>> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== fields.length || Object.keys(value).some(key => !fields.includes(key))) fail('SESSION_SNAPSHOT_SCHEMA_INVALID')
  return value as Readonly<Record<string, JsonValue>>
}
export function sessionSnapshot(kind: string, value: unknown, session: SessionSnapshot, fields: readonly string[]): Readonly<Record<string, JsonValue>> {
  if (session.signal.aborted) fail('SESSION_SNAPSHOT_CANCELLED')
  const input = snapshotObject(snapshotCopy(value), [...HEADER, ...fields])
  if (input.version !== SESSION_SNAPSHOT_VERSION || input.kind !== kind) fail('SESSION_SNAPSHOT_SCHEMA_INVALID')
  if (input.sessionID !== session.sessionID) fail('SESSION_SNAPSHOT_OWNER_MISMATCH')
  return input
}
