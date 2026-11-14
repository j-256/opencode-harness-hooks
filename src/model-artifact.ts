import { HookServiceError } from './service-execution.js'

export const PROMPT_MODEL_KIND = 'prompt-model'
export const AGENT_MODEL_KIND = 'agent-model'
export const AGENT_MODEL_STATUS = Object.freeze({ SUCCESS: 'success', TIMEOUT: 'timeout', TURN_LIMIT: 'turn-limit', INCOMPLETE: 'incomplete', API_ERROR: 'api-error' } as const)
export const PROMPT_MODEL_STATUS = Object.freeze({ SUCCESS: 'success', INVALID: 'invalid-output', TIMEOUT: 'timeout', API_ERROR: 'api-error' } as const)
export interface PromptModelArtifact {
  readonly kind: typeof PROMPT_MODEL_KIND
  readonly status: typeof PROMPT_MODEL_STATUS[keyof typeof PROMPT_MODEL_STATUS]
  readonly prompt: string
  readonly stdout: string
  readonly stderr?: string
  readonly completedAt: number
  readonly durationMs: number
}

export interface AgentModelArtifact {
  readonly kind: typeof AGENT_MODEL_KIND
  readonly status: typeof AGENT_MODEL_STATUS[keyof typeof AGENT_MODEL_STATUS]
  readonly completedAt: number
  readonly durationMs: number
}
export type ModelArtifact = PromptModelArtifact | AgentModelArtifact

export class ModelOutputError extends HookServiceError {
  constructor(readonly stdout: string) { super('MODEL_OUTPUT_INVALID'); if (typeof stdout !== 'string') throw new HookServiceError('MODEL_OUTPUT_INVALID'); this.name = 'ModelOutputError' }
}

export class ModelApiError extends HookServiceError {
  constructor(readonly stderr: string) { super('MODEL_REQUEST_FAILED'); if (typeof stderr !== 'string') throw new HookServiceError('MODEL_REQUEST_FAILED'); this.name = 'ModelApiError' }
}
