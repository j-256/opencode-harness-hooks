import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ConformanceError } from './conformance.mjs'

export const REWRITE_CASES = Object.freeze(['rewrite', 'unchanged'])
const OUTPUT = Object.freeze({ original: 'CONFORMANCE_ORIGINAL_RESULT', rewrite: 'CONFORMANCE_REWRITTEN_RESULT', unchanged: 'CONFORMANCE_UNCHANGED_RESULT' })
const MARKERS = Object.freeze({ original: 'CONFORMANCE_ORIGINAL', replacement: 'CONFORMANCE_REWRITTEN', unchanged: 'CONFORMANCE_UNCHANGED' })
const DIGEST = /^[a-f0-9]{64}$/
const HOOK_TIMEOUT_SECONDS = 5
const NUMBER_FIELDS = Object.freeze(['preInvocations', 'postInvocations', 'primaryModelCalls'])
const BOOLEAN_FIELDS = Object.freeze(['eventOrderValid', 'toolValid', 'cwdMatches', 'preInputMatches', 'postInputMatches', 'identitiesValid', 'transcriptExists', 'sideEffectContentsValid', 'originalSideEffect', 'replacementSideEffect', 'controlSideEffect', 'resultOwned', 'resultMatches'])
const FIELDS = Object.freeze([...NUMBER_FIELDS, ...BOOLEAN_FIELDS])
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const quote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'"

export function createRewriteFixture({ project, hook, trace, node }) {
  const markerPaths = Object.fromEntries(Object.keys(MARKERS).map(key => [key, join(project, key + '.marker')]))
  const commandFor = (marker, output) => {
    const split = output.indexOf('_') + 1
    return 'printf %s ' + quote(MARKERS[marker]) + ' > ' + quote(markerPaths[marker]) + '; printf %s ' + [output.slice(0, split), output.slice(split)].map(quote).join(' ')
  }
  const originalCommand = commandFor('original', OUTPUT.original), replacementCommand = commandFor('replacement', OUTPUT.rewrite), unchangedCommand = commandFor('unchanged', OUTPUT.unchanged)
  const hookText = `const fs=require('node:fs');const p=JSON.parse(fs.readFileSync(0,'utf8'));fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify({input:p,transcriptExists:typeof p.transcript_path==='string'&&fs.existsSync(p.transcript_path)})+'\\n');if(p.hook_event_name==='PreToolUse'&&p.tool_name==='Bash'&&p.tool_input.command===${JSON.stringify(originalCommand)})console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'allow',updatedInput:{command:${JSON.stringify(replacementCommand)},description:'Controlled replacement'}}}));`
  const registration = [{ matcher: 'Bash', hooks: [{ type: 'command', command: quote(node) + ' ' + quote(hook), timeout: HOOK_TIMEOUT_SECONDS }] }]
  const sourceText = JSON.stringify({ hooks: { PreToolUse: registration, PostToolUse: registration } })
  return { hookText, sourceText, markerPaths, replacementCommand, command: id => id === 'rewrite' ? originalCommand : unchangedCommand, expectedOutput: id => OUTPUT[id], unexpectedOutputs: id => Object.values(OUTPUT).filter(value => value !== OUTPUT[id]) }
}

export function rewriteToolResult(messages, transport, toolUseID, expected, unexpected) {
  const results = transport === 'responses' ? messages.filter(row => row.type === 'function_call_output') : transport === 'anthropic' ? messages.flatMap(row => Array.isArray(row.content) ? row.content.filter(part => part.type === 'tool_result') : []) : messages.filter(row => row.role === 'tool')
  const identity = transport === 'responses' ? 'call_id' : transport === 'anthropic' ? 'tool_use_id' : 'tool_call_id'
  if (results.length !== 1 || results[0][identity] !== toolUseID) return { resultOwned: false, resultMatches: false }
  const content = transport === 'responses' ? results[0].output : results[0].content
  const text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter(part => ['text', 'input_text'].includes(part?.type) && typeof part.text === 'string').map(part => part.text).join('\n') : ''
  return { resultOwned: true, resultMatches: typeof expected === 'string' && text.split(expected).length === 2 && unexpected.every(value => !text.includes(value)) }
}

export async function observeRewrite({ fixture, lines, requests, dialect, toolUseID, project, id }) {
  const pre = lines.filter(row => row.input?.hook_event_name === 'PreToolUse'), post = lines.filter(row => row.input?.hook_event_name === 'PostToolUse')
  const inputs = [pre[0]?.input, post[0]?.input]
  const present = {}, valid = []
  for (const [key, path] of Object.entries(fixture.markerPaths)) {
    let content
    try { content = await readFile(path, 'utf8') } catch (error) { if (error.code !== 'ENOENT') throw error }
    present[key] = content !== undefined
    valid.push(content === undefined || content === MARKERS[key])
  }
  const identitiesValid = inputs.every(input => typeof input?.session_id === 'string' && input.session_id.length > 0 && input.tool_use_id === toolUseID && input.permission_mode === 'bypassPermissions' && (dialect !== 'codex' || typeof input.turn_id === 'string' && input.turn_id.length > 0 && input.model === 'fixture')) && inputs[0].session_id === inputs[1].session_id && (dialect !== 'codex' || inputs[0].turn_id === inputs[1].turn_id)
  return { id, preInvocations: pre.length, postInvocations: post.length, eventOrderValid: lines.length === 2 && lines[0].input?.hook_event_name === 'PreToolUse' && lines[1].input?.hook_event_name === 'PostToolUse', toolValid: inputs.every(input => input?.tool_name === 'Bash'), cwdMatches: inputs.every(input => input?.cwd === project), preInputMatches: inputs[0]?.tool_input?.command === fixture.command(id), postInputMatches: inputs[1]?.tool_input?.command === (id === 'rewrite' ? fixture.replacementCommand : fixture.command(id)), identitiesValid, transcriptExists: pre[0]?.transcriptExists === true && post[0]?.transcriptExists === true, sideEffectContentsValid: valid.every(Boolean), originalSideEffect: present.original, replacementSideEffect: present.replacement, controlSideEffect: present.unchanged, resultOwned: requests?.resultOwned === true, resultMatches: requests?.resultMatches === true, primaryModelCalls: requests?.count ?? 0 }
}

export function evaluateRewriteObservations(native, host) {
  for (const trace of [native, host]) if (!object(trace) || !DIGEST.test(trace.sourceDigest ?? '') || !DIGEST.test(trace.hookDigest ?? '') || !Array.isArray(trace.controls) || trace.controls.length !== REWRITE_CASES.length || !trace.controls.every(object)) throw new ConformanceError('CONFORMANCE_OBSERVATION_INVALID')
  if (native.sourceDigest !== host.sourceDigest || native.hookDigest !== host.hookDigest) throw new ConformanceError('CONFORMANCE_SOURCE_MISMATCH')
  let failure
  for (const [backend, trace] of [['native', native], ['host', host]]) {
    for (const [index, control] of trace.controls.entries()) {
      const id = REWRITE_CASES[index], expected = { id, preInvocations: 1, postInvocations: 1, primaryModelCalls: 2, ...Object.fromEntries(BOOLEAN_FIELDS.map(key => [key, true])), originalSideEffect: false, replacementSideEffect: id === 'rewrite', controlSideEffect: id === 'unchanged' }
      const mismatch = Object.entries(expected).find(([key, value]) => control[key] !== value)
      if (mismatch && !failure) failure = 'CONFORMANCE_REWRITE_FAILED: ' + backend + '.' + id + '.' + mismatch[0]
    }
  }
  const safe = trace => trace.controls.map((control, index) => ({ id: REWRITE_CASES[index], ...Object.fromEntries(NUMBER_FIELDS.map(key => [key, Number.isSafeInteger(control[key]) && control[key] >= 0 ? control[key] : null])), ...Object.fromEntries(BOOLEAN_FIELDS.map(key => [key, typeof control[key] === 'boolean' ? control[key] : null])) }))
  const provenance = { sourceDigest: native.sourceDigest, hookDigest: native.hookDigest }
  return failure ? { status: 'failed', comparison: { match: false, ...provenance, failure, observations: { native: safe(native), host: safe(host) } } } : { status: 'passed', comparison: { match: true, ...provenance, compared: [...FIELDS], controls: safe(native) } }
}
