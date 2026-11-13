const FIELDS = Object.freeze(['sessionRetained', 'prefixRetained', 'originalRetained'])
export function inspectResumeTranscript(rows, { dialect, sessionID, callID, original }) {
  try {
    if (!Array.isArray(rows)) return false
    if (dialect === 'codex') {
      if (rows[0]?.type !== 'session_meta' || rows[0].payload?.id !== sessionID) return false
      const calls = rows.filter(row => row.type === 'response_item' && row.payload?.type === 'function_call' && row.payload.call_id === callID)
      return calls.length === 1 && JSON.parse(calls[0].payload.arguments).cmd === original
    }
    if (dialect !== 'claude-code') return false
    const calls = rows.filter(row => row.type === 'assistant' && row.sessionId === sessionID).flatMap(row => Array.isArray(row.message?.content) ? row.message.content.filter(part => part.type === 'tool_use' && part.id === callID) : [])
    return calls.length === 1 && calls[0].input?.command === original
  } catch { return false }
}
export function compareResumeEvidence(native, host) {
  const safe = value => Object.fromEntries(FIELDS.map(field => [field, value?.[field] === true]))
  const observations = { native: safe(native), host: safe(host) }
  return { match: Object.values(observations).every(value => FIELDS.every(field => value[field])), ...observations }
}
