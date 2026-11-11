export class HostHookError extends Error {
  constructor(readonly code: string, readonly outcome: 'unsupported' | 'denied' | 'cancelled' | 'stopped' | 'deferred' | 'failed', reason = '') {
    super(reason ? `${code}: ${reason}` : code)
    this.name = 'HostHookError'
  }
}
