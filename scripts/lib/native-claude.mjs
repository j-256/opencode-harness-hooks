import { NativeProbeError, NATIVE_PROCESS_LIMITS, runNativeProcess } from './native-process.mjs'
export { NativeProbeError, NATIVE_PROCESS_LIMITS as NATIVE_CLAUDE_LIMITS } from './native-process.mjs'

export async function runNativeClaude(binary, args, text, cwd, env, limits = NATIVE_PROCESS_LIMITS) {
  const execution = await runNativeProcess(binary, args, text, cwd, env, limits)
  let result
  try { result = JSON.parse(execution.stdout) } catch { throw new NativeProbeError('NATIVE_RESULT_INVALID') }
  if (!result || typeof result !== 'object' || Array.isArray(result) || result.is_error !== false) throw new NativeProbeError('NATIVE_RESULT_INVALID')
  return result
}
