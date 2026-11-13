import { createServer } from 'node:http'
import { runNativeProcess } from './native-process.mjs'

const MAX_BODY_BYTES = 2 * 1024 * 1024
const MAX_REQUESTS = 32
const HOOK_TIMEOUT_SECONDS = 1
const CHILD_LIMITS = Object.freeze({ durationMs: 5000, graceMs: 100, maxBytes: MAX_BODY_BYTES })
export const HTTP_FAILURE_MODES = Object.freeze(['status', 'invalid', 'timeout', 'redirect'])

export function httpSource(text, url) {
  const source = JSON.parse(text)
  for (const groups of Object.values(source.hooks)) for (const group of groups) group.hooks = group.hooks.map(() => ({ type: 'http', url, timeout: HOOK_TIMEOUT_SECONDS }))
  return JSON.stringify(source)
}

export async function startHttpHook({ hook, project, mode = 'ok', reason = 'HTTP_FAILURE_BODY' }) {
  if (!['ok', ...HTTP_FAILURE_MODES].includes(mode)) throw new Error('HTTP_FIXTURE_MODE_INVALID')
  let state = { requests: 0, redirectsFollowed: 0, errors: 0 }
  let total = 0, closing
  const active = new Set()
  const service = createServer((request, response) => {
    const current = state
    const pending = (async () => {
      if (++total > MAX_REQUESTS) throw new Error('HTTP_FIXTURE_LIMIT')
      if (request.url === '/followed') {
        current.redirectsFollowed++
        response.end(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }))
        return
      }
      current.requests++
      if (request.method !== 'POST' || request.url !== '/hook') throw new Error('HTTP_FIXTURE_REQUEST_INVALID')
      const chunks = []
      let bytes = 0
      for await (const chunk of request) {
        bytes += chunk.length
        if (bytes > MAX_BODY_BYTES) throw new Error('HTTP_FIXTURE_INPUT_LIMIT')
        chunks.push(chunk)
      }
      const execution = await runNativeProcess(process.execPath, [hook], Buffer.concat(chunks).toString('utf8'), project, { PATH: process.env.PATH, SHELL: '/bin/sh', LANG: 'C' }, CHILD_LIMITS)
      if (mode === 'redirect') { response.writeHead(302, { Location: '/followed' }); response.end(); return }
      response.writeHead(mode === 'status' ? 500 : 200, { 'Content-Type': 'application/json' })
      if (mode === 'timeout') { response.write('{'); return }
      response.end(mode === 'ok' ? execution.stdout : reason)
    })().catch(() => { current.errors++; if (!response.headersSent) response.writeHead(400); response.end() })
    active.add(pending)
    void pending.finally(() => active.delete(pending))
  })
  await new Promise((resolve, reject) => { service.once('error', reject); service.listen(0, '127.0.0.1', resolve) })
  return {
    url: 'http://127.0.0.1:' + service.address().port + '/hook',
    inspect: () => ({ ...state }),
    reset: () => { state = { requests: 0, redirectsFollowed: 0, errors: 0 } },
    close: () => closing ??= (async () => { service.closeAllConnections(); await new Promise((resolve, reject) => service.close(error => error ? reject(error) : resolve())); await Promise.allSettled([...active]) })(),
  }
}
