import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { test } from 'node:test'

const moduleURL = new URL('../scripts/lib/native-claude.mjs', import.meta.url)
const processURL = new URL('../scripts/lib/native-process.mjs', import.meta.url)
const node = process.versions.bun ? execFileSync('node', ['-p', 'process.execPath'], { encoding: 'utf8' }).trim() : process.execPath
const environment = { PATH: process.env.PATH }

test('native check failures identify a portable source line without exposing assertion values or paths', async () => {
  const { NativeProbeError, nativeCheckError } = await import(processURL.href)
  const error = new Error('PRIVATE_NATIVE_OUTPUT')
  error.stack = 'Error: PRIVATE_NATIVE_OUTPUT\n    at validate (file:///private-fixture/verify-native-stop.mjs:91:7)\n    at other (file:///private-fixture/other.mjs:12:3)'
  const diagnostic = nativeCheckError('NATIVE_STOP_CHECK_FAILED', 'block-json', error, 'file:///private-fixture/verify-native-stop.mjs')
  assert.equal(diagnostic.message, 'NATIVE_STOP_CHECK_FAILED: block-json check=verify-native-stop.mjs:91')
  assert.equal(diagnostic.stack.includes('PRIVATE_NATIVE_OUTPUT'), false)
  assert.equal(diagnostic.stack.includes('private-fixture'), false)
  const known = new NativeProbeError('NATIVE_TIMEOUT')
  assert.equal(nativeCheckError('CHECK_FAILED', 'phase', known, import.meta.url), known)
  assert.equal(nativeCheckError('CHECK_FAILED', 'phase', { message: 'PRIVATE_NATIVE_OUTPUT' }, import.meta.url).message, 'CHECK_FAILED: phase')
})

test('the shared native process runner preserves opaque JSONL without imposing a harness result schema', async () => {
  const { runNativeProcess } = await import(processURL.href)
  const result = await runNativeProcess(node, ['-e', 'process.stdout.write("{\\"type\\":\\"turn.started\\"}\\n{\\"type\\":\\"turn.completed\\"}\\n")'], '', tmpdir(), environment)
  assert.equal(result.stdout, '{"type":"turn.started"}\n{"type":"turn.completed"}\n')
  assert.ok(Number.isFinite(result.completedAt) && result.completedAt > 0)
})

test('shared native process startup and exit failures do not disclose subprocess diagnostics', async () => {
  const { runNativeProcess } = await import(processURL.href)
  await assert.rejects(runNativeProcess('/missing/native-fixture', [], '', tmpdir(), environment), { message: 'NATIVE_START_FAILED' })
  await assert.rejects(runNativeProcess(node, ['-e', 'console.error("PRIVATE_NATIVE_ERROR");process.exit(9)'], '', tmpdir(), environment), (error: unknown) => {
    assert.ok(error instanceof Error)
    assert.equal(error.message, 'NATIVE_EXECUTION_FAILED')
    assert.equal(error.stack?.includes('PRIVATE_NATIVE_ERROR'), false)
    return true
  })
})

test('native Claude fixture execution preserves stdin and validates its structured result', async () => {
  const { runNativeClaude } = await import(moduleURL.href)
  const result = await runNativeClaude(node, ['-e', 'process.stdin.resume();let text="";process.stdin.on("data",chunk=>text+=chunk);process.stdin.on("end",()=>console.log(JSON.stringify({is_error:false,text})))'], 'Fixture input', tmpdir(), environment)
  assert.deepEqual(result, { is_error: false, text: 'Fixture input' })
})

test('invalid native fixture results do not disclose child output through error diagnostics', async () => {
  const { runNativeClaude } = await import(moduleURL.href)
  for (const program of ['process.stdout.write("PRIVATE_NATIVE_OUTPUT")', 'console.log(JSON.stringify({is_error:true,result:"PRIVATE_NATIVE_OUTPUT"}))']) {
    await assert.rejects(runNativeClaude(node, ['-e', program], '', tmpdir(), environment), (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.equal(error.message, 'NATIVE_RESULT_INVALID')
      assert.equal(error.stack?.includes('PRIVATE_NATIVE_OUTPUT'), false)
      return true
    })
  }
})

test('native fixture JSON preserves a multibyte character split across child output chunks', async () => {
  const { runNativeClaude } = await import(moduleURL.href)
  const program = 'process.stdout.write("{\\"is_error\\":false,\\"text\\":\\"");process.stdout.write(Buffer.from([0xe9]));setTimeout(()=>process.stdout.end(Buffer.from([0x9b,0xaa,0x22,0x7d])),20)'
  const result = await runNativeClaude(node, ['-e', program], '', tmpdir(), environment)
  assert.deepEqual(result, { is_error: false, text: '\u96ea' })
})

test('native fixture subprocess deadlines and output limits terminate bounded executions', async () => {
  const { runNativeClaude } = await import(moduleURL.href)
  const limits = { durationMs: 1000, graceMs: 10, maxBytes: 128 }
  await assert.rejects(runNativeClaude(node, ['-e', 'setInterval(()=>{},1000)'], '', tmpdir(), environment, { ...limits, durationMs: 50 }), { message: 'NATIVE_TIMEOUT' })
  await assert.rejects(runNativeClaude(node, ['-e', 'process.stdout.write("x".repeat(4096));setInterval(()=>{},1000)'], '', tmpdir(), environment, limits), { message: 'NATIVE_OUTPUT_LIMIT' })
})
