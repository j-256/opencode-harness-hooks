import type { HostVersion } from './contracts.js'
import type { DispatchResult } from './engine.js'
import type { EffectResolution } from './effects.js'
import type { JsonValue } from './types.js'

export interface ToolCall {
  readonly tool: string
  readonly sessionID: string
  readonly callID: string
  readonly messageID?: string
  readonly agent?: string
}
export interface HostToolEvent extends ToolCall {
  readonly host: HostVersion
  readonly event: 'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure'
  readonly toolInput: Readonly<Record<string, JsonValue>>
  readonly effectiveInput: Readonly<Record<string, JsonValue>>
  readonly signal: AbortSignal
  readonly result?: unknown
}
export interface HostToolDiagnostic {
  readonly code: string
  readonly outcome: 'unsupported' | 'failed' | 'cancelled'
  readonly sessionID: string
  readonly callID: string
  readonly event: HostToolEvent['event']
}
export interface ToolHostOptions {
  readonly dispatch: (event: HostToolEvent) => Promise<DispatchResult>
  readonly applyEffects?: (event: HostToolEvent, effects: EffectResolution) => Promise<void>
  readonly requestApproval?: (event: HostToolEvent, reason: string) => Promise<boolean>
  readonly preapprove?: (event: HostToolEvent) => Promise<void>
  readonly deferTool?: (event: HostToolEvent, reason: string) => Promise<void>
  readonly stopTurn?: (event: HostToolEvent, reason: string) => Promise<void>
  readonly diagnostic?: (record: HostToolDiagnostic) => Promise<void> | void
}
