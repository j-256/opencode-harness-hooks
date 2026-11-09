import type { JsonValue } from './types.js'

export interface SourceContext {
  readonly pluginData?: string
  readonly pluginOptions?: Readonly<Record<string, JsonValue>>
  readonly envFile?: string
  readonly shell?: { readonly program: string; readonly args: readonly string[] }
}

export interface HostServices {
  readonly environment: Readonly<NodeJS.ProcessEnv>
  readonly projectRoot: string
  readonly sessionDirectory?: string
  readonly sourceContext?: Readonly<Record<string, SourceContext>>
  readonly signal?: AbortSignal
  readonly remainingBudgetMs?: number
  readonly maxInputBytes?: number
  readonly maxOutputBytes?: number
  readonly evaluateCondition?: (rule: string, payload: Readonly<Record<string, JsonValue>>, signal?: AbortSignal) => Promise<boolean | undefined>
}
