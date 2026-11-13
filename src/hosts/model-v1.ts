import { realpath } from 'node:fs/promises'
import { V1ModelSessions } from './model-owned-v1.js'
import type { ModelSessionOptions } from './model-owned-v1.js'
export { MODEL_REQUEST_HEADER } from './model-owned-v1.js'
export type { V1ModelClient } from './model-owned-v1.js'

export class V1PromptModels extends V1ModelSessions {
  static async create(input: ModelSessionOptions): Promise<V1PromptModels> { const copied = { ...input }; return new V1PromptModels(copied, await realpath(copied.directory), 'prompt') }
}
