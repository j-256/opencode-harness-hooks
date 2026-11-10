import { spawn } from 'node:child_process'
import { basename } from 'node:path'
import { fileURLToPath } from 'node:url'

export const NATIVE_PROCESS_LIMITS = Object.freeze({ durationMs: 30000, graceMs: 1000, maxBytes: 2 * 1024 * 1024 })
const MAX_CONVERSATION_PROMPTS = 4
const INTERRUPT_REQUEST_ID = 'native-fixture-interrupt'
export class NativeProbeError extends Error { constructor(code, status = 1, systemCode) { super(code); this.status = status; if (systemCode !== undefined) this.systemCode = systemCode } }

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
  return execute(binary, args, conversationInput(prompts, limits), cwd, env, limits)
}

export async function runNativeInterruptedConversation(binary, args, prompts, signal, cwd, env, limits = NATIVE_PROCESS_LIMITS) {
  const input = conversationInput(prompts, limits)
  if (!signal || typeof signal.addEventListener !== 'function' || signal.aborted || input.length < 2) throw new NativeProbeError('NATIVE_INPUT_INVALID')
  return execute(binary, args, input, cwd, env, limits, signal)
}

function conversationInput(prompts, limits) {
  if (!Array.isArray(prompts) || !prompts.length || prompts.length > MAX_CONVERSATION_PROMPTS || [...prompts].some(text => typeof text !== 'string' || !text || Buffer.byteLength(text) > limits.maxBytes)) throw new NativeProbeError('NATIVE_INPUT_INVALID')
  return Object.freeze([...prompts])
}

async function execute(binary, args, input, cwd, env, limits, interruptSignal) {
  const child = spawn(binary, args, { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
  const output = []
  const conversation = Array.isArray(input)
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let pending = ''
  let completed = 0
  let dispatched = 0
  let sentAt
  let acknowledgedAt
  let bytes = 0
  let failure
  let escalation
  const kill = signal => { try { if (child.pid) process.kill(-child.pid, signal) } catch {} }
  const stop = code => { if (failure) return; failure = code; kill('SIGTERM'); escalation = setTimeout(() => kill('SIGKILL'), limits.graceMs) }
  const timer = setTimeout(() => stop('NATIVE_TIMEOUT'), limits.durationMs)
  const send = index => { dispatched = index + 1; child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: input[index] }, parent_tool_use_id: null, session_id: '' }) + '\n') }
  const advance = () => {
    if (completed === input.length) child.stdin.end()
    else if (dispatched <= completed && (!interruptSignal || acknowledgedAt !== undefined)) send(completed)
  }
  const interrupt = () => {
    if (failure) return
    if (completed || sentAt !== undefined) { stop('NATIVE_CONTROL_INVALID'); return }
    sentAt = Date.now()
    child.stdin.write(JSON.stringify({ type: 'control_request', request_id: INTERRUPT_REQUEST_ID, request: { subtype: 'interrupt' } }) + '\n')
  }
  interruptSignal?.addEventListener('abort', interrupt, { once: true })
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
        if (interruptSignal && row.type === 'control_response') {
          if (sentAt === undefined || acknowledgedAt !== undefined || row.response?.request_id !== INTERRUPT_REQUEST_ID || row.response.subtype !== 'success') { stop('NATIVE_CONTROL_INVALID'); return }
          acknowledgedAt = Date.now()
          advance()
          continue
        }
        if (row.type !== 'result') continue
        if (row.is_error !== false || completed >= input.length) { stop('NATIVE_RESULT_INVALID'); return }
        completed++
        if (interruptSignal && sentAt === undefined) { stop('NATIVE_CONTROL_NOT_TRIGGERED'); return }
        advance()
      }
    } catch { stop('NATIVE_RESULT_INVALID') }
  })
  child.stderr.on('data', chunk => { bytes += chunk.length; if (bytes > limits.maxBytes) stop('NATIVE_OUTPUT_LIMIT') })
  child.stdin.on('error', () => {})
  if (conversation) send(0)
  else child.stdin.end(input)
  try {
    const status = await new Promise((resolve, reject) => { child.once('error', error => reject(new NativeProbeError('NATIVE_START_FAILED', 1, ['ENOENT', 'EACCES'].includes(error.code) ? error.code : undefined))); child.once('close', resolve) })
    if (failure) throw new NativeProbeError(failure)
    if (status !== 0) throw new NativeProbeError('NATIVE_EXECUTION_FAILED')
    if (conversation) {
      try { pending += decoder.decode() } catch { throw new NativeProbeError('NATIVE_RESULT_INVALID') }
      if (completed !== input.length || pending.trim()) throw new NativeProbeError('NATIVE_RESULT_INVALID')
    }
    if (interruptSignal && (sentAt === undefined || acknowledgedAt === undefined)) throw new NativeProbeError('NATIVE_CONTROL_INVALID')
    return { stdout: Buffer.concat(output).toString('utf8'), completedAt: Date.now(), ...(interruptSignal ? { interrupt: Object.freeze({ sentAt, acknowledgedAt }) } : {}) }
  } finally { interruptSignal?.removeEventListener('abort', interrupt); clearTimeout(timer); clearTimeout(escalation); kill('SIGKILL') }
}
