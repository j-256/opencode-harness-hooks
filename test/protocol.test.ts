import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HOOK_EVENTS } from '../src/contracts.js'
import type { Dialect } from '../src/contracts.js'
import type { NativeEvent, Registration } from '../src/types.js'
import type { ExecutionResult } from '../src/runner.js'
import { readFile } from 'node:fs/promises'

const event = (name: string): NativeEvent => ({ event: name, sessionID: 'session', cwd: '/project', tool: 'bash', toolInput: { command: 'original' } })
const reg = (dialect: Dialect, name: string, extra = {}): Registration => ({ id: 'registration', sourceID: 'source', dialect, event: name, groupIndex: 0, handlerIndex: 0, handler: { type: 'command', command: 'SECRET_SENTINEL', ...extra } })
const result = (stdout: unknown, exitCode = 0, stderr = ''): ExecutionResult => ({ status: 'exited', exitCode, signal: null, stdout: typeof stdout === 'string' ? stdout : JSON.stringify(stdout), stderr, durationMs: 3 })
const specific = (name: string, fields: Record<string, unknown>) => ({ hookSpecificOutput: { hookEventName: name, ...fields } })

test('Claude permission outcomes remain distinct and input replacement preserves its entire object', async () => {
  const { interpretOutput } = await import('../src/protocol.js')
  for (const decision of ['allow', 'deny', 'ask', 'defer']) {
    const effect = interpretOutput(reg('claude-code', 'PreToolUse'), event('PreToolUse'), result(specific('PreToolUse', { permissionDecision: decision, permissionDecisionReason: 'reason', updatedInput: { command: 'new', description: 'kept' }, additionalContext: 'context' })))
    assert.equal(effect.status, 'success')
    assert.deepEqual(effect.actions.find(a => a.kind === 'permission'), { kind: 'permission', decision, reason: 'reason' })
    assert.equal(effect.actions.some(a => a.kind === 'replace-input'), decision !== 'defer')
    assert.equal(effect.actions.some(a => a.kind === 'context'), decision !== 'defer')
  }
  const effect = interpretOutput(reg('claude-code', 'PreToolUse'), event('PreToolUse'), result(specific('PreToolUse', { updatedInput: { command: 'new', description: 'kept' } })))
  assert.deepEqual(effect.actions, [{ kind: 'replace-input', input: { command: 'new', description: 'kept' } }])
})

test('Codex preserves native unsupported controls instead of granting or denying them', async () => {
  const { interpretOutput } = await import('../src/protocol.js')
  const cases = [
    specific('PreToolUse', { permissionDecision: 'ask', permissionDecisionReason: 'reason' }),
    specific('PreToolUse', { permissionDecision: 'allow' }),
    specific('PreToolUse', { permissionDecision: 'deny' }),
    specific('PreToolUse', { updatedInput: { command: 'new' } }),
    specific('PreToolUse', { permissionDecision: 'allow', updatedInput: { other: 'missing command' } }),
    { decision: 'approve' }, { continue: false }, { stopReason: 'reason' }, { suppressOutput: true },
  ]
  for (const output of cases) {
    const effect = interpretOutput(reg('codex', 'PreToolUse'), event('PreToolUse'), result(output))
    assert.equal(effect.status, 'failed', JSON.stringify(output))
    assert.equal(effect.actions.some(a => ['permission', 'replace-input', 'stop-session'].includes(a.kind)), false)
  }
  const rewrite = interpretOutput(reg('codex', 'PreToolUse'), event('PreToolUse'), result(specific('PreToolUse', { permissionDecision: 'allow', updatedInput: { command: 'new' } })))
  assert.deepEqual(rewrite.actions, [{ kind: 'replace-input', input: { command: 'new' } }])
})

test('legacy decisions and source exit-code precedence follow the pinned native contracts', async () => {
  const { interpretOutput } = await import('../src/protocol.js')
  const deny = { decision: 'block', reason: 'denied' }
  for (const dialect of ['claude-code', 'codex'] as const) {
    assert.deepEqual(interpretOutput(reg(dialect, 'PreToolUse'), event('PreToolUse'), result(deny)).actions, [{ kind: 'permission', decision: 'deny', reason: 'denied' }])
  }
  const allow = specific('PreToolUse', { permissionDecision: 'allow' })
  assert.equal(interpretOutput(reg('claude-code', 'PreToolUse'), event('PreToolUse'), result(allow, 1)).status, 'success')
  assert.equal(interpretOutput(reg('codex', 'PreToolUse'), event('PreToolUse'), result(deny, 1)).status, 'failed')
  assert.deepEqual(interpretOutput(reg('claude-code', 'PreToolUse'), event('PreToolUse'), result(allow, 2, 'stderr denial')).actions.filter(a => a.kind === 'permission'), [{ kind: 'permission', decision: 'deny', reason: 'stderr denial' }])
  assert.equal(interpretOutput(reg('codex', 'PreToolUse'), event('PreToolUse'), result('', 2, '')).status, 'failed')
})

test('Stop continuation and continue:false retain dialect and event semantics', async () => {
  const { interpretOutput } = await import('../src/protocol.js')
  for (const name of ['Stop', 'SubagentStop']) {
    const claude = interpretOutput(reg('claude-code', name), event(name), result({ decision: 'block', reason: 'continue' }))
    const codex = interpretOutput(reg('codex', name), event(name), result({ decision: 'block', reason: 'continue' }))
    assert.deepEqual(claude.actions, [{ kind: 'continue-turn', text: 'continue', mode: 'feedback' }])
    assert.deepEqual(codex.actions, [{ kind: 'continue-turn', text: 'continue', mode: 'user' }])
    assert.deepEqual(interpretOutput(reg('claude-code', name), event(name), result(specific(name, { additionalContext: 'feedback' }))).actions, [{ kind: 'continue-turn', text: 'feedback', mode: 'feedback' }])
    for (const dialect of ['claude-code', 'codex'] as const) {
      const stopped = interpretOutput(reg(dialect, name), event(name), result({ continue: false, stopReason: 'stop', decision: 'block', reason: 'ignored' }))
      assert.deepEqual(stopped.actions, [{ kind: 'stop-session', reason: 'stop' }])
    }
  }
  assert.deepEqual(interpretOutput(reg('codex', 'SubagentStart'), event('SubagentStart'), result({ continue: false })).actions, [])
  assert.deepEqual(interpretOutput(reg('codex', 'PreCompact'), event('PreCompact'), result({ continue: false })).actions, [{ kind: 'stop-session', reason: '' }])
})

for (const row of [
  { name: 'ignores parsed approval', output: { decision: 'approve', reason: 'Ignored' }, exit: 0, actions: [] },
  { name: 'ignores empty additional context', output: specific('Stop', { additionalContext: '' }), exit: 0, actions: [] },
  { name: 'defaults an empty block reason', output: { decision: 'block', reason: '' }, exit: 0, actions: [{ kind: 'continue-turn', text: 'Blocked by hook', mode: 'feedback' }] },
  { name: 'defaults a missing block reason', output: { decision: 'block' }, exit: 0, actions: [{ kind: 'continue-turn', text: 'Blocked by hook', mode: 'feedback' }] },
  { name: 'preserves a whitespace block reason', output: { decision: 'block', reason: '   ' }, exit: 0, actions: [{ kind: 'continue-turn', text: '   ', mode: 'feedback' }] },
  { name: 'preserves whitespace additional context', output: specific('Stop', { additionalContext: '   ' }), exit: 0, actions: [{ kind: 'continue-turn', text: '   ', mode: 'feedback' }] },
  { name: 'defaults empty blocking stderr', output: '', exit: 2, actions: [{ kind: 'continue-turn', text: 'No stderr output', mode: 'feedback' }] },
  { name: 'preserves whitespace blocking stderr', output: '', exit: 2, stderr: '   ', actions: [{ kind: 'continue-turn', text: '   ', mode: 'feedback' }] },
]) test(`Claude Stop native output ${row.name}`, async () => {
  const { interpretOutput } = await import('../src/protocol.js')
  const effect = interpretOutput(reg('claude-code', 'Stop'), event('Stop'), result(row.output, row.exit, 'stderr' in row ? row.stderr : ''))
  assert.equal(effect.status, 'success')
  assert.deepEqual(effect.actions, row.actions)
})

test('post-tool feedback does not retroactively deny an effect and differs by dialect', async () => {
  const { interpretOutput } = await import('../src/protocol.js')
  const output = { decision: 'block', reason: 'review result' }
  assert.deepEqual(interpretOutput(reg('claude-code', 'PostToolUse'), event('PostToolUse'), result(output)).actions, [{ kind: 'feedback', text: 'review result' }])
  assert.deepEqual(interpretOutput(reg('codex', 'PostToolUse'), event('PostToolUse'), result(output)).actions, [{ kind: 'replace-result', output: 'review result', rejectNested: true }])
  assert.deepEqual(interpretOutput(reg('codex', 'PostToolUse'), event('PostToolUse'), result({ continue: false, stopReason: 'replacement' })).actions, [{ kind: 'replace-result', output: 'replacement', rejectNested: false }])
  const replace = specific('PostToolUse', { updatedToolOutput: { text: 'redacted' } })
  assert.deepEqual(interpretOutput(reg('claude-code', 'PostToolUse'), event('PostToolUse'), result(replace)).actions, [{ kind: 'replace-result', output: { text: 'redacted' }, rejectNested: false }])
})

test('permission request decisions retain native input, permission updates, and interrupt behavior', async () => {
  const { interpretOutput } = await import('../src/protocol.js')
  const output = specific('PermissionRequest', { decision: { behavior: 'allow', updatedInput: { command: 'safe' }, updatedPermissions: [{ type: 'addRules', behavior: 'allow', destination: 'session', rules: [{ toolName: 'Bash', ruleContent: 'npm test' }] }] } })
  const effect = interpretOutput(reg('claude-code', 'PermissionRequest'), event('PermissionRequest'), result(output))
  assert.ok(effect.actions.some(a => a.kind === 'permission' && a.decision === 'allow'))
  assert.ok(effect.actions.some(a => a.kind === 'replace-input'))
  assert.ok(effect.actions.some(a => a.kind === 'native-extension' && a.name === 'updatedPermissions'))
  assert.equal(interpretOutput(reg('codex', 'PermissionRequest'), event('PermissionRequest'), result(output)).status, 'failed')
  assert.deepEqual(interpretOutput(reg('claude-code', 'PermissionRequest'), event('PermissionRequest'), result('', 2, 'no')).actions, [])
  const deny = specific('PermissionRequest', { decision: { behavior: 'deny', message: 'no', interrupt: true } })
  assert.ok(interpretOutput(reg('claude-code', 'PermissionRequest'), event('PermissionRequest'), result(deny)).actions.some(a => a.kind === 'stop-session'))
})

test('plain text, malformed JSON, and foreign event outputs are handled by dialect and event', async () => {
  const { interpretOutput } = await import('../src/protocol.js')
  const read = (dialect: Dialect, name: string, output: unknown) => interpretOutput(reg(dialect, name), event(name), result(output))
  for (const dialect of ['claude-code', 'codex'] as const) {
    assert.deepEqual(read(dialect, 'SessionStart', 'plain context').actions, [{ kind: 'context', text: 'plain context', placement: 'model', ...(dialect === 'claude-code' ? { channel: 'stdout' } : {}) }])
    assert.deepEqual(read(dialect, 'PreToolUse', 'plain context').actions, [])
    assert.equal(read(dialect, 'PreToolUse', '{broken}').status, 'failed')
    assert.equal(read(dialect, 'PreToolUse', specific('Unknown', { permissionDecision: 'deny' })).status, 'failed')
  }
  assert.equal(read('claude-code', 'Stop', 'plain output').status, 'success')
  assert.equal(read('codex', 'Stop', 'plain output').status, 'failed')
  assert.deepEqual(read('claude-code', 'PreCompact', 'summary instruction').actions, [{ kind: 'context', text: 'summary instruction', placement: 'compaction', channel: 'stdout' }])
  assert.deepEqual(read('codex', 'PreCompact', 'summary instruction').actions, [])
  assert.equal(read('codex', 'PreToolUse', { unknownField: true }).status, 'failed')
  const nativeForeignTag = read('codex', 'PreToolUse', specific('Stop', { permissionDecision: 'deny', permissionDecisionReason: 'native accepted tag' }))
  assert.deepEqual(nativeForeignTag.actions, [{ kind: 'permission', decision: 'deny', reason: 'native accepted tag' }])
  assert.equal(read('claude-code', 'PreToolUse', specific('Stop', { permissionDecision: 'deny' })).status, 'failed')
})

test('observational events discard controls while retaining separately supported extensions', async () => {
  const { interpretOutput } = await import('../src/protocol.js')
  for (const name of ['Setup', 'InstructionsLoaded', 'Notification', 'StopFailure', 'SessionEnd', 'PostCompact']) {
    const effect = interpretOutput(reg('claude-code', name), event(name), result({ continue: false, systemMessage: 'ignored' }))
    assert.deepEqual(effect.actions, [], name)
  }
  for (const name of ['PreModelRequest', 'PostModelRequest', 'SessionEnd']) {
    assert.deepEqual(interpretOutput(reg('codex', name), event(name), result({ continue: false, decision: 'block', reason: 'ignored' })).actions, [])
  }
  const title = interpretOutput(reg('claude-code', 'SessionStart'), event('SessionStart'), result(specific('SessionStart', { sessionTitle: 'title', reloadSkills: true, watchPaths: ['/project/a'] })))
  assert.deepEqual(title.actions.filter(a => a.kind === 'native-extension').map(a => a.name).sort(), ['reloadSkills', 'sessionTitle', 'watchPaths'])
})

test('failures follow onFailure only where the native source honors it, with private diagnostics', async () => {
  const { interpretOutput } = await import('../src/protocol.js')
  const unavailable: ExecutionResult = { ...result('SECRET_SENTINEL', 0, 'SECRET_SENTINEL'), status: 'timeout', exitCode: null }
  const effect = interpretOutput(reg('claude-code', 'PreToolUse', { onFailure: 'block' }), event('PreToolUse'), unavailable)
  assert.equal(effect.status, 'failed')
  assert.ok(effect.actions.some(a => a.kind === 'permission' && a.decision === 'deny'))
  assert.equal(JSON.stringify(effect.diagnostic).includes('SECRET_SENTINEL'), false)
  for (const dialect of ['claude-code', 'codex'] as const) {
    const stop = interpretOutput(reg(dialect, 'Stop', { onFailure: 'block' }), event('Stop'), unavailable)
    assert.equal(stop.status, 'failed')
    assert.deepEqual(stop.actions, [])
  }
})

test('each inventoried event has an explicit empty-output path without implying host equivalence', async () => {
  const { interpretOutput } = await import('../src/protocol.js')
  for (const dialect of ['claude-code', 'codex'] as const) {
    for (const name of HOOK_EVENTS[dialect]) {
      const effect = interpretOutput(reg(dialect, name), event(name), result(''))
      assert.equal(effect.status, name === 'WorktreeCreate' ? 'failed' : 'success', `${dialect}:${name}`)
      assert.equal(effect.diagnostic.event, name)
    }
  }
})

test('matches independently compiled pinned Codex parser results for seeded wire mutations', async () => {
  const { interpretOutput } = await import('../src/protocol.js')
  const oracle = JSON.parse(await readFile(new URL('./fixtures/codex-output-oracle.json', import.meta.url), 'utf8')) as { cases: { stdout: string; status: string; actions: unknown[] }[] }
  for (const [index, fixture] of oracle.cases.entries()) {
    const actual = interpretOutput(reg('codex', 'PreToolUse'), event('PreToolUse'), result(fixture.stdout))
    assert.equal(actual.status, fixture.status, `native case ${index}`)
    assert.deepEqual(actual.actions, fixture.actions, `native case ${index}`)
  }
})

test('Claude distinguishes task, tool-batch, and managed configuration decisions', async () => {
  const { interpretOutput } = await import('../src/protocol.js')
  const block = result({ decision: 'block', reason: 'blocked' })
  assert.deepEqual(interpretOutput(reg('claude-code', 'TeammateIdle'), event('TeammateIdle'), block).actions, [])
  assert.deepEqual(interpretOutput(reg('claude-code', 'PostToolBatch'), event('PostToolBatch'), block).actions, [{ kind: 'block-event', reason: 'blocked' }])
  const managed = { ...event('ConfigChange'), data: { source: 'policy_settings' } }
  assert.deepEqual(interpretOutput(reg('claude-code', 'ConfigChange'), managed, block).actions, [])
})

test('Claude treats multiple JSON log lines as text only when none sets a hook output field', async () => {
  const { interpretOutput } = await import('../src/protocol.js')
  const logs = '{"log":"first"}\n{"log":"second"}'
  assert.deepEqual(interpretOutput(reg('claude-code', 'SessionStart'), event('SessionStart'), result(logs)).actions, [{ kind: 'context', text: logs, placement: 'model', channel: 'stdout' }])
  const mixed = '{"log":"first"}\n{"continue":false}'
  assert.equal(interpretOutput(reg('claude-code', 'SessionStart'), event('SessionStart'), result(mixed)).status, 'failed')
})

test('Claude preserves elicitation, display, watcher, and output-replacement extensions without inventing host support', async () => {
  const { interpretOutput } = await import('../src/protocol.js')
  for (const name of ['Elicitation', 'ElicitationResult']) {
    const output = specific(name, { action: 'accept', content: { answer: 'yes' } })
    assert.deepEqual(interpretOutput(reg('claude-code', name), event(name), result(output)).actions, [{ kind: 'native-extension', name: 'elicitation', value: { action: 'accept', content: { answer: 'yes' } } }])
    assert.deepEqual(interpretOutput(reg('claude-code', name), event(name), result(output, 2, 'blocked')).actions, [{ kind: 'native-extension', name: 'elicitation', value: { action: 'decline' } }])
  }
  for (const name of ['CwdChanged', 'FileChanged']) {
    const output = { continue: false, ...specific(name, { watchPaths: ['/project/a'] }) }
    assert.deepEqual(interpretOutput(reg('claude-code', name), event(name), result(output)).actions, [{ kind: 'native-extension', name: 'watchPaths', value: ['/project/a'] }])
  }
  const display = { continue: false, systemMessage: 'ignored', ...specific('MessageDisplay', { displayContent: 'visible' }) }
  assert.deepEqual(interpretOutput(reg('claude-code', 'MessageDisplay'), event('MessageDisplay'), result(display)).actions, [{ kind: 'native-extension', name: 'displayContent', value: 'visible' }])
})

test('Claude terminal notifications reject disallowed sequences even on observational events', async () => {
  const { interpretOutput } = await import('../src/protocol.js')
  const sequence = '\u001b]777;notify;title;body\u0007'
  const accepted = interpretOutput(reg('claude-code', 'Notification'), event('Notification'), result({ terminalSequence: sequence }))
  assert.deepEqual(accepted.actions, [{ kind: 'native-extension', name: 'terminalSequence', value: sequence }])
  for (const terminalSequence of ['\u001b]52;c;clipboard\u0007', '\u001b[31m', 'text\u0007']) {
    assert.deepEqual(interpretOutput(reg('claude-code', 'Notification'), event('Notification'), result({ terminalSequence })).actions, [])
  }
})

test('Claude validates each permission-update family before requesting host effects', async () => {
  const { interpretOutput } = await import('../src/protocol.js')
  const updates = [
    ...['addRules', 'replaceRules', 'removeRules'].map(type => ({ type, destination: 'session', behavior: 'allow', rules: [{ toolName: 'Bash', ruleContent: 'npm test' }] })),
    { type: 'setMode', destination: 'session', mode: 'manual' },
    { type: 'addDirectories', destination: 'session', directories: ['/project/extra'] },
    { type: 'removeDirectories', destination: 'session', directories: ['/project/extra'] },
  ]
  const run = (updatedPermissions: unknown) => interpretOutput(reg('claude-code', 'PermissionRequest'), event('PermissionRequest'), result(specific('PermissionRequest', { decision: { behavior: 'allow', updatedPermissions } })))
  assert.deepEqual(run(updates).actions.find(a => a.kind === 'native-extension'), { kind: 'native-extension', name: 'updatedPermissions', value: updates })
  for (const invalid of [
    { type: 'unknown', destination: 'session' },
    { type: 'setMode', destination: 'unknown', mode: 'default' },
    { type: 'setMode', destination: 'session', mode: 'unknown' },
    { type: 'addRules', destination: 'session', behavior: 'allow', rules: [{ toolName: 7 }] },
    { type: 'removeDirectories', destination: 'session', directories: [7] },
  ]) {
    const effect = run([invalid])
    assert.equal(effect.status, 'failed', JSON.stringify(invalid))
    assert.deepEqual(effect.actions, [])
  }
})

test('Claude model-switch timeout blocks the switch without an explicit failure policy', async () => {
  const { interpretOutput } = await import('../src/protocol.js')
  const effect = interpretOutput(reg('claude-code', 'PreModelSwitch'), event('PreModelSwitch'), { ...result(''), status: 'timeout', exitCode: null })
  assert.equal(effect.status, 'failed')
  assert.equal(effect.actions[0]?.kind, 'permission')
})

test('Claude worktree creation fails closed when its command cannot start', async () => {
  const { interpretOutput } = await import('../src/protocol.js')
  const effect = interpretOutput(reg('claude-code', 'WorktreeCreate'), event('WorktreeCreate'), { ...result(''), status: 'spawn-error', exitCode: null })
  assert.equal(effect.status, 'failed')
  assert.equal(effect.actions[0]?.kind, 'block-event')
  const exited = interpretOutput(reg('claude-code', 'WorktreeCreate'), event('WorktreeCreate'), { ...result(''), exitCode: 1, stderr: 'Creation failed' })
  assert.equal(exited.actions.length, 1)
})
