import { spawn } from 'node:child_process'

export const NATIVE_CLAUDE_LIMITS = Object.freeze({ durationMs: 30000, graceMs: 1000, maxBytes: 2 * 1024 * 1024 })
export class NativeProbeError extends Error { constructor(code, status = 1) { super(code); this.status = status } }

export async function runNativeClaude(binary, args, text, cwd, env, limits = NATIVE_CLAUDE_LIMITS) {
  const child = spawn(binary, args, { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
  const output = []
  let bytes = 0
  let failure
  let escalation
  const kill = signal => { try { if (child.pid) process.kill(-child.pid, signal) } catch {} }
  const stop = code => { if (failure) return; failure = code; kill('SIGTERM'); escalation = setTimeout(() => kill('SIGKILL'), limits.graceMs) }
  const timer = setTimeout(() => stop('NATIVE_TIMEOUT'), limits.durationMs)
  child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > limits.maxBytes) stop('NATIVE_OUTPUT_LIMIT'); else output.push(chunk) })
  child.stderr.on('data', chunk => { bytes += chunk.length; if (bytes > limits.maxBytes) stop('NATIVE_OUTPUT_LIMIT') })
  child.stdin.on('error', () => {})
  child.stdin.end(text)
  try {
    const status = await new Promise((resolve, reject) => { child.once('error', () => reject(new NativeProbeError('NATIVE_START_FAILED'))); child.once('close', resolve) })
    if (failure) throw new NativeProbeError(failure)
    if (status !== 0) throw new NativeProbeError('NATIVE_EXECUTION_FAILED')
    let result
    try { result = JSON.parse(Buffer.concat(output).toString('utf8')) } catch { throw new NativeProbeError('NATIVE_RESULT_INVALID') }
    if (!result || typeof result !== 'object' || Array.isArray(result) || result.is_error !== false) throw new NativeProbeError('NATIVE_RESULT_INVALID')
    return result
  } finally { clearTimeout(timer); clearTimeout(escalation); kill('SIGKILL') }
}
