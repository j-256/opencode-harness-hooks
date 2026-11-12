import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createHarnessHooks } from '../src/plugin.js'

test('default V1 delivers mixed native pre-context, rewriting and post-feedback without carrying them into the next turn', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'harness-v1-tool-effects-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const capture = join(directory, 'post.jsonl')
  const script = join(directory, 'hook.cjs')
  await writeFile(script, `const fs=require('node:fs');const p=JSON.parse(fs.readFileSync(0,'utf8'));if(p.hook_event_name==='PreToolUse'){if(p.tool_input.command==='original')console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'allow',updatedInput:{command:'effective'},additionalContext:'CODEX_PRE_CONTEXT'}}));}else{fs.appendFileSync(${JSON.stringify(capture)},JSON.stringify(p)+'\\n');if(p.tool_input.command==='effective')console.log(JSON.stringify({decision:'block',reason:'CLAUDE_POST_FEEDBACK',hookSpecificOutput:{hookEventName:'PostToolUse',additionalContext:'CLAUDE_POST_CONTEXT'}}));}`)
  const commandLine = [process.execPath, script].map(value => "'" + value.replaceAll("'", "'\"'\"'") + "'").join(' ')
  const path = join(directory, 'hooks.json')
  const text = JSON.stringify({ hooks: Object.fromEntries(['PreToolUse', 'PostToolUse'].map(event => [event, [{ matcher: 'Bash', hooks: [{ type: 'command', command: commandLine }] }]])) })
  await writeFile(path, text)
  const sources = [{ id: 'codex', dialect: 'codex', path, selection: { events: ['PreToolUse'] } }, { id: 'claude', dialect: 'claude-code', path, selection: { events: ['PostToolUse'] } }]
  const digest = createHash('sha256').update(text).digest('hex')
  let callID = 'first', turnID = 'turn', command = 'original'
  let created = 1
  const previous: unknown[] = []
  const snapshot = () => [
    { info: { id: turnID, sessionID: 'session', role: 'user', time: { created } }, parts: [{ type: 'text', text: 'Tool context fixture' }] },
    { info: { id: 'answer-' + turnID, sessionID: 'session', parentID: turnID, role: 'assistant', modelID: 'fixture', time: { created: created + 1 } }, parts: [{ type: 'tool', callID, tool: 'bash', state: { status: 'running', input: { command } } }] },
  ]
  const diagnostics: { failed: number; unsupported: number }[] = []
  const hooks = await createHarnessHooks({ directory, client: { session: {
    get: async () => ({ data: { id: 'session' } }),
    messages: async () => ({ data: [...previous, ...snapshot()] }),
  } } }, { sources, reviewedDigests: { codex: digest, claude: digest }, permissionMode: 'default' }, { report: () => {}, dispatchDiagnostic: value => { diagnostics.push(value) }, tools: { diagnostic: () => {} } })
  t.after(() => hooks.dispose())
  const exercise = async () => {
    await hooks['chat.message']({ sessionID: 'session', model: { modelID: 'fixture' } }, { message: { id: turnID } })
    await hooks['chat.headers']({ sessionID: 'session', message: { id: turnID } }, { headers: {} })
    const input = { sessionID: 'session', callID, tool: 'bash' }
    const args = { command }
    await hooks['tool.execute.before'](input, { args })
    const output = { title: 'Tool result', metadata: { exit: 0 }, output: 'ACTUAL_TOOL_RESULT' }
    await hooks['tool.execute.after']({ ...input, args }, output)
    assert.ok(diagnostics.every(value => value.failed === 0 && value.unsupported === 0), JSON.stringify(diagnostics))
    return { args, output }
  }
  const first = await exercise()
  assert.deepEqual(first.args, { command: 'effective' })
  for (const marker of ['ACTUAL_TOOL_RESULT', 'CODEX_PRE_CONTEXT', 'CLAUDE_POST_FEEDBACK', 'CLAUDE_POST_CONTEXT']) assert.equal(first.output.output.split(marker).length - 1, 1)
  assert.equal(JSON.parse((await readFile(capture, 'utf8')).trim()).tool_input.command, 'effective')
  previous.push(...snapshot())
  callID = 'second'; turnID = 'next-turn'; command = 'clean'; created = 10
  const second = await exercise()
  assert.equal(second.output.output, 'ACTUAL_TOOL_RESULT')
  assert.deepEqual(hooks.inspect().diagnostics, [])
})
