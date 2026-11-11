import { HostHookError } from '../host-errors.js'
import { SourceError } from '../config.js'

export function activationFailure(error: unknown): HostHookError | undefined {
  if (error instanceof HostHookError) return error
  if (error instanceof SourceError) return new HostHookError(error.code, 'unsupported', error.sourceID)
  return undefined
}
