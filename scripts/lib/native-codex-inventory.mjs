import { spawn } from 'node:child_process'
import { NativeProbeError, NATIVE_PROCESS_LIMITS } from './native-process.mjs'

const REQUEST_IDS = Object.freeze({ INITIALIZE: 1, LIST: 2 })

export function listNativeCodexHooks(binary, cwd, env, overrides = []) {
  return readNativeCodex(binary, cwd, env, 'hooks/list', { cwds: [cwd], forceReload: true }, overrides)
}
export function readNativeCodexConfig(binary, cwd, env, overrides = []) {
  return readNativeCodex(binary, cwd, env, 'config/read', { includeLayers: true, cwd }, overrides)
}
export function readNativeCodexRequirements(binary, cwd, env) {
  return readNativeCodex(binary, cwd, env, 'configRequirements/read', {})
}

async function readNativeCodex(binary, cwd, env, method, params, overrides = []) {
  if (!Array.isArray(overrides) || overrides.length > 64 || overrides.some(value => typeof value !== 'string' || Buffer.byteLength(value) > NATIVE_PROCESS_LIMITS.maxBytes)) throw new NativeProbeError('NATIVE_INVENTORY_OVERRIDE_INVALID', 2)
  const child = spawn(binary, ['app-server', ...overrides.map(value => '--config=' + value)], { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let pending = '', bytes = 0, reply, failure, escalation
  let initialized = false
  const kill = signal => { try { if (child.pid) process.kill(-child.pid, signal) } catch {} }
  const stop = code => {
    if (failure) return
    failure = code
    kill('SIGTERM')
    escalation = setTimeout(() => kill('SIGKILL'), NATIVE_PROCESS_LIMITS.graceMs)
  }
  const send = value => child.stdin.write(JSON.stringify(value) + '\n')
  const timer = setTimeout(() => stop('NATIVE_INVENTORY_TIMEOUT'), NATIVE_PROCESS_LIMITS.durationMs)
  child.stdout.on('data', chunk => {
    bytes += chunk.length
    if (bytes > NATIVE_PROCESS_LIMITS.maxBytes) { stop('NATIVE_INVENTORY_OUTPUT_LIMIT'); return }
    if (failure) return
    try {
      pending += decoder.decode(chunk, { stream: true })
      while (pending.includes('\n') && !failure) {
        const at = pending.indexOf('\n'), line = pending.slice(0, at)
        pending = pending.slice(at + 1)
        if (!line.trim()) continue
        const value = JSON.parse(line)
        if (!value || typeof value !== 'object' || Array.isArray(value)) { stop('NATIVE_INVENTORY_REPLY_INVALID'); return }
        if (value.id === REQUEST_IDS.INITIALIZE) {
          if (initialized || value.error || !value.result) { stop('NATIVE_INVENTORY_INITIALIZE_FAILED'); return }
          initialized = true
          send({ method: 'initialized', params: {} })
          send({ id: REQUEST_IDS.LIST, method, params })
        } else if (value.id === REQUEST_IDS.LIST) {
          if (!initialized || reply || value.error || !value.result) { stop('NATIVE_INVENTORY_LIST_FAILED'); return }
          reply = value.result
          child.stdin.end()
        }
      }
    } catch { stop('NATIVE_INVENTORY_REPLY_INVALID') }
  })
  child.stderr.on('data', chunk => { bytes += chunk.length; if (bytes > NATIVE_PROCESS_LIMITS.maxBytes) stop('NATIVE_INVENTORY_OUTPUT_LIMIT') })
  child.stdin.on('error', () => stop('NATIVE_INVENTORY_INPUT_FAILED'))
  send({ id: REQUEST_IDS.INITIALIZE, method: 'initialize', params: { clientInfo: { name: 'harness_hooks_source_reference', version: '0.1.0' } } })
  try {
    const status = await new Promise((resolve, reject) => { child.once('error', () => reject(new NativeProbeError('NATIVE_INVENTORY_START_FAILED'))); child.once('close', resolve) })
    if (failure) throw new NativeProbeError(failure)
    if (status !== 0) throw new NativeProbeError('NATIVE_INVENTORY_EXECUTION_FAILED')
    try { pending += decoder.decode() } catch { throw new NativeProbeError('NATIVE_INVENTORY_REPLY_INVALID') }
    if (!reply || pending.trim()) throw new NativeProbeError('NATIVE_INVENTORY_REPLY_MISSING')
    return reply
  } finally { clearTimeout(timer); clearTimeout(escalation); kill('SIGKILL') }
}
