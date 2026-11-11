import { createHarnessHooks } from './plugin-v1.js'
import { rejectV1Activation } from './v1-rejection.js'
import { activationFailure } from './activation.js'

export type V1ServerHooks = Awaited<ReturnType<typeof createHarnessHooks>>

export async function initialize(...args: Parameters<typeof createHarnessHooks>): Promise<{ readonly hooks: V1ServerHooks; readonly rejected: boolean }> {
  try { return { hooks: await createHarnessHooks(...args), rejected: false } } catch (error) {
    const failure = activationFailure(error)
    if (!failure) throw error
    return { hooks: rejectV1Activation(args[0], failure), rejected: true }
  }
}

export async function server(...args: Parameters<typeof createHarnessHooks>): Promise<V1ServerHooks> {
  return (await initialize(...args)).hooks
}
