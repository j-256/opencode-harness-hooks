import type { HostServices } from './host-services.js'
import type { Registration } from './types.js'

const SECOND_MS = 1000
const DEFAULT_TIMEOUT_SECONDS = 600
const CLAUDE_SHORT_TIMEOUT_EVENTS = new Set(['UserPromptSubmit', 'PreModelSwitch', 'PostModelSwitch'])
const CODEX_SHUTDOWN_EVENTS = new Set(['SessionEnd', 'Interrupt'])

export function handlerTimeoutMs(registration: Registration, host: HostServices): number {
  let seconds: number
  const configured = registration.handler.timeout
  if (registration.dialect === 'codex') {
    seconds = CODEX_SHUTDOWN_EVENTS.has(registration.event) ? Math.max(1, Math.min(3, configured ?? 1)) : Math.max(1, configured ?? DEFAULT_TIMEOUT_SECONDS)
  } else {
    const type = registration.handler.type
    const fallback = type === 'prompt' ? 30 : type === 'agent' ? 60 : registration.event === 'SessionEnd' ? 1.5 : registration.event === 'MessageDisplay' ? 10 : CLAUDE_SHORT_TIMEOUT_EVENTS.has(registration.event) ? 30 : DEFAULT_TIMEOUT_SECONDS
    seconds = configured ?? fallback
  }
  return Math.min(seconds * SECOND_MS, host.remainingBudgetMs ?? Infinity)
}
