import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { CONTRACT_VERSIONS } from './contracts.js'
import type { CodexStopRegistrationIdentity } from './codex-stop-prompts.js'
import { HostHookError } from './host-errors.js'
import type { LoadedSource, Registration } from './types.js'

const MAX_ROWS = 10000
const MAX_GROUPS = 1024
const MAX_ID_BYTES = 4096
const MAX_BINDING_BYTES = 32 * 1024 * 1024
const STRING_CHUNK_UNITS = 4096
const NATIVE_EMPTY_COMMAND = /^\p{White_Space}*$/u
const DEFAULT_TIMEOUT_SECONDS = 600
const STOP_EVENT = 'stop'
const TRUST_STATUSES = new Set(['trusted', 'untrusted', 'modified'])
const SOURCE_TYPES = new Set(['user', 'project', 'sessionFlags'])

export interface CodexStopInventoryInput {
  readonly sources: readonly LoadedSource[]
  readonly nativeVersion: string
  readonly cwd: string
  readonly inventory: unknown
}

function fail(code = 'CODEX_INVENTORY_INVALID'): never { throw new HostHookError(code, 'unsupported') }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function field(value: unknown, key: string): unknown {
  if (!record(value)) return fail()
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (descriptor && !('value' in descriptor)) return fail()
  return descriptor?.value
}
function text(value: unknown, maxBytes = MAX_ID_BYTES): value is string { return typeof value === 'string' && !!value && value.length <= maxBytes && Buffer.byteLength(value) <= maxBytes && !value.includes('\0') }
function array(value: unknown, limit: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length > limit) return fail()
  return value
}
function entry(values: readonly unknown[], index: number): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(values, String(index))
  if (!descriptor || !('value' in descriptor)) return fail()
  return descriptor.value
}
function canonical(value: unknown, write: (text: string) => void): void {
  if (typeof value === 'string') {
    write('"')
    for (let start = 0; start < value.length;) {
      let end = Math.min(value.length, start + STRING_CHUNK_UNITS)
      const last = value.charCodeAt(end - 1), next = value.charCodeAt(end)
      if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end++
      write(JSON.stringify(value.slice(start, end)).slice(1, -1))
      start = end
    }
    write('"')
  } else if (Array.isArray(value)) {
    write('[')
    value.forEach((item, index) => { if (index) write(','); canonical(item, write) })
    write(']')
  } else if (record(value)) {
    write('{')
    Object.keys(value).sort().forEach((key, index) => { if (index) write(','); canonical(key, write); write(':'); canonical(value[key], write) })
    write('}')
  } else write(JSON.stringify(value))
}
function commandIdentity(registration: Registration, charge: (bytes: number) => void) {
  const handler = registration.handler
  if (handler.type !== 'command') return fail('CODEX_INVENTORY_HANDLER_UNSUPPORTED')
  if (typeof handler.command !== 'string' || handler.command.length > MAX_BINDING_BYTES || Buffer.byteLength(handler.command) > MAX_BINDING_BYTES || NATIVE_EMPTY_COMMAND.test(handler.command)) return fail('CODEX_INVENTORY_DECLARATION_UNAVAILABLE')
  const timeout = Math.max(1, handler.timeout ?? DEFAULT_TIMEOUT_SECONDS)
  if (!Number.isSafeInteger(timeout) || typeof handler.async !== 'undefined' && typeof handler.async !== 'boolean' || typeof handler.statusMessage !== 'undefined' && typeof handler.statusMessage !== 'string') return fail()
  const normalized = { type: 'command', command: handler.command, timeout, async: handler.async ?? false, ...(handler.statusMessage !== undefined ? { statusMessage: handler.statusMessage } : {}) }
  const hasher = createHash('sha256')
  canonical({ event_name: STOP_EVENT, hooks: [normalized] }, text => { charge(Buffer.byteLength(text)); hasher.update(text) })
  const hash = 'sha256:' + hasher.digest('hex')
  return { hash, timeout, command: handler.command, async: normalized.async, status: handler.statusMessage ?? null }
}

export function bindCodexStopInventory(input: CodexStopInventoryInput): readonly CodexStopRegistrationIdentity[] {
  if (input.nativeVersion !== CONTRACT_VERSIONS.codex) return fail('CODEX_INVENTORY_VERSION_UNSUPPORTED')
  if (process.platform === 'win32') return fail('CODEX_INVENTORY_PLATFORM_UNSUPPORTED')
  if (!text(input.cwd) || !isAbsolute(input.cwd)) return fail()
  const groups = array(field(input.inventory, 'data'), MAX_GROUPS)
  let group: unknown
  for (let index = 0; index < groups.length; index++) {
    const candidate = entry(groups, index)
    if (field(candidate, 'cwd') !== input.cwd) continue
    if (group !== undefined) return fail('CODEX_INVENTORY_AMBIGUOUS')
    group = candidate
  }
  if (group === undefined) return fail('CODEX_INVENTORY_DIRECTORY_MISMATCH')
  if (array(field(group, 'errors'), MAX_ROWS).length) return fail('CODEX_INVENTORY_NATIVE_CONFIG_REJECTED')
  const rows = array(field(group, 'hooks'), MAX_ROWS)
  const native = new Map<string, Record<string, unknown>>()
  const positions = new Set<number>()
  for (let index = 0; index < rows.length; index++) {
    const row = entry(rows, index), key = field(row, 'key'), path = field(row, 'sourcePath'), order = field(row, 'displayOrder')
    if (!record(row) || !text(key) || !text(path) || !isAbsolute(path) || typeof order !== 'number' || !Number.isSafeInteger(order) || order < 0 || native.has(key) || positions.has(order)) return fail('CODEX_INVENTORY_AMBIGUOUS')
    native.set(key, row)
    positions.add(order)
  }
  const sources = array(input.sources, MAX_ROWS)
  const sourceIDs = new Set<string>()
  const result: CodexStopRegistrationIdentity[] = []
  let registrations = 0
  let bytes = 0
  const charge = (count: number) => { bytes += count; if (bytes > MAX_BINDING_BYTES) return fail('CODEX_INVENTORY_LIMIT') }
  for (let sourceIndex = 0; sourceIndex < sources.length; sourceIndex++) {
    const source = entry(sources, sourceIndex) as LoadedSource
    if (source.dialect !== 'codex') continue
    if (!text(source.id) || !text(source.path) || !isAbsolute(source.path) || !/^[a-f0-9]{64}$/.test(source.digest) || sourceIDs.has(source.id)) return fail()
    sourceIDs.add(source.id)
    if (!source.enabled) continue
    const selected = array(source.registrations, MAX_ROWS)
    const registrationIDs = new Set<string>()
    for (let index = 0; index < selected.length; index++) {
      if (++registrations > MAX_ROWS) return fail('CODEX_INVENTORY_LIMIT')
      const registration = entry(selected, index) as Registration
      if (registration.event !== 'Stop' || registration.handler.type === 'prompt' || registration.handler.type === 'agent') continue
      if (!text(registration.id) || registrationIDs.has(registration.id) || registration.sourceID !== source.id || registration.dialect !== 'codex' || !Number.isSafeInteger(registration.groupIndex) || registration.groupIndex < 0 || !Number.isSafeInteger(registration.handlerIndex) || registration.handlerIndex < 0) return fail()
      registrationIDs.add(registration.id)
      const key = source.path + ':stop:' + registration.groupIndex + ':' + registration.handlerIndex
      const row = native.get(key)
      if (!row) return fail('CODEX_INVENTORY_REGISTRATION_MISSING')
      charge(Buffer.byteLength(source.path) + Buffer.byteLength(source.id) + Buffer.byteLength(registration.id))
      const expected = commandIdentity(registration, charge)
      if (field(row, 'sourcePath') !== source.path || field(row, 'eventName') !== STOP_EVENT || field(row, 'handlerType') !== 'command' || field(row, 'command') !== expected.command || field(row, 'currentHash') !== expected.hash || field(row, 'enabled') !== true || field(row, 'async') !== expected.async || field(row, 'matcher') !== null || field(row, 'timeoutSec') !== expected.timeout || field(row, 'statusMessage') !== expected.status || field(row, 'additionalContextLimit') !== null) return fail('CODEX_INVENTORY_DECLARATION_MISMATCH')
      const origin = field(row, 'source'), trust = field(row, 'trustStatus')
      if (field(row, 'isManaged') !== false || typeof origin !== 'string' || !SOURCE_TYPES.has(origin) || field(row, 'pluginId') !== null || field(row, 'environmentId') !== null || typeof trust !== 'string' || !TRUST_STATUSES.has(trust)) return fail('CODEX_INVENTORY_SOURCE_UNSUPPORTED')
      result.push(Object.freeze({ sourceID: source.id, sourceDigest: source.digest, sourcePath: source.path, registrationID: registration.id, ordinal: field(row, 'displayOrder') as number }))
    }
  }
  return Object.freeze(result)
}
