import { open } from 'node:fs/promises'
import { constants } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve, extname } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { HANDLER_TYPES, isHookEvent } from './contracts.js'
import type { Dialect } from './contracts.js'
import type { ExcludedRegistration, ExclusionReason, Handler, LoadedSource, Registration, SourceSpec } from './types.js'

const DEFAULT_SOURCE_BYTES = 1024 * 1024
const MAX_SOURCE_BYTES = 64 * DEFAULT_SOURCE_BYTES
const READ_CHUNK_BYTES = 64 * 1024
const SOURCE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/
const CODEX_HANDLER_FIELDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  command: ['type', 'command', 'commandWindows', 'command_windows', 'timeout', 'async', 'statusMessage', 'additionalContextLimit'],
  mcp_tool: ['type', 'server', 'tool', 'input', 'timeout', 'statusMessage'], prompt: ['type'], agent: ['type'],
})

export class SourceError extends Error {
  constructor(readonly code: string, readonly sourceID: string) {
    super(`${code}: ${sourceID}`)
    this.name = 'SourceError'
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const nested of Object.values(value)) freeze(nested)
    Object.freeze(value)
  }
  return value
}

function validateSpec(spec: SourceSpec): void {
  if (!spec || typeof spec.id !== 'string' || !SOURCE_ID.test(spec.id)) throw new SourceError('SOURCE_ID', 'invalid')
  if (!['claude-code', 'codex'].includes(spec.dialect) || typeof spec.path !== 'string' || !spec.path) {
    throw new SourceError('SOURCE_SPEC', spec.id)
  }
  for (const path of [spec.projectRoot, spec.pluginRoot]) {
    if (path !== undefined && (typeof path !== 'string' || !path)) throw new SourceError('SOURCE_SPEC', spec.id)
  }
  if (spec.selection !== undefined) {
    if (!record(spec.selection)) throw new SourceError('SOURCE_SELECTION', spec.id)
    for (const [key, values] of Object.entries(spec.selection)) {
      if (!['events', 'includeCommands', 'excludeCommands'].includes(key) || !Array.isArray(values) || values.some(v => typeof v !== 'string')) {
        throw new SourceError('SOURCE_SELECTION', spec.id)
      }
      if (key === 'events' && values.some(event => !isHookEvent(spec.dialect, event))) throw new SourceError('SOURCE_SELECTION', spec.id)
    }
  }
}

async function readSource(spec: SourceSpec, maxBytes: number): Promise<Buffer> {
  let file
  try {
    file = await open(spec.path, constants.O_RDONLY | constants.O_NONBLOCK)
    const stat = await file.stat()
    if (!stat.isFile()) throw new SourceError('SOURCE_READ', spec.id)
    if (stat.size > maxBytes) throw new SourceError('SOURCE_SIZE', spec.id)
    const buffer = Buffer.alloc(Math.min(READ_CHUNK_BYTES, maxBytes + 1))
    const chunks: Buffer[] = []
    let total = 0
    while (true) {
      const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, maxBytes + 1 - total), null)
      if (bytesRead === 0) break
      total += bytesRead
      if (total > maxBytes) throw new SourceError('SOURCE_SIZE', spec.id)
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)))
    }
    return Buffer.concat(chunks)
  } catch (error) {
    if (error instanceof SourceError) throw error
    throw new SourceError('SOURCE_READ', spec.id)
  } finally {
    await file?.close()
  }
}

function codexHandler(value: Record<string, unknown>, sourceID: string): Record<string, unknown> {
  const fields = CODEX_HANDLER_FIELDS[String(value.type)]
  if (!fields) throw new SourceError('SOURCE_HANDLER', sourceID)
  const handler = Object.fromEntries(Object.entries(value).filter(([key]) => fields.includes(key)))
  for (const key of ['commandWindows', 'command_windows', 'timeout', 'statusMessage', 'additionalContextLimit']) if (handler[key] === null) delete handler[key]
  if (handler.commandWindows !== undefined && handler.command_windows !== undefined) throw new SourceError('SOURCE_HANDLER', sourceID)
  if (handler.command_windows !== undefined) { handler.commandWindows = handler.command_windows; delete handler.command_windows }
  if (handler.additionalContextLimit !== undefined && (!Number.isSafeInteger(handler.additionalContextLimit) || Number(handler.additionalContextLimit) < 0)) throw new SourceError('SOURCE_HANDLER', sourceID)
  const representable = (item: unknown): boolean => item !== null && (typeof item !== 'object' || Object.values(item).every(representable))
  if (handler.input !== undefined && !representable(handler.input)) throw new SourceError('SOURCE_HANDLER', sourceID)
  return handler
}

function validateHandler(raw: unknown, sourceID: string, dialect: Dialect): Handler {
  const fail = () => { throw new SourceError('SOURCE_HANDLER', sourceID) }
  if (!record(raw) || typeof raw.type !== 'string' || !HANDLER_TYPES.includes(raw.type)) return fail()
  const value = dialect === 'codex' ? codexHandler(raw, sourceID) : raw
  const skipped = dialect === 'codex' && (value.type === 'prompt' || value.type === 'agent')
  const required = skipped ? [] : value.type === 'command' ? ['command'] : value.type === 'http' ? ['url'] : value.type === 'mcp_tool' ? ['server', 'tool'] : ['prompt']
  for (const key of required) if (typeof value[key] !== 'string' || (dialect !== 'codex' && !(value[key] as string).trim())) fail()
  if (value.timeout !== undefined && (typeof value.timeout !== 'number' || !Number.isFinite(value.timeout) || (dialect === 'codex' ? !Number.isSafeInteger(value.timeout) || value.timeout < 0 : value.timeout <= 0))) fail()
  if (dialect === 'claude-code' && ['prompt', 'agent'].includes(String(value.type)) && value.model !== undefined && typeof value.model !== 'string') fail()
  if (dialect === 'claude-code' && value.type === 'prompt' && value.continueOnBlock !== undefined && typeof value.continueOnBlock !== 'boolean') fail()
  for (const key of ['statusMessage', 'commandWindows']) if (value[key] !== undefined && typeof value[key] !== 'string') fail()
  for (const key of ['args', 'allowedEnvVars']) {
    if (value[key] !== undefined && (!Array.isArray(value[key]) || value[key].some(item => typeof item !== 'string'))) fail()
  }
  for (const key of ['async', 'asyncRewake', 'once']) if (value[key] !== undefined && typeof value[key] !== 'boolean') fail()
  if (value.onFailure !== undefined && !['continue', 'block'].includes(String(value.onFailure))) fail()
  if (value.if !== undefined && typeof value.if !== 'string') fail()
  if (value.headers !== undefined && (!record(value.headers) || Object.values(value.headers).some(v => typeof v !== 'string'))) fail()
  if (value.input !== undefined && !record(value.input)) fail()
  // Clone only handler data, excluding unrelated source configuration
  return JSON.parse(JSON.stringify(value)) as Handler
}

function exclusion(spec: SourceSpec, enabled: boolean, event: string, handler: Handler): ExclusionReason | undefined {
  if (!enabled) return 'source-disabled'
  if (spec.selection?.events && !spec.selection.events.includes(event)) return 'event-excluded'
  if (handler.command !== undefined) {
    if (spec.selection?.excludeCommands?.includes(handler.command)) return 'command-excluded'
    if (spec.selection?.includeCommands && !spec.selection.includeCommands.includes(handler.command)) return 'command-not-included'
  } else if (spec.selection?.includeCommands) return 'command-not-included'
  return undefined
}

async function loadSource(spec: SourceSpec, maxBytes: number): Promise<LoadedSource> {
  const bytes = await readSource(spec, maxBytes)
  let data: unknown
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    data = spec.dialect === 'codex' && extname(spec.path).toLowerCase() === '.toml' ? parseToml(text) : JSON.parse(text)
  } catch {
    throw new SourceError('SOURCE_PARSE', spec.id)
  }
  if (!record(data) || (data.hooks !== undefined && !record(data.hooks))) throw new SourceError('SOURCE_SCHEMA', spec.id)
  if (spec.dialect === 'codex' && extname(spec.path).toLowerCase() !== '.toml' && (Object.keys(data).some(key => !['description', 'hooks'].includes(key)) || (data.description != null && typeof data.description !== 'string'))) throw new SourceError('SOURCE_SCHEMA', spec.id)
  if (data.disableAllHooks !== undefined && typeof data.disableAllHooks !== 'boolean') throw new SourceError('SOURCE_SCHEMA', spec.id)
  const codexFeature = record(data.features) ? data.features.hooks ?? data.features.codex_hooks : undefined
  const enabled = spec.dialect === 'claude-code' ? data.disableAllHooks !== true : codexFeature !== false
  const roots = {
    ...(spec.projectRoot !== undefined ? { projectRoot: resolve(spec.projectRoot) } : {}),
    ...(spec.pluginRoot !== undefined ? { pluginRoot: resolve(spec.pluginRoot) } : {}),
  }
  const registrations: Registration[] = []
  const excluded: ExcludedRegistration[] = []
  for (const [event, groups] of Object.entries(data.hooks ?? {})) {
    if (event === 'state' && spec.dialect === 'codex') continue
    if (!isHookEvent(spec.dialect, event)) throw new SourceError('SOURCE_EVENT', spec.id)
    if (!Array.isArray(groups)) throw new SourceError('SOURCE_GROUP', spec.id)
    for (const [groupIndex, group] of groups.entries()) {
      if (!record(group) || !Array.isArray(group.hooks) || (group.matcher != null && typeof group.matcher !== 'string') || (group.matcher === null && spec.dialect !== 'codex')) throw new SourceError('SOURCE_GROUP', spec.id)
      for (const [handlerIndex, rawHandler] of group.hooks.entries()) {
        const handler = validateHandler(rawHandler, spec.id, spec.dialect)
        const id = `${spec.id}:${event}:${groupIndex}:${handlerIndex}`
        const nativeKey = `${resolve(spec.path)}:${event.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase()}:${groupIndex}:${handlerIndex}`
        const states = record(data.hooks) && record(data.hooks.state) ? data.hooks.state : {}
        const state = states[nativeKey]
        const handlerDisabled = spec.dialect === 'codex' && record(state) && state.enabled === false
        const reason = exclusion(spec, enabled, event, handler) ?? (handlerDisabled ? 'handler-disabled' : undefined)
        if (reason) excluded.push({ id, event, type: handler.type, reason })
        else registrations.push({
          id, sourceID: spec.id, dialect: spec.dialect, event, groupIndex, handlerIndex, handler, ...roots,
          ...(typeof group.matcher === 'string' ? { matcher: group.matcher } : {}),
        })
      }
    }
  }
  return freeze({ id: spec.id, dialect: spec.dialect, path: resolve(spec.path), digest: createHash('sha256').update(bytes).digest('hex'), enabled, registrations, excluded, ...roots })
}

export async function loadSources(specs: readonly SourceSpec[], options: { readonly maxBytes?: number } = {}): Promise<readonly LoadedSource[]> {
  const maxBytes = options.maxBytes ?? DEFAULT_SOURCE_BYTES
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_SOURCE_BYTES) throw new SourceError('SOURCE_LIMIT', 'options')
  const identities = new Set<string>()
  const snapshots: SourceSpec[] = []
  for (const spec of specs) {
    validateSpec(spec)
    if (identities.has(spec.id)) throw new SourceError('SOURCE_DUPLICATE_ID', spec.id)
    identities.add(spec.id)
    snapshots.push({
      ...spec,
      ...(spec.selection ? { selection: {
        ...(spec.selection.events ? { events: [...spec.selection.events] } : {}),
        ...(spec.selection.includeCommands ? { includeCommands: [...spec.selection.includeCommands] } : {}),
        ...(spec.selection.excludeCommands ? { excludeCommands: [...spec.selection.excludeCommands] } : {}),
      } } : {}),
    })
  }
  return Object.freeze(await Promise.all(snapshots.map(spec => loadSource(spec, maxBytes))))
}
