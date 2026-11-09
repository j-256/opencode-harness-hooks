import { performance } from 'node:perf_hooks'

const MAX_TIMER_MS = 2 ** 31 - 1

export class HookServiceError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'HookServiceError' }
}

export class UnsupportedServiceError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'UnsupportedServiceError' }
}

export async function runService<T>(timeoutMs: number | null, parent: AbortSignal | undefined, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  if (timeoutMs !== null && (!Number.isFinite(timeoutMs) || timeoutMs < 0)) throw new HookServiceError('EXECUTION_INVALID_INVOCATION')
  if (parent?.aborted) throw new HookServiceError('EXECUTION_CANCELLED')
  if (timeoutMs === 0) throw new HookServiceError('EXECUTION_TIMEOUT')
  const controller = new AbortController()
  const started = performance.now()
  let timer: ReturnType<typeof setTimeout> | undefined
  let rejectAbort!: (error: HookServiceError) => void
  const interrupted = new Promise<never>((_resolve, reject) => { rejectAbort = reject })
  const abort = (code: string) => {
    const error = new HookServiceError(code)
    rejectAbort(error)
    controller.abort(error)
  }
  const cancelled = () => abort('EXECUTION_CANCELLED')
  const schedule = () => {
    if (timeoutMs === null) return
    const remaining = timeoutMs - (performance.now() - started)
    timer = setTimeout(() => {
      if (remaining > MAX_TIMER_MS) schedule()
      else abort('EXECUTION_TIMEOUT')
    }, Math.min(MAX_TIMER_MS, Math.max(0, remaining)))
  }
  parent?.addEventListener('abort', cancelled, { once: true })
  schedule()
  try {
    if (parent?.aborted) cancelled()
    return await Promise.race([interrupted, Promise.resolve().then(() => {
      if (controller.signal.aborted) throw controller.signal.reason
      return operation(controller.signal)
    })])
  } finally {
    clearTimeout(timer)
    parent?.removeEventListener('abort', cancelled)
  }
}
