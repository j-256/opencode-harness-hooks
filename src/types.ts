import type { Dialect } from './contracts.js'

export type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue }
export type HandlerType = 'command' | 'http' | 'mcp_tool' | 'prompt' | 'agent'

export interface Handler {
  readonly type: HandlerType
  readonly command?: string
  readonly args?: readonly string[]
  readonly timeout?: number
  readonly [key: string]: JsonValue | undefined
}

export interface SourceSelection {
  readonly events?: readonly string[]
  readonly includeCommands?: readonly string[]
  readonly excludeCommands?: readonly string[]
}

export interface SourceSpec {
  readonly id: string
  readonly dialect: Dialect
  readonly path: string
  readonly projectRoot?: string
  readonly pluginRoot?: string
  readonly selection?: SourceSelection
}

export interface Registration {
  readonly id: string
  readonly sourceID: string
  readonly sourceDigest?: string
  readonly dialect: Dialect
  readonly event: string
  readonly groupIndex: number
  readonly handlerIndex: number
  readonly matcher?: string
  readonly handler: Handler
  readonly projectRoot?: string
  readonly pluginRoot?: string
}

export type ExclusionReason = 'source-disabled' | 'handler-disabled' | 'event-excluded' | 'command-excluded' | 'command-not-included'

export interface ExcludedRegistration {
  readonly id: string
  readonly event: string
  readonly type: HandlerType
  readonly reason: ExclusionReason
}

export interface LoadedSource {
  readonly id: string
  readonly dialect: Dialect
  readonly path: string
  readonly digest: string
  readonly enabled: boolean
  readonly projectRoot?: string
  readonly pluginRoot?: string
  readonly registrations: readonly Registration[]
  readonly excluded: readonly ExcludedRegistration[]
}

export interface NativeEvent {
  readonly event: string
  readonly sessionID: string
  readonly cwd: string
  readonly tool?: string
  readonly toolInput?: Readonly<Record<string, JsonValue>>
  readonly matcherValue?: string
  readonly data?: Readonly<Record<string, JsonValue>>
  readonly dialectData?: Readonly<Partial<Record<Dialect, Readonly<Record<string, JsonValue>>>>>
}
