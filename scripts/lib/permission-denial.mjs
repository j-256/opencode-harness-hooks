const DENIAL_PREFIX = 'The user has specified a rule which prevents you from using this specific tool call. Here are some of the relevant rules '
const ACTIONS = new Set(['allow', 'ask', 'deny'])

export function isConfiguredCommandDenial(content) {
  if (typeof content !== 'string' || !content.startsWith(DENIAL_PREFIX)) return false
  try {
    const rules = JSON.parse(content.slice(DENIAL_PREFIX.length))
    return Array.isArray(rules) && rules.every(row => row && typeof row === 'object' && !Array.isArray(row) && typeof row.permission === 'string' && typeof row.pattern === 'string' && ACTIONS.has(row.action)) && rules.some(row => row.permission === 'bash' && row.pattern === 'printf*' && row.action === 'deny')
  } catch { return false }
}
