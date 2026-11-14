import type { createHarnessHooks } from './plugin-v1.js'
import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { HookServiceError, runService } from '../service-execution.js'
import type { HostHookError } from './tools.js'

const NOTICE_TIMEOUT_MS = 5000
const NOTICE_DURATION_MS = 30_000
type Input = Parameters<typeof createHarnessHooks>[0]
type Hooks = Awaited<ReturnType<typeof createHarnessHooks>>

export function rejectV1Activation(input: Input, error: HostHookError): Hooks {
  const lifetime = new AbortController()
  const failureID = randomUUID()
  const stop = error.code === 'HOST_STOP_UNSUPPORTED'
  let notice: Promise<void> | undefined
  const refuse = async () => { throw error }
  const report = (code: string, details: Readonly<Record<string, string | number>>) => console.error(JSON.stringify({ component: 'opencode-harness-hooks', code, failureID, host: 'v1', ...(stop ? { event: 'Stop' } : { phase: 'load' }), ...details }))
  report(error.code, { level: 'error', message: error.message })
  // V1 swallows server and config initialization errors, so failed activation must retain admission guards
  return {
    config: async () => {
      const tui = input.client?.tui
      if (tui && !notice) {
        const started = performance.now()
        const duration = () => ({ durationMs: Math.round(performance.now() - started) })
        // The TUI request may wait for plugin initialization, so it must not delay configuration failure
        notice = runService(NOTICE_TIMEOUT_MS, lifetime.signal, signal => tui.showToast({ body: { title: 'Hook configuration incompatible with OpenCode V1', message: error.message, variant: 'error', duration: NOTICE_DURATION_MS }, query: { directory: input.directory }, signal }))
          .then(result => {
            if (result.error || result.data !== true) throw new Error()
            report(stop ? 'HOST_STOP_NOTICE_SHOWN' : 'HOST_ACTIVATION_NOTICE_SHOWN', { level: 'info', ...duration() })
          }).catch((failure: unknown) => { report(stop ? 'HOST_STOP_NOTICE_FAILED' : 'HOST_ACTIVATION_NOTICE_FAILED', { level: 'error', reason: failure instanceof HookServiceError ? failure.code : 'HOST_NOTICE_REJECTED', ...duration() }) })
      }
      throw error
    },
    'chat.message': refuse,
    'chat.params': refuse,
    'chat.headers': refuse,
    'experimental.chat.messages.transform': refuse,
    'experimental.chat.system.transform': refuse,
    'tool.execute.before': refuse,
    'shell.env': refuse,
    'tool.execute.after': refuse,
    event: async () => {},
    inspect: () => { throw error },
    disposeSession: async () => {},
    settleWake: async () => {},
    dispose: async () => { lifetime.abort(); await notice },
  }
}
