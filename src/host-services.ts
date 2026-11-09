import type { BackgroundExecutor } from './background-types.js'
import type { Dialect } from './contracts.js'
import type { JsonValue } from './types.js'

export interface SourceContext {
  readonly pluginData?: string
  readonly pluginOptions?: Readonly<Record<string, JsonValue>>
  readonly envFile?: string
  readonly shell?: { readonly program: string; readonly args: readonly string[] }
}

export interface ModelHookRequest {
  readonly prompt: string
  readonly sessionID: string
  readonly cwd: string
  readonly model?: string
  readonly signal: AbortSignal
}

export interface AgentHookRequest extends ModelHookRequest {
  readonly maxTurns: number
}

export interface McpHookRequest {
  readonly dialect: Dialect
  readonly event: string
  readonly sourceID: string
  readonly sessionID: string
  readonly cwd: string
  readonly server: string
  readonly tool: string
  readonly input: Readonly<Record<string, JsonValue>>
  readonly signal: AbortSignal
  readonly timeoutMs: number
  readonly connectionPolicy: 'connected-only' | 'wait-or-connect-cached' | 'connect-cached-without-waiting'
  readonly allowAuthentication: false
  readonly allowToolApproval?: false
  readonly allowHookRecursion?: false
}

export interface McpHookOutput {
  readonly text: string
  readonly isError?: boolean
  readonly sourceToolNamespace?: string
}

export interface McpHookService {
  readonly timeoutAccounting: 'wall' | 'exclude-elicitation'
  readonly execute: (request: McpHookRequest) => Promise<McpHookOutput>
}

export interface HostServices {
  readonly environment: Readonly<NodeJS.ProcessEnv>
  readonly projectRoot: string
  readonly sessionDirectory?: string
  readonly sourceContext?: Readonly<Record<string, SourceContext>>
  readonly signal?: AbortSignal
  readonly sessionSignal?: AbortSignal
  readonly background?: BackgroundExecutor
  readonly remainingBudgetMs?: number
  readonly maxInputBytes?: number
  readonly maxOutputBytes?: number
  readonly mcp?: McpHookService
  readonly evaluatePrompt?: (request: ModelHookRequest) => Promise<unknown>
  readonly runAgent?: (request: AgentHookRequest) => Promise<unknown>
  readonly evaluateCondition?: (rule: string, payload: Readonly<Record<string, JsonValue>>, signal?: AbortSignal) => Promise<boolean | undefined>
}
