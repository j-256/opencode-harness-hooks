import type { HostVersion } from './contracts.js'

export interface HostModelEvent {
  readonly host: HostVersion
  readonly sessionID: string
  readonly messageID: string
  readonly signal: AbortSignal
}

export interface ArtifactDiagnostic {
  readonly host: HostVersion
  readonly artifact: 'claude-transcript'
  readonly phase: 'model-request'
  readonly sessionID: string
  readonly messageID: string
  readonly code: string
  readonly outcome: 'unsupported' | 'cancelled' | 'failed'
  readonly durationMs: number
}
