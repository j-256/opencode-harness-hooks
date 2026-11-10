import { resolve } from 'node:path'
import { loadSources } from './config.js'
import { HOST_VERSIONS } from './contracts.js'
import type { Dialect, HostVersion } from './contracts.js'
import { HostHookError } from './hosts/tools.js'
import type { SourceSpec } from './types.js'

const WIRED_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'UserPromptSubmit'])
const PERMISSION_MODES = new Set(['default', 'acceptEdits', 'plan', 'dontAsk', 'bypassPermissions', 'auto'])

export interface RuntimeOptions {
  readonly sources: readonly SourceSpec[]
  readonly reviewedDigests: Readonly<Record<string, string>>
  readonly permissionMode?: string
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
    readonly events: readonly string[]
    readonly unwiredEvents: readonly string[]
    readonly selected: readonly { readonly id: string; readonly event: string; readonly type: string }[]
    readonly excluded: readonly { readonly id: string; readonly event: string; readonly type: string; readonly reason: string }[]
  }[]
  readonly unresolved: readonly string[]
}

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }

function optionsCopy(value: unknown, directory: string): RuntimeOptions {
  if (!record(value) || Object.keys(value).some(key => !['sources', 'reviewedDigests', 'permissionMode'].includes(key)) || !Array.isArray(value.sources) || !value.sources.length || !record(value.reviewedDigests)) throw new HostHookError('PLUGIN_OPTIONS_INVALID', 'failed')
  if (value.permissionMode !== undefined && (typeof value.permissionMode !== 'string' || !PERMISSION_MODES.has(value.permissionMode))) throw new HostHookError('PLUGIN_OPTIONS_INVALID', 'failed')
  if (Object.values(value.reviewedDigests).some(digest => typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest))) throw new HostHookError('PLUGIN_OPTIONS_INVALID', 'failed')
  const sources = value.sources.map(source => {
    if (!record(source) || typeof source.path !== 'string') throw new HostHookError('PLUGIN_OPTIONS_INVALID', 'failed')
    for (const key of ['projectRoot', 'pluginRoot']) if (source[key] !== undefined && typeof source[key] !== 'string') throw new HostHookError('PLUGIN_OPTIONS_INVALID', 'failed')
    return { ...structuredClone(source), path: resolve(directory, source.path), ...(typeof source.projectRoot === 'string' ? { projectRoot: resolve(directory, source.projectRoot) } : {}), ...(typeof source.pluginRoot === 'string' ? { pluginRoot: resolve(directory, source.pluginRoot) } : {}) } as unknown as SourceSpec
  })
  return { sources, reviewedDigests: { ...value.reviewedDigests } as Record<string, string>, ...(typeof value.permissionMode === 'string' ? { permissionMode: value.permissionMode } : {}) }
}

export async function inspectSources(host: HostVersion, directory: string, inputOptions: unknown) {
  if (!Object.hasOwn(HOST_VERSIONS, host) || typeof directory !== 'string' || !directory) throw new HostHookError('HOST_INPUT_INVALID', 'failed')
  directory = resolve(directory)
  const options = optionsCopy(inputOptions, directory)
  const sources = await loadSources(options.sources)
  const report: RuntimeReport = Object.freeze({
    host, hostContractVersion: HOST_VERSIONS[host], equivalent: false,
    sources: Object.freeze(sources.map(source => Object.freeze({
      id: source.id, dialect: source.dialect, digest: source.digest, reviewed: Object.hasOwn(options.reviewedDigests, source.id) && options.reviewedDigests[source.id] === source.digest, enabled: source.enabled,
      events: Object.freeze([...new Set(source.registrations.map(registration => registration.event))]),
      unwiredEvents: Object.freeze([...new Set(source.registrations.map(registration => registration.event).filter(event => !WIRED_EVENTS.has(event)))]),
      selected: Object.freeze(source.registrations.map(registration => Object.freeze({ id: registration.id, event: registration.event, type: registration.handler.type }))),
      excluded: source.excluded,
    }))),
    unresolved: Object.freeze(['native-trust-and-reload', ...(sources.some(source => source.dialect === 'codex') ? ['codex-config-layer-state'] : []), 'native-artifacts', 'permission-mode-projection', 'tool-result-projection', 'post-failure-mapping', 'non-tool-events', 'native-effects-and-lifecycle', 'migration-parity']),
  })
  return { options, sources, report }
}
