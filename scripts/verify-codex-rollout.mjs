#!/usr/bin/env node
import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { parseArgs } from 'node:util'
import { listNativeCodexHooks, readNativeCodexThread } from './lib/native-codex-inventory.mjs'
import { NativeProbeError as ProbeError, nativeCheckError, runNativeProcess } from './lib/native-process.mjs'

const VERSION = '0.167.0'
const VERSION_LIMITS = Object.freeze({ durationMs: 5000, graceMs: 1000, maxBytes: 4096 })
const HELP = `Usage: node scripts/verify-codex-rollout.mjs [-b PATH]

Verify core Stop dispatch, native inventory binding and persisted Codex rollout
records through pinned Codex ${VERSION} read-only hooks/list and thread/read.
Requires Node.js 22+, POSIX, npm ci and npm run build in this checkout.
Uses isolated synthetic sources, identities and history. Executes one generated
command through the adapter core; starts no model, account or OpenCode host.
No installation or live configuration changes. This is not default plugin
integration, native trust, native identity allocation or full parity.

Options:
  -b, --binary PATH  Codex executable (CODEX_BINARY, then codex)
  -h, --help         Show help without a binary, dependencies or build

Metadata-only JSON goes to stdout; bounded diagnostic codes go to stderr.
Temporary state is removed; no commands, paths or raw records are printed.
Exit status: 0 checks pass; 1 runtime/check failure;
2 usage/version/platform precondition; 3 missing executable or built package.
Successful results retain equivalent:false and native trust remains required.
`
const quote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'"

async function verify(binary) {
  if (process.platform === 'win32') throw new ProbeError('PLATFORM_UNAVAILABLE: POSIX process groups', 2)
  let version
  try { version = (await runNativeProcess(binary, ['--version'], '', process.cwd(), { PATH: process.env.PATH, LANG: 'C' }, VERSION_LIMITS)).stdout.trim().replace(/^codex-cli /, '') } catch (error) { throw new ProbeError(error.systemCode === 'ENOENT' || error.systemCode === 'EACCES' ? 'DEPENDENCY_UNAVAILABLE: codex' : 'DEPENDENCY_QUERY_FAILED: codex', error.systemCode === 'ENOENT' || error.systemCode === 'EACCES' ? 3 : 1) }
  if (version !== VERSION) throw new ProbeError('NATIVE_VERSION_MISMATCH', 2)
  try { await access(new URL('../dist/core.js', import.meta.url)) } catch { throw new ProbeError('DEPENDENCY_UNAVAILABLE: built adapter', 3) }
  let core
  try { core = await import('../dist/core.js') } catch (error) { throw new ProbeError(error.code === 'ERR_MODULE_NOT_FOUND' ? 'DEPENDENCY_UNAVAILABLE: adapter dependencies' : 'ADAPTER_LOAD_FAILED', error.code === 'ERR_MODULE_NOT_FOUND' ? 3 : 1) }
  const scenario = JSON.parse(await readFile(new URL('../test/fixtures/codex-stop-artifact-oracle.json', import.meta.url), 'utf8')).cases[0]
  const root = await realpath(await mkdtemp(join(tmpdir(), 'harness-codex-rollout-reference-')))
  let rollout, runtime, stage = 'setup'
  try {
    const project = join(root, 'project'), home = join(root, 'home'), trace = join(root, 'command-readback.json'), script = join(root, 'hook.cjs')
    await Promise.all([home, project].map(path => mkdir(path)))
    const timestamp = new Date(scenario.identity.createTime * 1000).toISOString()
    rollout = new core.CodexRollout({ temporaryParent: root })
    const metadata = { session_id: scenario.identity.threadID, id: scenario.identity.threadID, timestamp, cwd: project, originator: 'opencode-harness-hooks', cli_version: '0.1.0', source: 'unknown', model_provider: 'fixture', base_instructions: { text: 'Synthetic' }, history_mode: 'legacy' }
    const history = [
      { timestamp, type: 'event_msg', payload: { type: 'task_started', turn_id: scenario.identity.turnID, model_context_window: null } },
      { timestamp, type: 'response_item', payload: { type: 'message', id: 'msg_user', role: 'user', content: [{ type: 'input_text', text: 'Question' }] } },
      { timestamp, type: 'event_msg', payload: { type: 'user_message', message: 'Question', images: [], local_images: [], text_elements: [] } },
      { timestamp, type: 'response_item', payload: { type: 'message', id: 'msg_assistant', role: 'assistant', content: [{ type: 'output_text', text: 'Answer' }] } },
      { timestamp, type: 'event_msg', payload: { type: 'agent_message', message: 'Answer', phase: 'final_answer' } },
    ]
    const path = await rollout.create({ metadata, history }), nativeHome = join(root, 'native')
    const nativeRelativePath = join('sessions', ...timestamp.slice(0, 10).split('-'), basename(path)), nativePath = join(nativeHome, nativeRelativePath)
    await mkdir(dirname(nativePath), { recursive: true })
    await symlink(path, nativePath)
    await writeFile(join(nativeHome, 'config.toml'), '[features]\nhooks=true\n')
    await writeFile(script, `const fs=require('node:fs');const input=JSON.parse(fs.readFileSync(0,'utf8'));const records=fs.readFileSync(input.transcript_path,'utf8').trim().split('\\n').map(JSON.parse);if(!records.some(row=>row.type==='response_item'&&row.payload.role==='assistant'&&row.payload.content.some(part=>part.text==='Answer')))process.exit(9);fs.writeFileSync(${JSON.stringify(trace)},JSON.stringify({sessionID:input.session_id,turnID:input.turn_id,readArtifact:true}));console.log(JSON.stringify({decision:'block',reason:${JSON.stringify(scenario.feedback[0])}}))`)
    const sourcePath = join(nativeHome, 'hooks.json'), command = [process.execPath, script].map(quote).join(' ')
    const sourceBytes = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command }] }] } })
    await writeFile(sourcePath, sourceBytes)
    const env = { PATH: process.env.PATH, HOME: home, CODEX_HOME: nativeHome, LANG: 'C', SHELL: '/bin/sh' }
    stage = 'inventory'
    const inventory = await listNativeCodexHooks(binary, project, env)
    const spec = { id: 'native', dialect: 'codex', path: sourcePath }, sources = await core.loadSources([spec])
    const registrations = core.bindCodexStopInventory({ sources, nativeVersion: version, cwd: project, inventory })
    assert.equal(registrations.length, 1)
    let persisted
    stage = 'core-dispatch'
    const startedAtMs = Date.now()
    runtime = await core.createRuntime('v2', project, { sources: [spec], reviewedDigests: { native: sources[0].digest }, permissionMode: 'default' }, {
      report: () => {}, dispatchDiagnostic: () => {}, host: { environment: { PATH: process.env.PATH, HOME: home, SHELL: '/bin/sh' } },
      stop: { diagnostic: () => {}, async admit(delivery) {
        const completedAtMs = Date.now()
        persisted = core.compileCodexStopPrompt({ dispatch: delivery.dispatch, sources, registrations, identity: { threadID: scenario.identity.threadID, turnID: scenario.identity.turnID, messageID: 'msg_rollout_feedback', createTime: completedAtMs / 1000, startedAtMs, completedAtMs } })
        assert.ok(persisted)
        await rollout.appendStop(scenario.identity.threadID, persisted, delivery.signal)
      } },
    })
    runtime.sessions.prompt(scenario.identity.threadID, scenario.identity.turnID, 'fixture')
    const receipt = await runtime.stop({ host: 'v2', event: 'Stop', sessionID: scenario.identity.threadID, messageID: scenario.identity.turnID, completionID: 'fixture-completion', cwd: project, data: { transcript_path: path, last_assistant_message: 'Answer' } })
    assert.equal(receipt.control, 'continue')
    assert.deepEqual(JSON.parse(await readFile(trace, 'utf8')), { sessionID: scenario.identity.threadID, turnID: scenario.identity.turnID, readArtifact: true })
    stage = 'native-reader'
    const before = await readFile(path)
    const native = await readNativeCodexThread(binary, project, env, scenario.identity.threadID)
    assert.equal(native.thread.id, scenario.identity.threadID)
    assert.equal(native.thread.turns.length, 1)
    const turn = native.thread.turns[0]
    assert.equal(turn.id, scenario.identity.turnID)
    assert.deepEqual(turn.items.map(item => item.type), ['userMessage', 'agentMessage', 'hookPrompt'])
    assert.equal(turn.items[2].id, persisted.event.item.id)
    assert.deepEqual(turn.items[2].fragments, persisted.event.item.fragments)
    assert.deepEqual(await readFile(path), before)
    assert.equal(await readFile(sourcePath, 'utf8'), sourceBytes)
    stage = 'negative-control'
    const invalidHome = join(root, 'negative'), invalidPath = join(invalidHome, nativeRelativePath)
    await mkdir(invalidPath.slice(0, invalidPath.lastIndexOf('/')), { recursive: true })
    const rows = before.toString('utf8').trim().split('\n').map(JSON.parse).map(row => row.type === 'response_item' && row.payload.id === persisted.event.item.id ? { ...row, payload: { ...row.payload, type: 'invalid_response_item' } } : row.type === 'event_msg' && row.payload.type === 'item_completed' ? { ...row, payload: { ...row.payload, item: { ...row.payload.item, type: 'InvalidHookPrompt' } } } : row)
    await writeFile(invalidPath, rows.map(row => JSON.stringify(row) + '\n').join(''))
    const invalid = await readNativeCodexThread(binary, project, { ...env, CODEX_HOME: invalidHome }, scenario.identity.threadID)
    assert.equal(invalid.thread.turns.flatMap(turn => turn.items).filter(item => item.type === 'hookPrompt').length, 0)
    return { version, coreStopDispatch: true, commandReadNativeArtifact: true, inventoryBound: true, nativeReaderAccepted: true, exactHookPrompt: true, malformedRecordsOmitted: true, sourceBytesUnchanged: true, defaultPluginIntegration: false, nativeTrustEnforced: false, equivalent: false }
  } catch (error) { throw nativeCheckError('CODEX_ROLLOUT_CHECK_FAILED', stage, error, import.meta.url) } finally {
    try { await runtime?.dispose() } finally { try { await rollout?.dispose() } finally { await rm(root, { recursive: true, force: true }) } }
  }
}

try {
  let parsed
  try { parsed = parseArgs({ options: { binary: { type: 'string', short: 'b' }, help: { type: 'boolean', short: 'h' } }, strict: true, allowPositionals: false }) } catch { throw new ProbeError('USAGE_INVALID: use --help', 2) }
  if (parsed.values.help) process.stdout.write(HELP)
  else {
    const binary = parsed.values.binary ?? process.env.CODEX_BINARY ?? 'codex'
    if (!binary.trim()) throw new ProbeError('USAGE_BINARY_EMPTY', 2)
    process.stdout.write(JSON.stringify(await verify(binary)) + '\n')
  }
} catch (error) { process.stderr.write((error instanceof ProbeError ? error.message : 'CODEX_ROLLOUT_PROBE_FAILED') + '\n'); process.exitCode = error instanceof ProbeError ? error.status : 1 }
