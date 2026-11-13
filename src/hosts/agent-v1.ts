import { realpath } from 'node:fs/promises'
import { V1ModelSessions } from './model-owned-v1.js'
import type { ModelSessionOptions } from './model-owned-v1.js'
export { AGENT_VERDICT_TOOL } from './model-owned-v1.js'
export type { AgentExecution, AgentNestedTools } from './model-owned-v1.js'

export class V1AgentModels extends V1ModelSessions {
  static async create(input: ModelSessionOptions): Promise<V1AgentModels> { const copied = { ...input, ...(input.nested ? { nested: Object.freeze({ ...input.nested }) } : {}) }; return new V1AgentModels(copied, await realpath(copied.directory), 'agent') }
}
