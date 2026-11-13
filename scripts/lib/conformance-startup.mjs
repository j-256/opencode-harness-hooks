import { readFile } from 'node:fs/promises'
import { evaluateControlObservations } from './conformance.mjs'

const CONTEXT = 'START_CONTEXT'
const ORIGINAL = 'CONFORMANCE_CASE:'
const REMINDER = '<system-reminder>\nSessionStart:startup hook success: START_CONTEXT\n</system-reminder>'
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/
const quote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'"

export function createStartupFixture({ script, trace, node, dialect }) {
  const hookText = `const fs=require('node:fs');const p=JSON.parse(fs.readFileSync(0,'utf8'));fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify({input:p,transcriptExists:typeof p.transcript_path==='string'&&fs.existsSync(p.transcript_path)})+'\\n');if(process.env.CLAUDE_ENV_FILE){fs.writeFileSync(process.env.CLAUDE_ENV_FILE,'export STARTUP_ENV=environment\\nstartup_function(){ printf STARTUP_FUNCTION; }\\n');console.log('${CONTEXT}')}else console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'SessionStart',additionalContext:'${CONTEXT}'}}));`
  return {
    hookText,
    registration: [{ hooks: [{ type: 'command', command: [node, script].map(quote).join(' ') }] }],
    commandPrefix: dialect === 'claude-code' ? 'test "$STARTUP_ENV" = environment && test "$(startup_function)" = STARTUP_FUNCTION && ' : '',
  }
}

export function startupModelView(messages, dialect) {
  if (!Array.isArray(messages)) return false
  const texts = messages.flatMap(row => (typeof row?.content === 'string' ? [{ type: 'text', text: row.content }] : Array.isArray(row?.content) ? row.content : []).filter(part => ['text', 'input_text', 'output_text'].includes(part?.type) && typeof part.text === 'string').map(part => ({ role: row.role, text: part.text })))
  const contexts = texts.flatMap((row, index) => row.text.includes(CONTEXT) ? [index] : [])
  const original = texts.findIndex(row => row.text.includes(ORIGINAL))
  if (contexts.length !== 1 || original < 0 || contexts[0] >= original) return false
  const context = texts[contexts[0]]
  return context.role === (dialect === 'codex' ? 'developer' : 'user') && context.text === (dialect === 'codex' ? CONTEXT : REMINDER)
}

export async function observeStartup({ trace, requests, project, dialect }) {
  const lines = (await readFile(trace, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  const payload = lines[0]?.input
  const codex = dialect === 'codex'
  const metadata = payload?.hook_event_name === 'SessionStart' && payload.source === 'startup' && payload.cwd === project && typeof payload.session_id === 'string' && payload.session_id.length > 0 && typeof payload.transcript_path === 'string' && payload.transcript_path.length > 0 && !Object.hasOwn(payload, 'turn_id') && (codex ? payload.permission_mode === 'bypassPermissions' && UUID.test(payload.session_id) && payload.model === 'fixture' && lines[0].transcriptExists === true : !Object.hasOwn(payload, 'permission_mode') && lines[0].transcriptExists === false)
  return { startupInvocations: lines.length, startupMetadataValid: metadata, startupContextValid: requests?.startupContextValid === true }
}

export function evaluateStartupObservations(native, host) {
  const result = evaluateControlObservations(native, host)
  if (result.status !== 'passed') return result
  const safe = trace => trace.controls.map(row => ({ id: row.id, startupInvocations: Number.isSafeInteger(row.startupInvocations) ? row.startupInvocations : null, startupMetadataValid: row.startupMetadataValid === true, startupContextValid: row.startupContextValid === true }))
  for (const [backend, trace] of [['native', native], ['host', host]]) for (const row of trace.controls) {
    const mismatch = Object.entries({ startupInvocations: 1, startupMetadataValid: true, startupContextValid: true }).find(([key, value]) => row[key] !== value)
    if (mismatch) return { status: 'failed', comparison: { match: false, failure: 'CONFORMANCE_STARTUP_FAILED: ' + backend + '.' + row.id + '.' + mismatch[0], observations: { native: safe(native), host: safe(host) } } }
  }
  return { ...result, comparison: { ...result.comparison, startup: safe(native) } }
}
