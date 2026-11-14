import { resolve } from 'node:path'
import { loadSources, snapshotSourceSpec } from './config.js'
import { HOST_VERSIONS } from './contracts.js'
import type { Dialect, HostVersion } from './contracts.js'
import { HostHookError } from './host-errors.js'
import type { LoadedCodexConfig, SourceSpec } from './types.js'

const WIRED_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'UserPromptSubmit'])
const PERMISSION_MODES = new Set(['default', 'acceptEdits', 'plan', 'dontAsk', 'bypassPermissions', 'auto'])
const MAX_MODEL_BYTES = 4096
const MAX_MODEL_ALIASES = 128

export interface RuntimeOptions {
  readonly sources: readonly SourceSpec[]
  readonly reviewedDigests: Readonly<Record<string, string>>
  readonly permissionMode?: string
  readonly promptModel?: string
  readonly agentModel?: string
  readonly modelAliases?: Readonly<Record<string, string>>
}
export interface RuntimeReport {
  readonly host: HostVersion
  readonly hostContractVersion: string
  readonly equivalent: false
  readonly sources: readonly {
    readonly id: string
    readonly dialect: Dialect
    readonly digest: string
    readonly reviewed: boolean
    readonly enabled: boolean
    readonly codexConfig?: Omit<LoadedCodexConfig, 'layers'> & { readonly layers: readonly Omit<LoadedCodexConfig['layers'][number], 'path'>[] }
    readonly events: readonly string[]
    readonly unwiredEvents: readonly string[]
    readonly selected: readonly { readonly id: string; readonly event: string; readonly type: string }[]
    readonly excluded: readonly { readonly id: string; readonly event: string; readonly type: string; readonly reason: string }[]
  }[]
  readonly unresolved: readonly string[]
}

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }

function optionsCopy(value: unknown, directory: string): RuntimeOptions {
  if (!record(value) || Object.keys(value).some(key => !['sources', 'reviewedDigests', 'permissionMode', 'promptModel', 'agentModel', 'modelAliases'].includes(key)) || !Array.isArray(value.sources) || !value.sources.length || !record(value.reviewedDigests)) throw new HostHookError('PLUGIN_OPTIONS_INVALID', 'failed')
  if (value.permissionMode !== undefined && (typeof value.permissionMode !== 'string' || !PERMISSION_MODES.has(value.permissionMode))) throw new HostHookError('PLUGIN_OPTIONS_INVALID', 'failed')
  if (Object.values(value.reviewedDigests).some(digest => typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest))) throw new HostHookError('PLUGIN_OPTIONS_INVALID', 'failed')
  const sources = value.sources.map(source => {
    if (!record(source)) throw new HostHookError('PLUGIN_OPTIONS_INVALID', 'failed')
    return snapshotSourceSpec(source as unknown as SourceSpec, undefined, directory)
  })
  const validModel = (input: unknown): input is string => typeof input === 'string' && /^[^/\s\x00-\x1f]+\/.+$/u.test(input) && !/[\x00-\x1f]/u.test(input) && Buffer.byteLength(input) <= MAX_MODEL_BYTES
  if (value.agentModel !== undefined && !validModel(value.agentModel)) throw new HostHookError('PLUGIN_OPTIONS_INVALID', 'failed')
  if (value.promptModel !== undefined && !validModel(value.promptModel)) throw new HostHookError('PLUGIN_OPTIONS_INVALID', 'failed')
  let aliases: Readonly<Record<string, string>> | undefined
  if (value.modelAliases !== undefined) {
    if (!record(value.modelAliases) || Reflect.ownKeys(value.modelAliases).length > MAX_MODEL_ALIASES) throw new HostHookError('PLUGIN_OPTIONS_INVALID', 'failed')
    const copied: Record<string, string> = Object.create(null)
    for (const key of Reflect.ownKeys(value.modelAliases)) {
      const field = Object.getOwnPropertyDescriptor(value.modelAliases, key)
      if (typeof key !== 'string' || !key || Buffer.byteLength(key) > MAX_MODEL_BYTES || /[\x00-\x1f]/u.test(key) || !field || !('value' in field) || !validModel(field.value)) throw new HostHookError('PLUGIN_OPTIONS_INVALID', 'failed')
      copied[key] = field.value
    }
    aliases = Object.freeze(copied)
  }
  return { sources, reviewedDigests: { ...value.reviewedDigests } as Record<string, string>, ...(typeof value.permissionMode === 'string' ? { permissionMode: value.permissionMode } : {}), ...(typeof value.promptModel === 'string' ? { promptModel: value.promptModel } : {}), ...(typeof value.agentModel === 'string' ? { agentModel: value.agentModel } : {}), ...(aliases ? { modelAliases: aliases } : {}) }
}

export async function inspectSources(host: HostVersion, directory: string, inputOptions: unknown, availableEvents: readonly string[] = []) {
  if (!Object.hasOwn(HOST_VERSIONS, host) || typeof directory !== 'string' || !directory) throw new HostHookError('HOST_INPUT_INVALID', 'failed')
  directory = resolve(directory)
  const options = optionsCopy(inputOptions, directory)
  const sources = await loadSources(options.sources)
  const report: RuntimeReport = Object.freeze({
    host, hostContractVersion: HOST_VERSIONS[host], equivalent: false,
    sources: Object.freeze(sources.map(source => Object.freeze({
      id: source.id, dialect: source.dialect, digest: source.digest, reviewed: Object.hasOwn(options.reviewedDigests, source.id) && options.reviewedDigests[source.id] === source.digest, enabled: source.enabled,
      ...(source.codexConfig ? { codexConfig: Object.freeze({ ...source.codexConfig, layers: Object.freeze(source.codexConfig.layers.map(({ path: _path, ...layer }) => Object.freeze(layer))) }) } : {}),
      events: Object.freeze([...new Set(source.registrations.map(registration => registration.event))]),
      unwiredEvents: Object.freeze([...new Set(source.registrations.map(registration => registration.event).filter(event => !WIRED_EVENTS.has(event) && !availableEvents.includes(event)))]),
      selected: Object.freeze(source.registrations.map(registration => Object.freeze({ id: registration.id, event: registration.event, type: registration.handler.type }))),
      excluded: source.excluded,
    }))),
    unresolved: Object.freeze(['native-trust-and-reload', ...(sources.some(source => source.dialect === 'codex' && !source.codexConfig) ? ['codex-config-layer-state'] : []), ...(sources.some(source => source.codexConfig) ? ['codex-config-context-authentication'] : []), 'native-artifacts', 'permission-mode-projection', 'tool-result-projection', 'post-failure-mapping', 'non-tool-events', 'native-effects-and-lifecycle', 'migration-parity']),
  })
  return { options, sources, report }
}
