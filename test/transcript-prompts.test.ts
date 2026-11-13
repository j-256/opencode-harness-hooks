import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { ClaudeTranscript } from '../src/transcript.js'
import { createRuntime } from '../src/runtime.js'
import type { HostPromptEvent } from '../src/prompt-types.js'
import type { HostToolEvent } from '../src/hosts/tools.js'

const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'"
const CREATED = Date.parse('2026-01-01T00:00:00Z')
async function fixture(t: { after: (callback: () => Promise<void>) => void }, host: 'v1' | 'v2' = 'v2', modes = ['additional', 'stdout', 'additional']) {
  const directory = await mkdtemp(join(tmpdir(), 'harness-prompt-artifacts-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const script = join(directory, 'hook.cjs')
  await writeFile(script, `const mode=process.argv[2];if(mode.startsWith('timeout')){process.stdout.write('Timeout stdout\\n');process.stderr.write('Timeout stderr\\n');setInterval(()=>{},1000);return}if(mode==='signal-json'){console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'UserPromptSubmit',additionalContext:'Signal context'}}));process.kill(process.pid,'SIGTERM');return}if(mode.startsWith('signal-')){process.stdout.write('Signal stdout\\n');process.stderr.write('Signal stderr\\n');process.kill(process.pid,mode.slice(7));return}setTimeout(()=>{if(mode==='failure'){process.stdout.write('Failure stdout\\n');process.stderr.write(' \\n Failure stderr \\t\\n');process.exit(1)}if(mode==='empty-failure'){process.stderr.write(' \\t\\n');process.exit(3)}if(mode==='stdout'){process.stdout.write('Context stdout\\n');process.stderr.write('Captured stderr\\n')}else {console.log(JSON.stringify({systemMessage:'Prompt warning',hookSpecificOutput:{hookEventName:'UserPromptSubmit',additionalContext:'Context additional'}}));if(mode==='nonzero-json')process.exitCode=5}},mode==='stdout'?0:200)`)
  const command = quote(process.execPath) + ' ' + quote(script)
  const text = JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: modes.map(mode => ({ type: 'command', ...(mode.startsWith('signal-') ? { command: process.execPath, args: [script, mode] } : { command: command + ' ' + mode }), ...(mode.startsWith('timeout') ? { timeout: 0.15 } : {}), ...(mode === 'timeout-block' ? { onFailure: 'block' } : {}) })) }] } })
  await writeFile(join(directory, 'hooks.json'), text)
  let history: readonly unknown[] = []
  const transcripts = new ClaudeTranscript({ host, directory, history: async () => ({ id: 'session', messages: history }) })
  const runtime = await createRuntime(host, directory, { sources: [{ id: 'claude', dialect: 'claude-code', path: 'hooks.json' }], reviewedDigests: { claude: createHash('sha256').update(text).digest('hex') }, permissionMode: 'default' }, { transcripts, report: () => {}, dispatchDiagnostic: () => {} })
  t.after(() => runtime.dispose())
  runtime.sessions.prompt('session', 'turn', 'fixture')
  const prompt: HostPromptEvent = { host, event: 'UserPromptSubmit', sessionID: 'session', messageID: 'turn', prompt: 'User prompt', signal: runtime.sessions.get('session').turnSignal }
  const tool: HostToolEvent = { host, event: 'PreToolUse', sessionID: 'session', callID: 'call', tool: host === 'v1' ? 'bash' : 'shell', toolInput: { command: 'original' }, effectiveInput: { command: 'original' }, signal: prompt.signal }
  const admitHistory = (promptText = 'User prompt') => { runtime.observeModel({ host, sessionID: 'session', messageID: 'turn', signal: runtime.sessions.get('session').turnSignal }); history = host === 'v1' ? [
    { info: { role: 'user', id: 'turn', sessionID: 'session', time: { created: CREATED } }, parts: [{ type: 'text', text: promptText }] },
    { info: { role: 'assistant', id: 'answer', parentID: 'turn', sessionID: 'session', modelID: 'fixture', time: { created: CREATED + 1 } }, parts: [{ type: 'tool', tool: 'bash', callID: 'call', state: { status: 'running' } }] },
  ] : [
    { type: 'user', id: 'turn', text: promptText, time: { created: CREATED } },
    { type: 'assistant', id: 'answer', model: { id: 'fixture' }, time: { created: CREATED + 1 }, content: [{ type: 'tool', name: 'shell', id: 'call', state: { status: 'running' } }] },
  ] }
  return { directory, runtime, transcripts, prompt, tool, admitHistory, modes }
}

test('both hosts publish admitted Claude prompt attachments with raw command data and stable native identities', async t => {
  for (const host of ['v1', 'v2'] as const) {
    const f = await fixture(t, host)
    const dispatch = await f.runtime.prompt(f.prompt)
    assert.ok(dispatch.entries.every(entry => 'commandArtifact' in entry.result && entry.result.commandArtifact))
    f.runtime.admitPrompt(f.prompt, dispatch)
    const session = f.runtime.sessions.get('session')
    const reserved = await f.transcripts.prepare(f.prompt, session, f.prompt.signal)
    await assert.rejects(access(reserved))
    f.admitHistory()
    f.transcripts.observe(f.tool, session)
    assert.equal(await f.transcripts.prepare(f.tool, session, f.tool.signal), reserved)
    const rows = (await readFile(reserved, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    assert.equal(rows[0].message.content, 'User prompt')
    const attachments = rows.filter(row => row.type === 'attachment' && row.attachment.hookEvent === 'UserPromptSubmit')
    const expectedTypes = [...dispatch.entries].sort((left, right) => left.completionOrder - right.completionOrder).flatMap(entry => f.modes[entry.configuredOrder] === 'stdout' ? ['hook_success'] : ['hook_system_message', 'hook_additional_context'])
    assert.deepEqual(attachments.map(row => row.attachment.type), expectedTypes)
    assert.equal(attachments.filter(row => row.attachment.type === 'hook_additional_context').length, 2)
    const success = attachments.find(row => row.attachment.type === 'hook_success')
    assert.equal(success.attachment.stdout, 'Context stdout\n')
    assert.equal(success.attachment.stderr, 'Captured stderr\n')
    assert.equal(success.attachment.content, 'Context stdout')
    assert.equal(success.attachment.exitCode, 0)
    assert.ok(success.attachment.durationMs >= 0)
    assert.ok(success.attachment.command.includes(' stdout'))
    assert.equal(success.renderedRole, 'system')
    assert.equal(success.rendered[0].content, '<system-reminder>\nUserPromptSubmit hook success: Context stdout\n</system-reminder>')
    const sharedIDs = attachments.filter(row => row.attachment.type !== 'hook_additional_context').map(row => row.attachment.toolUseID)
    assert.equal(new Set(sharedIDs).size, 1)
    const additionalIDs = attachments.filter(row => row.attachment.type === 'hook_additional_context').map(row => row.attachment.toolUseID)
    assert.equal(new Set(additionalIDs).size, 2)
    assert.ok(additionalIDs.every(id => /^hook-/.test(id)))
    for (let index = 1; index < rows.length; index++) assert.equal(rows[index].parentUuid, rows[index - 1].uuid)
    const before = await readFile(reserved, 'utf8')
    await f.transcripts.prepare(f.tool, session, f.tool.signal)
    assert.equal(await readFile(reserved, 'utf8'), before)
    assert.ok(!JSON.stringify(dispatch.diagnostic).includes('Captured stderr'))
    assert.ok(!JSON.stringify(f.transcripts.inspect()).includes('Context stdout'))
    f.runtime.sessions.close('session')
    assert.equal(f.transcripts.inspect().promptBytes, 0)
    assert.equal(f.transcripts.inspect().promptTurns, 0)
  }
})

test('stale, repeated, foreign and incomplete prompt artifact admission cannot alter retained history', async t => {
  const f = await fixture(t)
  const dispatch = await f.runtime.prompt(f.prompt)
  const missing = { ...dispatch, entries: dispatch.entries.map(({ result, ...origin }) => ({ ...origin, result: Object.fromEntries(Object.entries(result).filter(([key]) => key !== 'commandArtifact')) as typeof result })) }
  assert.throws(() => f.runtime.admitPrompt(f.prompt, missing), { code: 'TRANSCRIPT_HOOK_EXECUTION_UNAVAILABLE' })
  assert.throws(() => f.runtime.admitPrompt(f.prompt, { ...dispatch, diagnostic: { ...dispatch.diagnostic, sessionID: 'foreign' } }), { code: 'TRANSCRIPT_DISPATCH_MISMATCH' })
  f.runtime.admitPrompt(f.prompt, dispatch)
  const retained = f.transcripts.inspect()
  assert.throws(() => f.runtime.admitPrompt(f.prompt, dispatch), { code: 'TRANSCRIPT_PROMPT_ID_REUSED' })
  f.runtime.sessions.prompt('session', 'next', 'fixture')
  assert.throws(() => f.runtime.admitPrompt(f.prompt, dispatch), { code: 'SESSION_STALE_TURN' })
  assert.equal(f.transcripts.inspect().promptBytes, retained.promptBytes)
})

test('unadmitted or changed native prompt history fails before replacing its reserved artifact', async t => {
  const f = await fixture(t)
  const dispatch = await f.runtime.prompt(f.prompt)
  f.admitHistory()
  const session = f.runtime.sessions.get('session')
  f.transcripts.observe(f.tool, session)
  await assert.rejects(f.transcripts.prepare(f.tool, session, f.tool.signal), { code: 'TRANSCRIPT_PROMPT_HISTORY_UNAVAILABLE' })
  f.runtime.admitPrompt(f.prompt, dispatch)
  const path = await f.transcripts.prepare(f.tool, session, f.tool.signal)
  const published = await readFile(path, 'utf8')
  assert.ok(published.includes('hook_additional_context'))
  f.admitHistory('Changed original prompt')
  await assert.rejects(f.transcripts.prepare(f.tool, session, f.tool.signal), { code: 'TRANSCRIPT_PROMPT_HISTORY_UNAVAILABLE' })
  assert.equal(await readFile(path, 'utf8'), published)
})

test('unsupported native hook failure artifacts do not become successful prompt receipts', async t => {
  const f = await fixture(t)
  const dispatch = await f.runtime.prompt(f.prompt)
  const failed = { ...dispatch, entries: dispatch.entries.map(({ result, ...origin }) => ({ ...origin, result: { ...result, status: 'failed' as const, diagnostic: { ...result.diagnostic, outcome: 'failed' as const } } })) }
  assert.throws(() => f.runtime.admitPrompt(f.prompt, failed), { code: 'TRANSCRIPT_HOOK_RESULT_UNSUPPORTED' })
  assert.equal(f.transcripts.inspect().promptTurns, 0)
})

test('both hosts admit nonblocking command failures as private native error attachments', async t => {
  for (const host of ['v1', 'v2'] as const) {
    const f = await fixture(t, host, ['failure', 'stdout', 'empty-failure'])
    const dispatch = await f.runtime.prompt(f.prompt)
    assert.equal(dispatch.diagnostic.failed, 2)
    assert.ok(!dispatch.actions.some(row => row.action.kind === 'block-event' || row.action.kind === 'context' && row.action.text.includes('Failure')))
    f.runtime.admitPrompt(f.prompt, dispatch)
    f.admitHistory()
    const session = f.runtime.sessions.get('session')
    f.transcripts.observe(f.tool, session)
    const path = await f.transcripts.prepare(f.tool, session, f.tool.signal)
    const rows = (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    const attachments = rows.filter(row => row.attachment?.hookEvent === 'UserPromptSubmit')
    const errors = attachments.filter(row => row.attachment.type === 'hook_non_blocking_error').sort((a, b) => a.attachment.exitCode - b.attachment.exitCode)
    assert.equal(errors.length, 2)
    assert.deepEqual(errors.map(row => [row.attachment.stdout, row.attachment.stderr, row.attachment.exitCode]), [
      ['Failure stdout\n', 'Failed with non-blocking status code: Failure stderr', 1],
      ['', 'Failed with non-blocking status code: No stderr output', 3],
    ])
    assert.equal(new Set(attachments.map(row => row.attachment.toolUseID)).size, 1)
    for (const row of errors) {
      assert.ok(!Object.hasOwn(row, 'rendered') && !Object.hasOwn(row, 'renderedRole'))
      assert.ok(!Object.hasOwn(row.attachment, 'content'))
      assert.ok(row.attachment.command.includes(row.attachment.exitCode === 1 ? ' failure' : ' empty-failure'))
      assert.ok(row.attachment.durationMs >= 0)
      assert.ok(rows.indexOf(row) > 0 && rows.indexOf(row) < rows.findIndex(row => row.type === 'assistant'))
    }
    const orderedExecutions = [...dispatch.entries].sort((a, b) => a.completionOrder - b.completionOrder)
    assert.deepEqual(attachments.map(row => row.attachment.command), orderedExecutions.map(entry => 'commandArtifact' in entry.result ? entry.result.commandArtifact?.command : undefined))
    const before = await readFile(path, 'utf8')
    await f.transcripts.prepare(f.tool, session, f.tool.signal)
    assert.equal(await readFile(path, 'utf8'), before)
    assert.ok(!JSON.stringify(dispatch.diagnostic).includes('Failure stderr'))
    f.runtime.sessions.close('session')
    assert.equal(f.transcripts.inspect().promptAttachments, 0)
    assert.equal(f.transcripts.inspect().promptBytes, 0)
  }
})

test('valid structured output on nonzero exit retains native warning and context records', async t => {
  for (const host of ['v1', 'v2'] as const) {
    const f = await fixture(t, host, ['nonzero-json'])
    const dispatch = await f.runtime.prompt(f.prompt)
    assert.equal(dispatch.entries[0]?.result.status, 'success')
    f.runtime.admitPrompt(f.prompt, dispatch)
    f.admitHistory()
    const session = f.runtime.sessions.get('session')
    f.transcripts.observe(f.tool, session)
    const path = await f.transcripts.prepare(f.tool, session, f.tool.signal)
    const rows = (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    const attachments = rows.filter(row => row.attachment?.hookEvent === 'UserPromptSubmit')
    assert.deepEqual(attachments.map(row => row.attachment.type), ['hook_system_message', 'hook_additional_context'])
    assert.equal(attachments[0].attachment.content, 'Prompt warning')
    assert.equal(attachments[1].rendered[0].content, '<system-reminder>\nUserPromptSubmit hook additional context: Context additional\n</system-reminder>')
  }
})

test('unsupported execution evidence cannot commit a partial nonblocking prompt receipt', async t => {
  const f = await fixture(t, 'v2', ['stdout', 'failure'])
  const dispatch = await f.runtime.prompt(f.prompt)
  const failure = dispatch.entries[1]!
  assert.ok('commandArtifact' in failure.result && failure.result.commandArtifact)
  const original = failure.result
  const evidence = 'commandArtifact' in original ? original.commandArtifact! : undefined
  assert.ok(evidence)
  const cases = [
    { commandArtifact: { ...evidence, status: 'timeout' as const } },
    { commandArtifact: { ...evidence, signal: 'SIGUSR1' as const, exitCode: null } },
    { commandArtifact: { ...evidence, exitCode: -1 } },
    { commandArtifact: { ...evidence, exitCode: 1.5 } },
    { commandArtifact: { ...evidence, exitCode: 256 } },
    { commandArtifact: { ...evidence, exitCode: 2 } },
    { commandArtifact: { ...evidence, completedAt: Number.NaN } },
    { commandArtifact: { ...evidence, durationMs: -1 } },
  ]
  for (const change of cases) {
    const invalid = { ...dispatch, entries: [dispatch.entries[0]!, { ...failure, result: { ...original, ...change } }] }
    assert.throws(() => f.runtime.admitPrompt(f.prompt, invalid), { code: 'TRANSCRIPT_HOOK_EXECUTION_UNAVAILABLE' })
    assert.equal(f.transcripts.inspect().promptTurns, 0)
    assert.equal(f.transcripts.inspect().promptAttachments, 0)
    assert.equal(f.transcripts.inspect().promptBytes, 0)
  }
  for (const change of [{ code: 'INVALID_OUTPUT' }, { commandArtifact: { ...evidence, exitCode: 0 } }, { actions: [{ kind: 'warning' as const, text: 'Unverified error display' }] }]) {
    const invalid = { ...dispatch, entries: [dispatch.entries[0]!, { ...failure, result: { ...original, ...change } }] }
    assert.throws(() => f.runtime.admitPrompt(f.prompt, invalid), { code: 'TRANSCRIPT_HOOK_RESULT_UNSUPPORTED' })
    assert.equal(f.transcripts.inspect().promptTurns, 0)
  }
  f.runtime.admitPrompt(f.prompt, dispatch)
  assert.equal(f.transcripts.inspect().promptTurns, 1)
})

test('both hosts preserve native timeout attachments without admitting timeout output as context', async t => {
  for (const host of ['v1', 'v2'] as const) {
    const f = await fixture(t, host, ['stdout', 'timeout'])
    const dispatch = await f.runtime.prompt(f.prompt)
    assert.equal(dispatch.entries[1]?.result.code, 'EXECUTION_TIMEOUT')
    assert.equal(dispatch.diagnostic.failed, 1)
    assert.ok(!dispatch.actions.some(row => row.action.kind === 'context' && row.action.text.includes('Timeout')))
    f.runtime.admitPrompt(f.prompt, dispatch)
    f.admitHistory()
    const session = f.runtime.sessions.get('session')
    f.transcripts.observe(f.tool, session)
    const path = await f.transcripts.prepare(f.tool, session, f.tool.signal)
    const rows = (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    const attachments = rows.filter(row => row.attachment?.hookEvent === 'UserPromptSubmit')
    const expectedTypes = [...dispatch.entries].sort((left, right) => left.completionOrder - right.completionOrder).map(entry => f.modes[entry.configuredOrder] === 'timeout' ? 'hook_cancelled' : 'hook_success')
    assert.deepEqual(attachments.map(row => row.attachment.type), expectedTypes)
    const timeout = attachments.find(row => row.attachment.type === 'hook_cancelled')
    const success = attachments.find(row => row.attachment.type === 'hook_success')
    assert.equal(timeout.attachment.timedOut, true)
    assert.equal(timeout.attachment.timeoutMs, 150)
    assert.equal(timeout.attachment.toolUseID, success.attachment.toolUseID)
    assert.ok(timeout.attachment.command.endsWith(' timeout'))
    assert.ok(timeout.attachment.durationMs >= 150)
    for (const field of ['stdout', 'stderr', 'exitCode', 'content']) assert.equal(Object.hasOwn(timeout.attachment, field), false)
    assert.equal(Object.hasOwn(timeout, 'rendered'), false)
    assert.equal(Object.hasOwn(timeout, 'renderedRole'), false)
    const before = await readFile(path, 'utf8')
    await f.transcripts.prepare(f.tool, session, f.tool.signal)
    assert.equal(await readFile(path, 'utf8'), before)
  }
})

test('timed-out hooks cannot override blocking policy, turn cancellation or missing deadline evidence', async t => {
  const blocked = await fixture(t, 'v2', ['timeout-block'])
  const denied = await blocked.runtime.prompt(blocked.prompt)
  assert.ok(denied.actions.some(row => row.action.kind === 'block-event'))
  assert.throws(() => blocked.runtime.admitPrompt(blocked.prompt, denied), { code: 'TRANSCRIPT_PROMPT_NOT_ADMITTED' })
  const f = await fixture(t, 'v2', ['timeout'])
  const dispatch = await f.runtime.prompt(f.prompt)
  const entry = dispatch.entries[0]!
  const artifact = 'commandArtifact' in entry.result ? entry.result.commandArtifact! : undefined
  assert.ok(artifact)
  for (const timeoutMs of [undefined, null, Number.NaN, Infinity, 0, -1]) {
    const invalid = { ...dispatch, entries: [{ ...entry, result: { ...entry.result, commandArtifact: { ...artifact, timeoutMs } } }] }
    assert.throws(() => f.runtime.admitPrompt(f.prompt, invalid as typeof dispatch), { code: 'TRANSCRIPT_HOOK_EXECUTION_UNAVAILABLE' })
    assert.equal(f.transcripts.inspect().promptTurns, 0)
  }
  assert.throws(() => f.runtime.admitPrompt(f.prompt, { ...dispatch, cancelled: true }), { code: 'TRANSCRIPT_PROMPT_CANCELLED' })
  f.runtime.sessions.prompt('session', 'next', 'fixture')
  assert.throws(() => f.runtime.admitPrompt(f.prompt, dispatch), { code: 'SESSION_STALE_TURN' })
  assert.equal(f.transcripts.inspect().promptTurns, 0)
})

test('observed terminating signals preserve native error exits and structured context on both hosts', async t => {
  for (const host of ['v1', 'v2'] as const) {
    const f = await fixture(t, host, ['signal-SIGTERM', 'signal-SIGINT', 'signal-SIGKILL', 'signal-json'])
    const dispatch = await f.runtime.prompt(f.prompt)
    assert.equal(dispatch.diagnostic.failed, 3)
    f.runtime.admitPrompt(f.prompt, dispatch)
    f.admitHistory()
    const session = f.runtime.sessions.get('session')
    f.transcripts.observe(f.tool, session)
    const path = await f.transcripts.prepare(f.tool, session, f.tool.signal)
    const rows = (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    const attachments = rows.filter(row => row.attachment?.hookEvent === 'UserPromptSubmit')
    const errors = attachments.filter(row => row.attachment.type === 'hook_non_blocking_error')
    assert.equal(errors.length, 3)
    assert.ok(errors.every(row => row.attachment.exitCode === 1 && row.attachment.stdout === 'Signal stdout\n' && row.attachment.stderr === 'Failed with non-blocking status code: Signal stderr'))
    assert.equal(attachments.find(row => row.attachment.type === 'hook_additional_context').rendered[0].content, '<system-reminder>\nUserPromptSubmit hook additional context: Signal context\n</system-reminder>')
  }
})
