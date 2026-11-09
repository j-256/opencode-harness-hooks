import { spawn } from 'node:child_process'
import { performance } from 'node:perf_hooks'

export const EXECUTION_STATUS = Object.freeze({
  EXITED: 'exited', SPAWN_ERROR: 'spawn-error', INPUT_LIMIT: 'input-limit', OUTPUT_LIMIT: 'output-limit',
  TIMEOUT: 'timeout', CANCELLED: 'cancelled', INVALID: 'invalid-invocation',
} as const)
export type ExecutionStatus = typeof EXECUTION_STATUS[keyof typeof EXECUTION_STATUS]

export const EXECUTION_LIMITS = Object.freeze({ inputBytes: 1024 * 1024, outputBytes: 2 * 1024 * 1024 })
const TERMINATION_GRACE_MS = 100
const MAX_TIMER_MS = 2 ** 31 - 1

export interface CommandInvocation {
  readonly command: string
  readonly args?: readonly string[] | undefined
  readonly shell?: { readonly program: string; readonly args: readonly string[] }
  readonly cwd: string
  readonly env: Readonly<NodeJS.ProcessEnv>
  readonly stdin: string
  readonly timeoutMs: number | null
  readonly signal?: AbortSignal
  readonly maxInputBytes?: number
  readonly maxOutputBytes?: number
}

export interface ExecutionResult {
  readonly status: ExecutionStatus
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
  readonly stdout: string
  readonly stderr: string
  readonly durationMs: number
}

export async function runCommand(invocation: CommandInvocation): Promise<ExecutionResult> {
  const started = performance.now()
  const result = (status: ExecutionStatus, exitCode: number | null = null, signal: NodeJS.Signals | null = null, stdout = '', stderr = ''): ExecutionResult => ({
    status, exitCode, signal, stdout, stderr, durationMs: Math.round(performance.now() - started),
  })
  const inputLimit = invocation.maxInputBytes ?? EXECUTION_LIMITS.inputBytes
  const outputLimit = invocation.maxOutputBytes ?? EXECUTION_LIMITS.outputBytes
  if (!Number.isSafeInteger(inputLimit) || inputLimit < 1 || !Number.isSafeInteger(outputLimit) || outputLimit < 1 ||
      (invocation.timeoutMs !== null && (!Number.isFinite(invocation.timeoutMs) || invocation.timeoutMs < 0))) {
    return result(EXECUTION_STATUS.INVALID)
  }
  if (Buffer.byteLength(invocation.stdin) > inputLimit) return result(EXECUTION_STATUS.INPUT_LIMIT)
  if (invocation.signal?.aborted) return result(EXECUTION_STATUS.CANCELLED)
  return new Promise(resolve => {
    const shell = invocation.shell ?? { program: '/bin/sh', args: ['-c'] }
    let child
    try {
      const command = invocation.args !== undefined ? invocation.command : shell.program
      const args = invocation.args !== undefined ? [...invocation.args] : [...shell.args, invocation.command]
      child = spawn(command, args, { cwd: invocation.cwd, env: { ...invocation.env }, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] })
    } catch {
      resolve(result(EXECUTION_STATUS.SPAWN_ERROR))
      return
    }
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let bytes = 0
    let failure: ExecutionStatus | undefined
    let deadline: ReturnType<typeof setTimeout> | undefined
    let escalation: ReturnType<typeof setTimeout> | undefined
    let closed = false
    let exitCode: number | null = null
    let exitSignal: NodeJS.Signals | null = null
    const complete = () => {
      if (!closed || escalation !== undefined) return
      clearTimeout(deadline)
      invocation.signal?.removeEventListener('abort', abort)
      resolve(result(failure ?? EXECUTION_STATUS.EXITED, failure === EXECUTION_STATUS.SPAWN_ERROR ? null : exitCode, exitSignal, Buffer.concat(stdout).toString('utf8'), Buffer.concat(stderr).toString('utf8')))
    }
    const kill = (signal: NodeJS.Signals) => {
      if (child.pid === undefined) return
      try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, signal) } catch {}
    }
    const stop = (status: ExecutionStatus) => {
      if (failure !== undefined) return
      failure = status
      kill('SIGTERM')
      escalation = setTimeout(() => {
        kill('SIGKILL')
        escalation = undefined
        complete()
      }, TERMINATION_GRACE_MS)
    }
    const receive = (target: Buffer[]) => (chunk: Buffer) => {
      if (failure === EXECUTION_STATUS.OUTPUT_LIMIT) return
      bytes += chunk.length
      if (bytes > outputLimit) {
        stdout.length = 0
        stderr.length = 0
        stop(EXECUTION_STATUS.OUTPUT_LIMIT)
        return
      }
      target.push(chunk)
    }
    const abort = () => stop(EXECUTION_STATUS.CANCELLED)
    child.stdout.on('data', receive(stdout))
    child.stderr.on('data', receive(stderr))
    child.stdin.on('error', () => {})
    child.on('error', () => { failure ??= EXECUTION_STATUS.SPAWN_ERROR })
    child.on('close', (code, signal) => {
      closed = true
      exitCode = code
      exitSignal = signal
      clearTimeout(deadline)
      invocation.signal?.removeEventListener('abort', abort)
      complete()
    })
    const scheduleDeadline = () => {
      if (invocation.timeoutMs === null) return
      const remaining = invocation.timeoutMs - (performance.now() - started)
      deadline = setTimeout(() => {
        if (remaining > MAX_TIMER_MS) scheduleDeadline()
        else stop(EXECUTION_STATUS.TIMEOUT)
      }, Math.min(MAX_TIMER_MS, Math.max(0, remaining)))
    }
    scheduleDeadline()
    invocation.signal?.addEventListener('abort', abort, { once: true })
    if (invocation.signal?.aborted) abort()
    child.stdin.end(invocation.stdin)
  })
}
