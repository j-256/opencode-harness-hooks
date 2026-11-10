import { open, realpath } from 'node:fs/promises'
import { constants } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve, extname, dirname, basename, join } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { HANDLER_TYPES, isHookEvent } from './contracts.js'
import type { Dialect } from './contracts.js'
import type { CodexConfigContext, CodexConfigLayer, JsonValue, LoadedCodexConfig, ExcludedRegistration, ExclusionReason, Handler, LoadedSource, Registration, SourceSpec } from './types.js'

const DEFAULT_SOURCE_BYTES = 1024 * 1024
const MAX_SOURCE_BYTES = 64 * DEFAULT_SOURCE_BYTES
const READ_CHUNK_BYTES = 64 * 1024
const SOURCE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/
const MAX_CONFIG_LAYERS = 64
const MAX_SETTINGS_DEPTH = 128
const CODEX_CONTEXT_FORMAT = 'opencode-harness-hooks/codex-config/v1'
const CODEX_STATE_FIELDS = Object.freeze(['enabled', 'trusted_hash', 'trusted_content_hash'])
interface SettingsSnapshot { readonly value: Readonly<Record<string, JsonValue>>; readonly text: string; readonly bytes: number }
const settingsSnapshots = new WeakMap<object, SettingsSnapshot>()
const sourceSnapshots = new WeakMap<object, number>()
const CODEX_SOURCE_EVENT_ORDER = Object.freeze([
  'PreModelRequest', 'PostModelRequest', 'PreToolUse', 'PermissionRequest', 'PostToolUse',
  'PreCompact', 'PostCompact', 'SessionStart', 'SessionEnd', 'UserPromptSubmit',
  'SubagentStart', 'SubagentStop', 'Stop', 'Interrupt',
])
const CODEX_SOURCE_EVENT_INDEX = new Map(CODEX_SOURCE_EVENT_ORDER.map((event, index) => [event, index]))
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

function snapshotSettings(value: unknown, maxBytes: number, sourceID: string): SettingsSnapshot {
  const visiting = new Set<object>()
  let bytes = 0
  const charge = (count: number) => { bytes += count; if (bytes > maxBytes) throw new SourceError('SOURCE_SIZE', sourceID) }
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
    if (depth > MAX_SETTINGS_DEPTH || item === undefined || typeof item === 'function' || typeof item === 'symbol' || typeof item === 'bigint' || typeof item === 'number' && !Number.isFinite(item)) throw new SourceError('SOURCE_SPEC', sourceID)
    if (typeof item === 'string') { string(item); return item }
    if (item === null || typeof item !== 'object') { charge(JSON.stringify(item).length); return item as JsonValue }
    if (visiting.has(item) || !Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item))) throw new SourceError('SOURCE_SPEC', sourceID)
    visiting.add(item)
    charge(2)
    let result: JsonValue
    if (Array.isArray(item)) {
      const array: JsonValue[] = []
      for (let index = 0; index < item.length; index++) {
        if (index) charge(1)
        const entry = Object.getOwnPropertyDescriptor(item, String(index))
        if (entry && !('value' in entry)) throw new SourceError('SOURCE_SPEC', sourceID)
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
        if (!('value' in entry)) throw new SourceError('SOURCE_SPEC', sourceID)
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
  if (!record(value)) throw new SourceError('SOURCE_SPEC', sourceID)
  const snapshot = visit(value, 0) as Readonly<Record<string, JsonValue>>
  const result = { value: snapshot, text: JSON.stringify(snapshot), bytes }
  settingsSnapshots.set(snapshot, result)
  return result
}

function metadataFields(value: unknown, allowed: readonly string[], sourceID: string): Record<string, unknown> {
  if (!record(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new SourceError('SOURCE_SPEC', sourceID)
  const fields: Record<string, unknown> = Object.create(null)
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue
    const entry = Object.getOwnPropertyDescriptor(value, key)!
    if (!entry.enumerable) continue
    if (!allowed.includes(key) || !('value' in entry)) throw new SourceError('SOURCE_SPEC', sourceID)
    fields[key] = entry.value
  }
  return fields
}

function snapshotCodexContext(value: CodexConfigContext, spec: SourceSpec, maxBytes: number, directory: string) {
  function fail(): never { throw new SourceError('SOURCE_SPEC', spec.id) }
  if (spec.dialect !== 'codex') fail()
  const fields = metadataFields(value, ['layers', 'sourceLayer', 'featureRequirements'], spec.id)
  const { layers: inputLayers, sourceLayer, featureRequirements: inputRequirements } = fields
  if (!Array.isArray(inputLayers)) fail()
  const layerCount = inputLayers.length
  if (layerCount > MAX_CONFIG_LAYERS) fail()
  if (sourceLayer !== undefined && (typeof sourceLayer !== 'number' || !Number.isSafeInteger(sourceLayer) || sourceLayer < 0 || sourceLayer >= layerCount)) fail()
  let requirements: CodexConfigContext['featureRequirements']
  if (inputRequirements !== undefined) {
    const { hooks } = metadataFields(inputRequirements, ['hooks'], spec.id)
    if (hooks !== undefined && typeof hooks !== 'boolean') fail()
    requirements = hooks === undefined ? {} : { hooks }
  }
  let inlineBytes = 0
  const layers: CodexConfigContext['layers'][number][] = []
  for (let index = 0; index < layerCount; index++) {
    const entry = Object.getOwnPropertyDescriptor(inputLayers, String(index))
    if (!entry || !('value' in entry)) fail()
    const { scope, path, settings: inputSettings, disabled } = metadataFields(entry.value, ['scope', 'path', 'settings', 'disabled'], spec.id)
    if (typeof scope !== 'string' || !['user', 'session', 'other'].includes(scope) || disabled !== undefined && typeof disabled !== 'boolean' || (path === undefined) === (inputSettings === undefined)) fail()
    if (path !== undefined && (typeof path !== 'string' || !path || extname(path).toLowerCase() !== '.toml' || scope === 'session')) fail()
    const settings = inputSettings === undefined ? undefined : snapshotSettings(inputSettings, maxBytes - inlineBytes, spec.id)
    inlineBytes += settings?.bytes ?? 0
    layers.push({ scope: scope as CodexConfigLayer['scope'], ...(disabled !== undefined ? { disabled } : {}), ...(path !== undefined ? { path: resolve(directory, path) } : { settings: settings!.value }) })
  }
  const context: CodexConfigContext = { layers, ...(sourceLayer !== undefined ? { sourceLayer } : {}), ...(requirements ? { featureRequirements: requirements } : {}) }
  return { context, inlineBytes }
}

export function snapshotSourceSpec(spec: SourceSpec, maxBytes = DEFAULT_SOURCE_BYTES, directory = process.cwd()): SourceSpec {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_SOURCE_BYTES) throw new SourceError('SOURCE_LIMIT', 'options')
  const captured = sourceSnapshots.get(spec)
  if (captured !== undefined) { if (captured > maxBytes) throw new SourceError('SOURCE_SIZE', spec.id); return spec }
  if (!record(spec)) throw new SourceError('SOURCE_ID', 'invalid')
  const capturedFields: Record<string, unknown> = Object.create(null)
  for (const key of ['id', 'dialect', 'path', 'projectRoot', 'pluginRoot', 'selection', 'codexConfig']) {
    const field = Object.getOwnPropertyDescriptor(spec, key)
    if (field && !('value' in field)) throw new SourceError('SOURCE_SPEC', typeof capturedFields.id === 'string' && SOURCE_ID.test(capturedFields.id) ? capturedFields.id : 'invalid')
    if (field) capturedFields[key] = field.value
  }
  spec = capturedFields as unknown as SourceSpec
  validateSpec(spec)
  const rawContext = spec.codexConfig
  const context = rawContext === undefined ? undefined : snapshotCodexContext(rawContext, spec, maxBytes, directory)
  const snapshot: SourceSpec = freeze({
    id: spec.id, dialect: spec.dialect, path: resolve(directory, spec.path),
    ...(spec.projectRoot !== undefined ? { projectRoot: resolve(directory, spec.projectRoot) } : {}),
    ...(spec.pluginRoot !== undefined ? { pluginRoot: resolve(directory, spec.pluginRoot) } : {}),
    ...(context ? { codexConfig: context.context } : {}),
    ...(spec.selection ? { selection: {
      ...(spec.selection.events ? { events: [...spec.selection.events] } : {}),
      ...(spec.selection.includeCommands ? { includeCommands: [...spec.selection.includeCommands] } : {}),
      ...(spec.selection.excludeCommands ? { excludeCommands: [...spec.selection.excludeCommands] } : {}),
    } } : {}),
  })
  sourceSnapshots.set(snapshot, context?.inlineBytes ?? 0)
  return snapshot
}

async function codexPath(path: string, sourceID: string): Promise<string> {
  const absolute = resolve(path)
  try { return join(await realpath(dirname(absolute)), basename(absolute)) } catch { throw new SourceError('SOURCE_READ', sourceID) }
}
function parseDocument(bytes: Buffer, toml: boolean, sourceID: string): Record<string, unknown> {
  let data: unknown
  try { const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); data = toml ? parseToml(text) : JSON.parse(text) } catch { throw new SourceError('SOURCE_PARSE', sourceID) }
  if (!record(data)) throw new SourceError('SOURCE_SCHEMA', sourceID)
  return data
}
interface CodexState { enabled?: boolean; trusted_hash?: string; trusted_content_hash?: string }
interface SettingsLayer { readonly scope: 'user' | 'session' | 'other'; readonly disabled: boolean; readonly data: Record<string, unknown> }
function nativeState(value: unknown): CodexState | undefined {
  if (!record(value)) return undefined
  if (value.enabled != null && typeof value.enabled !== 'boolean') return undefined
  for (const field of ['trusted_hash', 'trusted_content_hash']) if (value[field] != null && typeof value[field] !== 'string') return undefined
  return { ...(typeof value.enabled === 'boolean' ? { enabled: value.enabled } : {}), ...(typeof value.trusted_hash === 'string' ? { trusted_hash: value.trusted_hash } : {}), ...(typeof value.trusted_content_hash === 'string' ? { trusted_content_hash: value.trusted_content_hash } : {}) }
}
function mergeKnownFields(previous: unknown, incoming: unknown, fields: readonly string[]): unknown {
  if (!record(incoming)) return incoming
  const result: Record<string, unknown> = Object.create(null)
  for (const field of fields) {
    if (Object.hasOwn(incoming, field)) result[field] = incoming[field]
    else if (record(previous) && Object.hasOwn(previous, field)) result[field] = previous[field]
  }
  return result
}
function mergeStateTables(previous: unknown, incoming: unknown): unknown {
  if (!record(incoming)) return incoming
  const result: Record<string, unknown> = Object.create(null)
  if (record(previous)) for (const [key, value] of Object.entries(previous)) result[key] = value
  for (const [key, value] of Object.entries(incoming)) result[key] = mergeKnownFields(result[key], value, CODEX_STATE_FIELDS)
  return result
}
function mergeHooks(previous: unknown, incoming: unknown): unknown {
  if (!record(incoming)) return incoming
  const result: Record<string, unknown> = Object.create(null)
  const before = record(previous) ? previous.state : undefined
  if (Object.hasOwn(incoming, 'state')) result.state = mergeStateTables(before, incoming.state)
  else if (record(previous) && Object.hasOwn(previous, 'state')) result.state = before
  return result
}
function projectCodexSettings(layers: readonly SettingsLayer[], sourceID: string) {
  const states = new Map<string, CodexState>()
  let features: unknown
  let hooks: unknown
  for (const layer of layers) {
    if (!layer.disabled) {
      if (Object.hasOwn(layer.data, 'features')) features = mergeKnownFields(features, layer.data.features, ['hooks', 'codex_hooks'])
      if (Object.hasOwn(layer.data, 'hooks')) hooks = mergeHooks(hooks, layer.data.hooks)
    }
    const stateTable = record(layer.data.hooks) ? layer.data.hooks.state : undefined
    if (layer.scope === 'other' || !record(stateTable)) continue
    for (const [key, value] of Object.entries(stateTable)) {
      const state = nativeState(value), trimmed = key.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '')
      if (!state || !trimmed) continue
      states.set(trimmed, { ...states.get(trimmed), ...state })
    }
  }
  if (hooks !== undefined && !record(hooks) || features !== undefined && !record(features)) throw new SourceError('SOURCE_SCHEMA', sourceID)
  if (record(hooks) && Object.hasOwn(hooks, 'state') && (!record(hooks.state) || Object.values(hooks.state).some(value => nativeState(value) === undefined))) throw new SourceError('SOURCE_SCHEMA', sourceID)
  const effectiveFeatures = record(features) ? features : {}
  for (const key of ['hooks', 'codex_hooks']) if (effectiveFeatures[key] != null && typeof effectiveFeatures[key] !== 'boolean') throw new SourceError('SOURCE_SCHEMA', sourceID)
  return { enabled: (effectiveFeatures.hooks ?? effectiveFeatures.codex_hooks) !== false, states }
}

async function codexContext(spec: SourceSpec, sourcePath: string, bytes: Buffer, data: Record<string, unknown>, toml: boolean, maxBytes: number): Promise<{ enabled: boolean; states: ReadonlyMap<string, CodexState>; digest: string; codexConfig?: LoadedCodexConfig }> {
  const primaryDigest = createHash('sha256').update(bytes).digest('hex')
  if (spec.codexConfig === undefined) return { ...projectCodexSettings([{ scope: 'user', disabled: false, data: toml ? data : {} }], spec.id), digest: primaryDigest }
  const context = spec.codexConfig
  const layers: SettingsLayer[] = []
  const metadata: LoadedCodexConfig['layers'][number][] = []
  const snapshots = new Map<string, { bytes: Buffer; data: Record<string, unknown> }>()
  if (toml) snapshots.set(sourcePath, { bytes, data })
  let remaining = maxBytes - bytes.length - (sourceSnapshots.get(spec) ?? 0)
  for (const layer of context.layers) {
    let settings: Record<string, unknown>, digest: string, path: string | undefined
    if (layer.path !== undefined) {
      path = await codexPath(layer.path, spec.id)
      let snapshot = snapshots.get(path)
      if (!snapshot) {
        const content = await readSource({ ...spec, path }, remaining)
        remaining -= content.length
        snapshot = { bytes: content, data: parseDocument(content, true, spec.id) }
        snapshots.set(path, snapshot)
      }
      settings = snapshot.data
      digest = createHash('sha256').update(snapshot.bytes).digest('hex')
    } else {
      const snapshot = settingsSnapshots.get(layer.settings!)
      if (!snapshot) throw new SourceError('SOURCE_SPEC', spec.id)
      settings = layer.settings!
      digest = createHash('sha256').update(snapshot.text).digest('hex')
    }
    layers.push({ scope: layer.scope, disabled: layer.disabled === true, data: settings })
    metadata.push({ scope: layer.scope, disabled: layer.disabled === true, digest, ...(path ? { path } : {}) })
  }
  const primaryLayer = metadata.findIndex(layer => layer.path === sourcePath)
  if (toml && primaryLayer < 0) throw new SourceError('SOURCE_SPEC', spec.id)
  const owner = context.sourceLayer ?? (primaryLayer < 0 ? undefined : primaryLayer)
  const projection = projectCodexSettings(layers, spec.id)
  const loaded: LoadedCodexConfig = { layers: metadata, ...(context.sourceLayer !== undefined ? { sourceLayer: context.sourceLayer } : {}), ...(context.featureRequirements !== undefined ? { featureRequirements: { ...context.featureRequirements } } : {}) }
  const digest = createHash('sha256').update(JSON.stringify({ format: CODEX_CONTEXT_FORMAT, source: { path: sourcePath, digest: primaryDigest }, context: loaded })).digest('hex')
  return { ...projection, enabled: (context.featureRequirements?.hooks ?? projection.enabled) && (owner === undefined || !layers[owner]!.disabled), digest, codexConfig: loaded }
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
  const sourcePath = spec.dialect === 'codex' ? await codexPath(spec.path, spec.id) : resolve(spec.path)
  const bytes = await readSource({ ...spec, path: sourcePath }, maxBytes - (sourceSnapshots.get(spec) ?? 0))
  const codexToml = spec.dialect === 'codex' && extname(spec.path).toLowerCase() === '.toml'
  const data = parseDocument(bytes, codexToml, spec.id)
  if (!record(data) || (data.hooks !== undefined && !record(data.hooks))) throw new SourceError('SOURCE_SCHEMA', spec.id)
  if (spec.dialect === 'codex' && extname(spec.path).toLowerCase() !== '.toml' && (Object.keys(data).some(key => !['description', 'hooks'].includes(key)) || (data.description != null && typeof data.description !== 'string'))) throw new SourceError('SOURCE_SCHEMA', spec.id)
  if (data.disableAllHooks !== undefined && typeof data.disableAllHooks !== 'boolean') throw new SourceError('SOURCE_SCHEMA', spec.id)
  const codex = spec.dialect === 'codex' ? await codexContext(spec, sourcePath, bytes, data, codexToml, maxBytes) : undefined
  const enabled = codex ? codex.enabled : data.disableAllHooks !== true
  const roots = {
    ...(spec.projectRoot !== undefined ? { projectRoot: resolve(spec.projectRoot) } : {}),
    ...(spec.pluginRoot !== undefined ? { pluginRoot: resolve(spec.pluginRoot) } : {}),
  }
  const registrations: Registration[] = []
  const excluded: ExcludedRegistration[] = []
  const eventGroups = Object.entries(data.hooks ?? {})
  if (spec.dialect === 'codex') eventGroups.sort(([left], [right]) => (CODEX_SOURCE_EVENT_INDEX.get(left) ?? CODEX_SOURCE_EVENT_ORDER.length) - (CODEX_SOURCE_EVENT_INDEX.get(right) ?? CODEX_SOURCE_EVENT_ORDER.length))
  for (const [event, groups] of eventGroups) {
    if (event === 'state' && spec.dialect === 'codex') continue
    if (!isHookEvent(spec.dialect, event)) throw new SourceError('SOURCE_EVENT', spec.id)
    if (!Array.isArray(groups)) throw new SourceError('SOURCE_GROUP', spec.id)
    for (const [groupIndex, group] of groups.entries()) {
      if (!record(group) || !Array.isArray(group.hooks) || (group.matcher != null && typeof group.matcher !== 'string') || (group.matcher === null && spec.dialect !== 'codex')) throw new SourceError('SOURCE_GROUP', spec.id)
      for (const [handlerIndex, rawHandler] of group.hooks.entries()) {
        const handler = validateHandler(rawHandler, spec.id, spec.dialect)
        const id = `${spec.id}:${event}:${groupIndex}:${handlerIndex}`
        const nativeKey = `${sourcePath}:${event.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase()}:${groupIndex}:${handlerIndex}`
        const handlerDisabled = codex?.states.get(nativeKey)?.enabled === false
        const reason = exclusion(spec, enabled, event, handler) ?? (handlerDisabled ? 'handler-disabled' : undefined)
        if (reason) excluded.push({ id, event, type: handler.type, reason })
        else registrations.push({
          id, sourceID: spec.id, dialect: spec.dialect, event, groupIndex, handlerIndex, handler, ...roots,
          ...(typeof group.matcher === 'string' ? { matcher: group.matcher } : {}),
        })
      }
    }
  }
  return freeze({ id: spec.id, dialect: spec.dialect, path: sourcePath, digest: codex?.digest ?? createHash('sha256').update(bytes).digest('hex'), ...(codex?.codexConfig ? { codexConfig: codex.codexConfig } : {}), enabled, registrations, excluded, ...roots })
}

export async function loadSources(specs: readonly SourceSpec[], options: { readonly maxBytes?: number } = {}): Promise<readonly LoadedSource[]> {
  const maxBytes = options.maxBytes ?? DEFAULT_SOURCE_BYTES
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_SOURCE_BYTES) throw new SourceError('SOURCE_LIMIT', 'options')
  const identities = new Set<string>()
  const snapshots: SourceSpec[] = []
  for (const spec of specs) {
    const snapshot = snapshotSourceSpec(spec, maxBytes)
    if (identities.has(snapshot.id)) throw new SourceError('SOURCE_DUPLICATE_ID', snapshot.id)
    identities.add(snapshot.id)
    snapshots.push(snapshot)
  }
  return Object.freeze(await Promise.all(snapshots.map(spec => loadSource(spec, maxBytes))))
}
