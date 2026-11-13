import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ConformanceError } from './conformance.mjs'

const EFFECTS = Object.freeze({ context: 'POSTTOOL_OWNED_CONTEXT', feedback: 'POSTTOOL_OWNED_FEEDBACK', replacement: 'POSTTOOL_OWNED_REPLACEMENT' })
const CASES = Object.freeze({ 'claude-code': ['context', 'feedback', 'noop'], codex: ['replacement', 'noop'] })
const PHASES = Object.freeze(['first', 'next'])
const BOOLEAN_FIELDS = Object.freeze(['hookOrderValid', 'toolValid', 'cwdMatches', 'identitiesValid', 'inputMatches', 'transcriptExists', 'sideEffectsValid', 'resultOwned', 'firstResultValid', 'firstOriginalOutputPresent', 'firstEffectTextPresent', 'nextResultClean', 'effectCountValid'])
const NUMBER_FIELDS = Object.freeze(['postInvocations', 'primaryModelCalls'])
const ROLES = Object.freeze(['user', 'developer', 'assistant', 'system', 'tool'])
const PLACEMENTS = Object.freeze(['message', 'tool-result'])
const ORDERS = Object.freeze(['before', 'after', 'inside'])
const DIGEST = /^[a-f0-9]{64}$/
const DIAGNOSTIC = /^(?:HOST|SOURCE|PLUGIN)_[A-Z_]+$/
const FAILED_SHELL_EXIT = 17
const HOOK_TIMEOUT_SECONDS = 5
const MAX_LAYOUT_ITEMS = 4
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const quote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'"
const count = (text, token) => token ? text.split(token).length - 1 : 0
const text = content => typeof content === 'string' ? content : Array.isArray(content) ? content.filter(part => ['text', 'input_text', 'output_text'].includes(part?.type) && typeof part.text === 'string').map(part => part.text).join('\n') : ''

export function createPosttoolFixture({ project, hook, trace, node, dialect, failedFirst = false }) {
  const cases = CASES[dialect]
  if (!cases) throw new ConformanceError('CONFORMANCE_DIALECT_INVALID')
  const records = Object.fromEntries(cases.map(id => [id, Object.fromEntries(PHASES.map(phase => {
    const marker = 'POSTTOOL_' + id.toUpperCase() + '_' + phase.toUpperCase(), output = marker + '_OUTPUT', path = join(project, id + '-' + phase + '.marker')
    const split = output.indexOf('_') + 1
    return [phase, { path, marker, output, command: 'printf %s ' + quote(marker) + ' > ' + quote(path) + '; printf %s ' + [output.slice(0, split), output.slice(split)].map(quote).join(' ') + (failedFirst && phase === 'first' ? '; exit ' + FAILED_SHELL_EXIT : '') }]
  }))]))
  const commands = Object.fromEntries(cases.flatMap(id => PHASES.map(phase => [records[id][phase].command, { path: records[id][phase].path, ...(phase === 'first' && id !== 'noop' ? { output: id === 'context' ? { hookSpecificOutput: { hookEventName: failedFirst && dialect === 'claude-code' ? 'PostToolUseFailure' : 'PostToolUse', additionalContext: EFFECTS.context } } : { decision: 'block', reason: EFFECTS[id] } } : {}) }])))
  const hookText = `const fs=require('node:fs');const p=JSON.parse(fs.readFileSync(0,'utf8'));const row=${JSON.stringify(commands)}[p.tool_input?.command];fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify({input:p,transcriptExists:typeof p.transcript_path==='string'&&fs.existsSync(p.transcript_path),completedSideEffect:!!row&&fs.existsSync(row.path)})+'\\n');if(['PostToolUse','PostToolUseFailure'].includes(p.hook_event_name)&&p.tool_name==='Bash'&&row?.output)console.log(JSON.stringify(row.output));`
  const group = [{ matcher: 'Bash', hooks: [{ type: 'command', command: quote(node) + ' ' + quote(hook), timeout: HOOK_TIMEOUT_SECONDS }] }]
  const sourceText = JSON.stringify({ hooks: { PostToolUse: group, ...(failedFirst && dialect === 'claude-code' ? { PostToolUseFailure: group } : {}) } })
  return { cases, hookText, sourceText, failedFirst, effectTokens: Object.values(EFFECTS), command: (id, phase) => records[id][phase].command, records: id => records[id], modelOptions: (id, firstID, nextID) => ({ firstID, nextID, firstOutput: records[id].first.output, nextOutput: records[id].next.output, effect: EFFECTS[id], replacement: id === 'replacement' }) }
}

function segments(messages, transport) {
  const rows = []
  for (const message of messages) {
    if (transport === 'responses' && message.type === 'function_call_output') rows.push({ role: 'tool', kind: 'result', id: message.call_id, text: text(message.output), validRole: true })
    else if (transport === 'chat' && message.role === 'tool') rows.push({ role: 'tool', kind: 'result', id: message.tool_call_id, text: text(message.content), validRole: true })
    else if (transport !== 'responses' || message.type === 'message') {
      if (typeof message.content === 'string') rows.push({ role: message.role, kind: 'text', text: message.content })
      else if (Array.isArray(message.content)) for (const part of message.content) {
        if (transport === 'anthropic' && part?.type === 'tool_result') rows.push({ role: 'tool', kind: 'result', id: part.tool_use_id, text: text(part.content), validRole: message.role === 'user' })
        else if (['text', 'input_text', 'output_text'].includes(part?.type) && typeof part.text === 'string') rows.push({ role: message.role, kind: 'text', text: part.text })
      }
    }
  }
  return rows
}

export function posttoolModelView(messages, transport, options, phase) {
  const rows = segments(messages, transport), results = rows.filter(row => row.kind === 'result')
  const currentID = phase === 'first' ? options.firstID : options.nextID, current = results.filter(row => row.id === currentID), firstIndex = rows.findIndex(row => row.kind === 'result' && row.id === options.firstID), nextIndex = rows.findIndex(row => row.kind === 'result' && row.id === options.nextID)
  const owned = results.every(row => row.validRole && (row.id === options.firstID || phase === 'next' && row.id === options.nextID)) && new Set(results.map(row => row.id)).size === results.length && current.length === 1
  const content = current[0]?.text ?? '', expected = phase === 'first' && options.replacement ? options.effect : phase === 'first' ? options.firstOutput : options.nextOutput
  const resultValid = count(content, expected) === 1 && (phase === 'first' ? !content.includes(options.nextOutput) && (!options.replacement || !content.includes(options.firstOutput)) : !content.includes(options.firstOutput) && Object.values(EFFECTS).every(value => !content.includes(value)))
  const occurrences = rows.reduce((sum, row) => sum + count(row.text, options.effect), 0)
  const effectCountValid = (phase === 'first' ? occurrences === (options.effect ? 1 : 0) : occurrences <= (options.effect ? 1 : 0)) && Object.values(EFFECTS).filter(value => value !== options.effect).every(value => rows.every(row => !row.text.includes(value)))
  const effectView = rows.flatMap((row, index) => count(row.text, options.effect) ? [{ role: ROLES.includes(row.role) ? row.role : 'unexpected', placement: row.kind === 'result' ? 'tool-result' : 'message', order: row.kind === 'result' && row.id === options.firstID ? 'inside' : index < firstIndex ? 'before' : 'after', occurrences: count(row.text, options.effect), ...(phase === 'next' ? { nextOrder: index < nextIndex ? 'before' : index === nextIndex ? 'inside' : 'after' } : {}) }] : [])
  return { resultOwned: owned, resultValid, originalOutputPresent: count(content, options.firstOutput) > 0, effectTextPresent: count(content, options.effect) > 0, effectCountValid, effectView }
}

export async function observePosttool({ fixture, id, lines, requests, project, dialect, toolIDs }) {
  const validIdentity = input => typeof input?.session_id === 'string' && input.session_id.length > 0 && input.permission_mode === 'bypassPermissions' && (dialect !== 'codex' || typeof input.turn_id === 'string' && input.turn_id.length > 0 && input.model === 'fixture')
  let sideEffectsValid = lines.every(row => row.completedSideEffect === true)
  for (const record of Object.values(fixture.records(id))) {
    try { sideEffectsValid &&= await readFile(record.path, 'utf8') === record.marker } catch (error) { if (error.code !== 'ENOENT') throw error; sideEffectsValid = false }
  }
  const inputs = lines.map(row => row.input)
  const first = inputs[0], firstOutput = fixture.modelOptions(id).firstOutput
  const failurePayloadValid = dialect === 'claude-code' ? typeof first?.error === 'string' && first.error.includes(firstOutput) && first.error.includes('Exit code ' + FAILED_SHELL_EXIT) && first.is_interrupt === false && first.tool_response === undefined : typeof first?.tool_response === 'string' && first.tool_response === firstOutput && first.error === undefined
  return { id, ...(fixture.failedFirst ? { failurePayloadValid } : {}), postInvocations: lines.length, primaryModelCalls: requests?.count ?? 0, hookOrderValid: lines.length === PHASES.length && inputs.every((input, index) => input?.hook_event_name === (fixture.failedFirst && dialect === 'claude-code' && index === 0 ? 'PostToolUseFailure' : 'PostToolUse') && input.tool_use_id === toolIDs[index]), toolValid: inputs.length === PHASES.length && inputs.every(input => input?.tool_name === 'Bash'), cwdMatches: inputs.length === PHASES.length && inputs.every(input => input?.cwd === project), identitiesValid: inputs.length === PHASES.length && inputs.every(validIdentity) && inputs[0].session_id === inputs[1].session_id && (dialect !== 'codex' || inputs[0].turn_id === inputs[1].turn_id), inputMatches: inputs.length === PHASES.length && inputs.every((input, index) => input?.tool_input?.command === fixture.command(id, PHASES[index])), transcriptExists: lines.length === PHASES.length && lines.every(row => row.transcriptExists === true), sideEffectsValid, resultOwned: requests?.first?.resultOwned === true && requests?.next?.resultOwned === true, firstResultValid: requests?.first?.resultValid === true, firstOriginalOutputPresent: requests?.first?.originalOutputPresent === true, firstEffectTextPresent: requests?.first?.effectTextPresent === true, nextResultClean: requests?.next?.resultValid === true, effectCountValid: requests?.first?.effectCountValid === true && requests?.next?.effectCountValid === true, effectView: requests?.first?.effectView ?? [], nextEffectView: requests?.next?.effectView ?? [] }
}

export function evaluatePosttoolObservations(native, host, dialect, { failedFirst = false } = {}) {
  const booleanFields = [...BOOLEAN_FIELDS, ...(failedFirst ? ['failurePayloadValid'] : [])]
  const cases = CASES[dialect]
  for (const trace of [native, host]) if (!cases || !object(trace) || !DIGEST.test(trace.sourceDigest ?? '') || !DIGEST.test(trace.hookDigest ?? '') || !Array.isArray(trace.controls) || trace.controls.length !== cases.length || !trace.controls.every(object) || !Array.isArray(trace.diagnostics) || !trace.diagnostics.every(value => typeof value === 'string' && DIAGNOSTIC.test(value))) throw new ConformanceError('CONFORMANCE_OBSERVATION_INVALID')
  if (native.sourceDigest !== host.sourceDigest || native.hookDigest !== host.hookDigest) throw new ConformanceError('CONFORMANCE_SOURCE_MISMATCH')
  const safeLayout = (rows, next = false) => Array.isArray(rows) ? rows.slice(0, MAX_LAYOUT_ITEMS).map(row => ({ role: ROLES.includes(row?.role) ? row.role : 'unexpected', placement: PLACEMENTS.includes(row?.placement) ? row.placement : 'unexpected', order: ORDERS.includes(row?.order) ? row.order : 'unexpected', occurrences: Number.isSafeInteger(row?.occurrences) && row.occurrences >= 0 ? row.occurrences : null, ...(next ? { nextOrder: ORDERS.includes(row?.nextOrder) ? row.nextOrder : 'unexpected' } : {}) })) : []
  const safe = trace => ({ diagnostics: [...trace.diagnostics], controls: trace.controls.map((row, index) => ({ id: cases[index], ...Object.fromEntries(NUMBER_FIELDS.map(key => [key, Number.isSafeInteger(row[key]) && row[key] >= 0 ? row[key] : null])), ...Object.fromEntries(booleanFields.map(key => [key, typeof row[key] === 'boolean' ? row[key] : null])), effectView: safeLayout(row.effectView), nextEffectView: safeLayout(row.nextEffectView, true) })) })
  const failures = []
  for (const [backend, trace] of [['native', native], ['host', host]]) {
    if (trace.diagnostics.length) failures.push(backend + '.diagnostics')
    for (const [index, row] of trace.controls.entries()) {
      const id = cases[index], expected = { id, postInvocations: 2, primaryModelCalls: 3, ...Object.fromEntries(booleanFields.map(key => [key, true])), firstOriginalOutputPresent: id !== 'replacement', firstEffectTextPresent: id !== 'noop' }
      for (const [key, value] of Object.entries(expected)) if (row[key] !== value) failures.push(backend + '.' + id + '.' + key)
      const view = safeLayout(row.effectView)
      const validLayout = Array.isArray(row.effectView) && view.length === (id === 'noop' ? 0 : 1) && view.every(item => !Object.values(item).includes('unexpected') && item.occurrences === 1 && (item.placement === 'tool-result' ? item.role === 'tool' && item.order === 'inside' : item.order !== 'inside'))
      if (!validLayout || backend === 'host' && JSON.stringify(view) !== JSON.stringify(safeLayout(native.controls[index].effectView))) failures.push(backend + '.' + id + '.effectLayout')
      const nextView = safeLayout(row.nextEffectView, true)
      const retained = nextView.map(({ nextOrder: _nextOrder, ...item }) => item)
      const validNextLayout = Array.isArray(row.nextEffectView) && nextView.length <= (id === 'noop' ? 0 : 1) && nextView.every(item => item.nextOrder === 'before') && (nextView.length === 0 || JSON.stringify(retained) === JSON.stringify(view))
      if (!validNextLayout || backend === 'host' && JSON.stringify(nextView) !== JSON.stringify(safeLayout(native.controls[index].nextEffectView, true))) failures.push(backend + '.' + id + '.nextEffectLayout')
    }
  }
  return { status: failures.length ? 'failed' : 'passed', comparison: { match: failures.length === 0, sourceDigest: native.sourceDigest, hookDigest: native.hookDigest, compared: [...NUMBER_FIELDS, ...booleanFields, 'effectView', 'nextEffectView'], failures, observations: { native: safe(native), host: safe(host) } } }
}
