import { spawn } from 'node:child_process'
import { basename } from 'node:path'
import { fileURLToPath } from 'node:url'

export const NATIVE_PROCESS_LIMITS = Object.freeze({ durationMs: 30000, graceMs: 1000, maxBytes: 2 * 1024 * 1024 })
const MAX_CONVERSATION_PROMPTS = 4
export class NativeProbeError extends Error { constructor(code, status = 1) { super(code); this.status = status } }

export function nativeCheckError(prefix, stage, error, moduleURL) {
  if (error instanceof NativeProbeError) return error
  const name = basename(fileURLToPath(moduleURL))
  const frame = error instanceof Error ? error.stack?.split('\n').find(line => line.trimStart().startsWith('at ') && line.includes(name + ':')) : undefined
  const line = frame && /:(\d+):\d+\)?$/.exec(frame)?.[1]
  return new NativeProbeError(prefix + ': ' + stage + (line ? ' check=' + name + ':' + line : ''))
}

export async function runNativeProcess(binary, args, text, cwd, env, limits = NATIVE_PROCESS_LIMITS) {
  return execute(binary, args, text, cwd, env, limits)
}

export async function runNativeConversation(binary, args, prompts, cwd, env, limits = NATIVE_PROCESS_LIMITS) {
  if (!Array.isArray(prompts) || !prompts.length || prompts.length > MAX_CONVERSATION_PROMPTS || [...prompts].some(text => typeof text !== 'string' || !text || Buffer.byteLength(text) > limits.maxBytes)) throw new NativeProbeError('NATIVE_INPUT_INVALID')
  return execute(binary, args, Object.freeze([...prompts]), cwd, env, limits)
}

async function execute(binary, args, input, cwd, env, limits) {
  const child = spawn(binary, args, { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
  const output = []
  const conversation = Array.isArray(input)
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let pending = ''
  let completed = 0
  let bytes = 0
  let failure
  let escalation
  const kill = signal => { try { if (child.pid) process.kill(-child.pid, signal) } catch {} }
  const stop = code => { if (failure) return; failure = code; kill('SIGTERM'); escalation = setTimeout(() => kill('SIGKILL'), limits.graceMs) }
  const timer = setTimeout(() => stop('NATIVE_TIMEOUT'), limits.durationMs)
  const send = index => child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: input[index] }, parent_tool_use_id: null, session_id: '' }) + '\n')
  child.stdout.on('data', chunk => {
    bytes += chunk.length
    if (bytes > limits.maxBytes) { stop('NATIVE_OUTPUT_LIMIT'); return }
    output.push(chunk)
    if (!conversation || failure) return
    try {
      pending += decoder.decode(chunk, { stream: true })
      while (pending.includes('\n') && !failure) {
        const at = pending.indexOf('\n'), line = pending.slice(0, at)
        pending = pending.slice(at + 1)
        if (!line.trim()) continue
        const row = JSON.parse(line)
        if (!row || typeof row !== 'object' || Array.isArray(row) || typeof row.type !== 'string') { stop('NATIVE_RESULT_INVALID'); return }
        if (row.type !== 'result') continue
        if (row.is_error !== false || completed >= input.length) { stop('NATIVE_RESULT_INVALID'); return }
        completed++
        if (completed < input.length) send(completed)
        else child.stdin.end()
      }
    } catch { stop('NATIVE_RESULT_INVALID') }
  })
  child.stderr.on('data', chunk => { bytes += chunk.length; if (bytes > limits.maxBytes) stop('NATIVE_OUTPUT_LIMIT') })
  child.stdin.on('error', () => {})
  if (conversation) send(0)
  else child.stdin.end(input)
  try {
    const status = await new Promise((resolve, reject) => { child.once('error', () => reject(new NativeProbeError('NATIVE_START_FAILED'))); child.once('close', resolve) })
    if (failure) throw new NativeProbeError(failure)
    if (status !== 0) throw new NativeProbeError('NATIVE_EXECUTION_FAILED')
    if (conversation) {
      try { pending += decoder.decode() } catch { throw new NativeProbeError('NATIVE_RESULT_INVALID') }
      if (completed !== input.length || pending.trim()) throw new NativeProbeError('NATIVE_RESULT_INVALID')
    }
    return { stdout: Buffer.concat(output).toString('utf8'), completedAt: Date.now() }
  } finally { clearTimeout(timer); clearTimeout(escalation); kill('SIGKILL') }
}
