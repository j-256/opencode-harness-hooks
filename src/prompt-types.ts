import type { HostVersion } from './contracts.js'

export interface HostPromptEvent {
  readonly host: HostVersion
  readonly event: 'UserPromptSubmit'
  readonly sessionID: string
  readonly messageID: string
  readonly prompt: string
  readonly signal: AbortSignal
}

export interface PromptDiagnostic {
  readonly host: HostVersion
  readonly event: 'UserPromptSubmit'
  readonly phase: 'admission' | 'layout' | 'parameters' | 'headers' | 'request'
  readonly sessionID?: string
  readonly messageID?: string
  readonly code: string
  readonly outcome: 'unsupported' | 'denied' | 'cancelled' | 'stopped' | 'deferred' | 'failed'
  readonly durationMs: number
}
