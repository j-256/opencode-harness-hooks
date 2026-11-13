import type { Dialect } from './contracts.js'
import type { JsonValue } from './types.js'
import type { ExecutionResult } from './runner.js'

export interface CommandArtifact extends ExecutionResult {
  readonly command: string
  readonly completedAt: number
  readonly timeoutMs: number | null
}

export interface HttpArtifact {
  readonly kind: 'http'
  readonly completedAt: number
  readonly durationMs: number
}

export interface NativeFailureArtifact {
  readonly type: 'hook_non_blocking_error'
  readonly completedAt: number
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
  readonly command?: string
  readonly durationMs?: number
}

export type PermissionDecision = 'allow' | 'deny' | 'ask' | 'defer'
export type HookAction =
  | { readonly kind: 'permission'; readonly decision: PermissionDecision; readonly reason: string }
  | { readonly kind: 'replace-input'; readonly input: Readonly<Record<string, JsonValue>> }
  | { readonly kind: 'replace-result'; readonly output: JsonValue; readonly rejectNested: boolean }
  | { readonly kind: 'continue-turn'; readonly text: string; readonly mode: 'feedback' | 'user'; readonly channel?: 'decision' | 'stderr' | 'additionalContext' }
  | { readonly kind: 'stop-session'; readonly reason: string }
  | { readonly kind: 'block-event'; readonly reason: string }
  | { readonly kind: 'context'; readonly text: string; readonly placement: 'model' | 'compaction'; readonly channel?: 'systemMessage' | 'additionalContext' | 'stdout' }
  | { readonly kind: 'feedback'; readonly text: string }
  | { readonly kind: 'warning'; readonly text: string }
  | { readonly kind: 'native-extension'; readonly name: string; readonly value: JsonValue }

export interface InterpretedOutput {
  readonly status: 'success' | 'failed'
  readonly code: string
  readonly actions: readonly HookAction[]
  readonly invalidFields?: readonly string[]
}

export interface HookEffect extends InterpretedOutput {
  readonly commandArtifact?: CommandArtifact
  readonly httpArtifact?: HttpArtifact
  readonly nativeFailureArtifact?: NativeFailureArtifact
  readonly diagnostic: {
    readonly sourceID: string
    readonly sourceDigest?: string
    readonly registrationID: string
    readonly dialect: Dialect
    readonly event: string
    readonly code: string
    readonly outcome: 'success' | 'failed'
    readonly durationMs: number
    readonly invalidFields?: readonly string[]
  }
}
