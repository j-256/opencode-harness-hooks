import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { backgroundModelEvidence, backgroundUiMessage, compareBackgroundEvidence, compareBackgroundIdleEvidence, createBackgroundHelper } from '../scripts/lib/conformance-background.mjs'

const modes = ['context', 'nonzero', 'control', 'invalid', 'empty']
const system = 'BACKGROUND_SYSTEM', context = 'BACKGROUND_CONTEXT', control = 'BACKGROUND_IGNORED_CONTROL'
const reminders = [system, context].map(text => `<system-reminder>\n${text}\n</system-reminder>`)
function controls(dialect) {
  return modes.map(mode => {
    const info = mode === 'context' || mode === 'nonzero', visible = info && (dialect === 'claude-code' || mode !== 'nonzero')
    const response = info ? { continue: false, decision: 'block', reason: control, systemMessage: system, hookSpecificOutput: { hookEventName: dialect === 'claude-code' ? 'UserPromptSubmit' : 'PreToolUse', additionalContext: context } } : { continue: false, stopReason: control, suppressOutput: true }
    const stdout = mode === 'empty' ? '{}' : mode === 'invalid' ? 'invalid background output' : JSON.stringify(response)
    const hooks = visible ? [{ carrier: dialect === 'claude-code' ? 'tool:one' : 'developer:tool:one', text: dialect === 'claude-code' ? reminders.join('\n\n') : context }] : []
    const artifacts = dialect === 'claude-code' && (info || mode === 'control') ? [{ type: 'async_hook_response', hookEvent: 'UserPromptSubmit', hookName: 'UserPromptSubmit', response, stdout, stderr: mode === 'nonzero' ? 'BACKGROUND_STDERR' : '', exitCode: mode === 'nonzero' ? 1 : 0, rendered: info ? reminders : [], renderedRole: info ? 'system' : null, processOwned: true, carrier: 'tool:one' }] : []
    return { mode, done: true, modelCalls: 3, models: [[], hooks, hooks], ignoredControlVisible: false, ui: dialect === 'codex' && mode === 'context' ? [system] : [], effects: ['one', 'two'], originalResults: true, hookCalls: dialect === 'claude-code' ? 3 : 4, ownedIdentity: true, backgroundEmissions: 1, artifacts, rollout: dialect === 'codex' && visible ? [{ text: context, role: 'developer', kinds: ['hooks.additional_context'], provenance: [{ provenance: { type: 'harness', hook: true } }], ownedTurn: true, carrier: 'tool:one' }] : [] }
  })
}
for (const dialect of ['claude-code', 'codex']) test(`${dialect} active background comparison requires complete independent literal expectations`, () => {
  const native = controls(dialect), host = structuredClone(native)
  assert.equal(compareBackgroundEvidence(dialect, native, host).status, 'passed')
  assert.equal(compareBackgroundEvidence(dialect, native.slice(1), host).status, 'failed')
  assert.equal(compareBackgroundEvidence(dialect, [...native.slice(0, -1), native[0]], host).status, 'failed')
  assert.equal(compareBackgroundEvidence(dialect, native, host.slice(1)).status, 'failed')
  for (const mutate of [
    row => { row.done = false }, row => { row.modelCalls++ }, row => { row.models[1] = [] },
    row => { row.models[1][0].carrier = 'tool:two' }, row => { row.models[1][0].text += '\nChanged' },
    row => { row.models[2].push(...structuredClone(row.models[2])) }, row => { row.ignoredControlVisible = true },
    row => { row.ui.push('Invented UI output') }, row => { row.effects.pop() }, row => { row.originalResults = false },
    row => { row.hookCalls++ }, row => { row.ownedIdentity = false }, row => { row.backgroundEmissions++ },
    ...(dialect === 'claude-code' ? [row => { row.artifacts[0].stdout += '\n' }, row => { row.artifacts[0].processOwned = false }, row => { row.artifacts[0].renderedRole = 'user' }, row => { row.artifacts[0].carrier = 'tool:two' }, row => { row.artifacts[0].response.continue = true }] : [row => { row.rollout[0].ownedTurn = false }, row => { row.rollout[0].provenance = [] }, row => { row.rollout[0].carrier = 'tool:two' }]),
  ]) {
    const wrong = controls(dialect); mutate(wrong[0])
    assert.equal(compareBackgroundEvidence(dialect, native, wrong).status, 'failed')
    assert.equal(compareBackgroundEvidence(dialect, wrong, structuredClone(wrong)).status, 'failed', 'Equally wrong harnesses must not establish conformance')
  }
})

test('idle background comparison requires a genuine next prompt, separate prefix parts, retained placement and no idle wake', () => {
  const make = () => {
    const { effects, originalResults, ...row } = controls('claude-code')[0]
    row.models = [[], ...Array.from({ length: 2 }, () => [{ carrier: 'prompt:two', parts: [reminders[0], reminders[1] + '\n', 'BG_CASE:context BG_NEXT:two'] }])]
    row.artifacts[0].carrier = 'prompt:two'; row.hookCalls = 6
    return [{ ...row, idleWake: false, originalPrompts: true }]
  }
  const native = make(); assert.equal(compareBackgroundIdleEvidence(native, make()).status, 'passed')
  for (const mutate of [
    rows => { rows[0].idleWake = true }, rows => { rows[0].originalPrompts = false },
    rows => { rows[0].models[1][0].parts = [rows[0].models[1][0].parts.join('\n')] },
    rows => { rows[0].models[2][0].carrier = 'prompt:three' }, rows => { rows[0].artifacts[0].carrier = 'prompt:three' },
    rows => { rows[0].backgroundEmissions++ }, rows => { rows[0].modelCalls++ }, rows => { rows.push(structuredClone(rows[0])) },
  ]) {
    const wrong = make(); mutate(wrong)
    assert.equal(compareBackgroundIdleEvidence(native, wrong).status, 'failed')
    assert.equal(compareBackgroundIdleEvidence(wrong, structuredClone(wrong)).status, 'failed')
  }
})

test('wire and UI extraction retain misplaced source markers so additional channel leaks cannot be discarded', () => {
  const tool = { role: 'tool', tool_call_id: 'toolu_background_one', content: 'BG_TOOL_ONE' }
  const developer = { role: 'developer', content: context }
  assert.deepEqual(backgroundModelEvidence([tool, developer]), [{ carrier: 'developer:tool:one', text: context }])
  assert.equal(backgroundModelEvidence([{ ...tool, content: 'BG_TOOL_ONE\n' + context }, developer]).length, 2)
  assert.equal(backgroundModelEvidence([tool, developer, { role: 'developer', content: system }]).length, 2)
  assert.equal(backgroundModelEvidence([tool, developer, { role: 'user', content: context }]).length, 2)
  assert.equal(backgroundUiMessage(system), system)
  assert.equal(backgroundUiMessage(context), context)
  assert.equal(backgroundUiMessage(control), control)
  assert.equal(backgroundUiMessage('Unrelated native message'), undefined)
})

test('an empty later background invocation signals completion before the fixture ends its fast parent response', async t => {
  const root = await mkdtemp(join(tmpdir(), 'background-empty-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const helper = join(root, 'helper.cjs'); await writeFile(helper, createBackgroundHelper(root, 'claude-code'))
  const stdout = await new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [helper, 'background'], { timeout: 3000 }, (error, text) => error ? reject(error) : resolve(text))
    child.stdin.end(JSON.stringify({ session_id: 'owned', hook_event_name: 'UserPromptSubmit', prompt: 'BG_CASE:context BG_NEXT:two' }))
  })
  assert.equal(stdout, '{}')
  assert.equal(await readFile(join(root, 'ready-two'), 'utf8'), 'completed')
  assert.equal(JSON.parse(await readFile(join(root, 'trace.jsonl'), 'utf8')).first, false)
})

test('the executable Claude recorder verifies the parent chain across unrelated attachments without crossing message boundaries', async t => {
  const root = await mkdtemp(join(tmpdir(), 'background-recorder-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const helper = join(root, 'helper.cjs'), transcript = join(root, 'transcript.jsonl'), trace = join(root, 'trace.jsonl')
  await writeFile(helper, createBackgroundHelper(root, 'claude-code'))
  const result = { type: 'user', uuid: 'tool-result', parentUuid: 'assistant-one', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_background_one', content: 'BG_TOOL_ONE' }] } }
  const unrelated = { type: 'attachment', uuid: 'unrelated', parentUuid: result.uuid, attachment: { type: 'synthetic-unrelated' } }
  const background = { type: 'attachment', uuid: 'background', parentUuid: unrelated.uuid, attachment: { type: 'async_hook_response', processId: 'async_hook_123' } }
  for (const [middle, valid] of [
    [[unrelated], true],
    [[{ ...unrelated, parentUuid: 'foreign' }], false],
    [[{ ...unrelated, type: 'assistant', message: { role: 'assistant', content: [] } }], false],
    [[{ ...unrelated, type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Next genuine prompt' }] } }], false],
    [[{ ...unrelated, type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_background_two', content: 'BG_TOOL_TWO' }] } }], false],
  ]) {
    await writeFile(trace, '')
    await writeFile(transcript, [result, ...middle, background].map(row => JSON.stringify(row)).join('\n') + '\n')
    await new Promise((resolve, reject) => {
      const child = execFile(process.execPath, [helper, 'record'], { timeout: 3000 }, error => error ? reject(error) : resolve())
      child.stdin.end(JSON.stringify({ session_id: 'owned', hook_event_name: 'PreToolUse', transcript_path: transcript }))
    })
    const row = JSON.parse(await readFile(trace, 'utf8'))
    assert.equal(row.rows.length, 1)
    assert.equal(row.rows[0].carrier === 'tool:one', valid)
  }
})
