import type { Dialect } from './contracts.js'
import type { HookAction } from './effect-types.js'
import type { CommandInvocation, ExecutionResult } from './runner.js'
import type { NativeEvent, Registration } from './types.js'

export interface BackgroundWork {
  readonly registration: Registration
  readonly event: NativeEvent
  readonly invocation: CommandInvocation
  readonly sessionSignal?: AbortSignal
}

export type BackgroundSubmission =
  | { readonly status: 'accepted'; readonly code: 'BACKGROUND_QUEUED'; readonly id: string }
  | { readonly status: 'failed' | 'unsupported'; readonly code: string }

export interface BackgroundExecutor {
  readonly supportsRewake: boolean
  enqueue(work: BackgroundWork): BackgroundSubmission
}

export interface BackgroundDelivery {
  readonly id: string
  readonly sourceID: string
  readonly sourceDigest?: string
  readonly registrationID: string
  readonly dialect: Dialect
  readonly event: string
  readonly hookName?: string
  readonly mode: 'safe-point' | 'wake'
  readonly actions: readonly HookAction[]
  readonly completion?: BackgroundCompletion
}

export interface BackgroundCompletion {
  readonly completedAt: number
  readonly execution: ExecutionResult
}

export interface BackgroundRecord {
  readonly jobID: string
  readonly sessionID: string
  readonly sourceID: string
  readonly sourceDigest?: string
  readonly registrationID: string
  readonly dialect: Dialect
  readonly event: string
  readonly phase: 'queued' | 'running' | 'completed' | 'delivery-failed' | 'wake-failed'
  readonly code: string
  readonly queuedMs: number
  readonly durationMs: number
  readonly outcome?: 'success' | 'failed' | 'cancelled'
  readonly invalidFields?: readonly string[]
}

export function isBackground(registration: Registration): boolean {
  if (registration.handler.type !== 'command') return false
  return registration.dialect === 'codex'
    ? registration.event !== 'SessionEnd' && registration.handler.async === true
    : registration.handler.async === true || registration.handler.asyncRewake === true
}
