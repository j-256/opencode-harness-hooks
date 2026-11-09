import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { test } from 'node:test'

const moduleURL = new URL('../scripts/lib/native-process.mjs', import.meta.url)
const node = process.versions.bun ? execFileSync('node', ['-p', 'process.execPath'], { encoding: 'utf8' }).trim() : process.execPath
const environment = { PATH: process.env.PATH }
const LIMITS = { durationMs: 2000, graceMs: 10, maxBytes: 4096 }

for (const first of ['result', 'ack']) test(`native interruption waits for both result and control acknowledgement when ${first} arrives first`, async t => {
  const { runNativeInterruptedConversation } = await import(moduleURL.href)
  const signal = new AbortController()
  const timer = setTimeout(() => signal.abort(), 50)
  t.after(() => clearTimeout(timer))
  const program = `const readline=require('node:readline');let users=0;const write=row=>console.log(JSON.stringify(row));readline.createInterface({input:process.stdin}).on('line',line=>{const row=JSON.parse(line);write({type:'observed',row});if(row.type==='user'){if(++users===2)write({type:'result',is_error:false});return}const ack={type:'control_response',response:{subtype:'success',request_id:row.request_id}},result={type:'result',is_error:false};write(${JSON.stringify(first)}==='result'?result:ack);setTimeout(()=>write(${JSON.stringify(first)}==='result'?ack:result),30)})`
  const execution = await runNativeInterruptedConversation(node, ['-e', program], ['Original', 'Next'], signal.signal, tmpdir(), environment, LIMITS)
  const rows = execution.stdout.trim().split('\n').map((line: string) => JSON.parse(line))
  const observed = rows.filter((row: any) => row.type === 'observed')
  assert.deepEqual(observed.map((row: any) => row.row.type), ['user', 'control_request', 'user'])
  assert.deepEqual(observed[1].row.request, { subtype: 'interrupt' })
  assert.equal(observed[2].row.message.content, 'Next')
  assert.equal(rows[4].type, 'observed')
  assert.ok(execution.interrupt.sentAt <= execution.interrupt.acknowledgedAt)
  assert.ok(execution.interrupt.acknowledgedAt <= execution.completedAt)
})

test('native interruption cannot advance after rejected or foreign control acknowledgement', async t => {
  const { runNativeInterruptedConversation } = await import(moduleURL.href)
  for (const mode of ['rejected', 'foreign']) {
    const signal = new AbortController(), timer = setTimeout(() => signal.abort(), 50)
    t.after(() => clearTimeout(timer))
    const program = `require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const row=JSON.parse(line);if(row.type==='control_request')console.log(JSON.stringify({type:'control_response',response:{subtype:${JSON.stringify(mode)}==='rejected'?'error':'success',request_id:${JSON.stringify(mode)}==='foreign'?'foreign':row.request_id,error:'PRIVATE_CONTROL_ERROR'}}))})`
    await assert.rejects(runNativeInterruptedConversation(node, ['-e', program], ['Original', 'Next'], signal.signal, tmpdir(), environment, LIMITS), (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.equal(error.message, 'NATIVE_CONTROL_INVALID')
      assert.ok(!error.stack?.includes('PRIVATE_CONTROL_ERROR'))
      return true
    })
  }
})

test('native interruption requires an exercised control and bounds missing acknowledgement', async t => {
  const { runNativeInterruptedConversation } = await import(moduleURL.href)
  await assert.rejects(runNativeInterruptedConversation(node, ['-e', 'process.stdin.once("data",()=>console.log(JSON.stringify({type:"result",is_error:false})))'], ['Original', 'Next'], new AbortController().signal, tmpdir(), environment, LIMITS), { message: 'NATIVE_CONTROL_NOT_TRIGGERED' })
  const signal = new AbortController(), timer = setTimeout(() => signal.abort(), 20)
  t.after(() => clearTimeout(timer))
  await assert.rejects(runNativeInterruptedConversation(node, ['-e', 'process.stdin.resume();setInterval(()=>{},1000)'], ['Original', 'Next'], signal.signal, tmpdir(), environment, { ...LIMITS, durationMs: 100 }), { message: 'NATIVE_TIMEOUT' })
  const cancelled = new AbortController(); cancelled.abort()
  await assert.rejects(runNativeInterruptedConversation('/missing/native', [], ['Original', 'Next'], cancelled.signal, tmpdir(), environment, LIMITS), { message: 'NATIVE_INPUT_INVALID' })
})
