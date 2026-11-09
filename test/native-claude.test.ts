import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { test } from 'node:test'

const moduleURL = new URL('../scripts/lib/native-claude.mjs', import.meta.url)
const node = process.versions.bun ? execFileSync('node', ['-p', 'process.execPath'], { encoding: 'utf8' }).trim() : process.execPath
const environment = { PATH: process.env.PATH }

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
