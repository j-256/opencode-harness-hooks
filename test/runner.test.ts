import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getEventListeners } from 'node:events'

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), 'hook-runner-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

const invocation = (args: readonly string[]) => ({ command: process.execPath, args, cwd: process.cwd(), env: process.env, stdin: '{}', timeoutMs: 2000 })

test('explicit process identity capture reports the executed child without changing ordinary result fields', async () => {
  const { runCommand } = await import('../src/runner.js')
  const captured = await runCommand({ ...invocation(['-e', 'process.stdout.write(String(process.pid))']), captureProcessIdentity: true })
  assert.equal(captured.status, 'exited'); assert.equal(captured.processID, Number(captured.stdout))
  assert.ok(Number.isSafeInteger(captured.processID) && captured.processID! > 0)
  const ordinary = await runCommand(invocation(['-e', 'process.exit(0)']))
  assert.equal(Object.hasOwn(ordinary, 'processID'), false)
})

test('exec form preserves literal args, exact stdin, working directory, and explicit environment', async t => {
  const { runCommand } = await import('../src/runner.js')
  const cwd = await fixture(t)
  const script = 'let input=""; for await (const chunk of process.stdin) input+=chunk; console.log(JSON.stringify({input,args:process.argv.slice(1),cwd:process.cwd(),value:process.env.FIXTURE_VALUE,missing:process.env.UNRELATED_SECRET??null}))'
  const args = ['$value', '`never`', "it's literal", 'two words']
  const result = await runCommand({ ...invocation(['--input-type=module', '-e', script, ...args]), cwd, env: { FIXTURE_VALUE: 'value' }, stdin: '{"exact":"é"}\n' })
  assert.equal(result.status, 'exited')
  assert.equal(result.exitCode, 0)
  const actual = JSON.parse(result.stdout)
  assert.deepEqual(actual.args, args)
  assert.equal(actual.input, '{"exact":"é"}\n')
  assert.equal(actual.cwd.replace(/^\/private/, ''), cwd.replace(/^\/private/, ''))
  assert.equal(actual.value, 'value')
  assert.equal(actual.missing, null)
})

test('shell form and an explicit shell prefix execute their native command strings', async () => {
  const { runCommand } = await import('../src/runner.js')
  const result = await runCommand({ ...invocation([]), command: 'printf "%s" "$FIXTURE_VALUE" | tr a-z A-Z', args: undefined, env: { FIXTURE_VALUE: 'shell' }, shell: { program: '/bin/sh', args: ['-c'] } })
  assert.equal(result.stdout, 'SHELL')
  const explicitEmptyArgs = await runCommand({ ...invocation([]), command: '/usr/bin/true' })
  assert.equal(explicitEmptyArgs.exitCode, 0)
})

test('retains nonzero exit status and both streams without interpreting the protocol', async () => {
  const { runCommand } = await import('../src/runner.js')
  const result = await runCommand(invocation(['-e', 'process.stdout.write("out");process.stderr.write("err");process.exitCode=2']))
  assert.equal(result.status, 'exited')
  assert.equal(result.exitCode, 2)
  assert.equal(result.stdout, 'out')
  assert.equal(result.stderr, 'err')
  assert.ok(result.durationMs >= 0)
})

test('decodes UTF-8 after chunk capture instead of corrupting split multibyte characters', async () => {
  const { runCommand } = await import('../src/runner.js')
  const result = await runCommand(invocation(['-e', 'process.stdout.write(Buffer.from([0xe2]));setTimeout(()=>process.stdout.end(Buffer.from([0x82,0xac])),10)']))
  assert.equal(result.stdout, '€')
})

test('missing executables report a stable error without exposing the command or environment', async () => {
  const { runCommand } = await import('../src/runner.js')
  const result = await runCommand({ ...invocation([]), command: '/missing/SECRET_SENTINEL', env: { SECRET: 'SECRET_SENTINEL' } })
  assert.equal(result.status, 'spawn-error')
  assert.equal(result.exitCode, null)
  assert.equal(JSON.stringify(result).includes('SECRET_SENTINEL'), false)
})

test('enforces one combined byte limit while draining both streams', async () => {
  const { runCommand } = await import('../src/runner.js')
  const result = await runCommand({ ...invocation(['-e', 'process.stdout.write("x".repeat(128));process.stderr.write("y".repeat(128));setInterval(()=>{},1000)']), maxOutputBytes: 160 })
  assert.equal(result.status, 'output-limit')
  assert.ok(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) <= 160)
})

test('bounds input before creating a subprocess', async t => {
  const { runCommand } = await import('../src/runner.js')
  const root = await fixture(t)
  const marker = join(root, 'must-not-exist')
  const result = await runCommand({ ...invocation(['-e', 'require("node:fs").writeFileSync(process.argv[1],"bad")', marker]), stdin: 'éé', maxInputBytes: 3 })
  assert.equal(result.status, 'input-limit')
  await assert.rejects(readFile(marker), { code: 'ENOENT' })
})

test('a pre-aborted invocation never starts, and active cancellation terminates the child', async () => {
  const { runCommand } = await import('../src/runner.js')
  const signal = AbortSignal.abort()
  assert.equal((await runCommand({ ...invocation(['-e', 'process.exit(0)']), signal })).status, 'cancelled')
  const controller = new AbortController()
  const pending = runCommand({ ...invocation(['-e', 'setInterval(()=>{},1000)']), signal: controller.signal })
  setTimeout(() => controller.abort(), 50)
  assert.equal((await pending).status, 'cancelled')
})

test('timeouts kill descendants even if the parent exits first and descendants ignore SIGTERM', { timeout: 5000 }, async t => {
  const { runCommand } = await import('../src/runner.js')
  const root = await fixture(t)
  const pidPath = join(root, 'descendant.pid')
  const childPath = join(root, 'child.cjs')
  await writeFile(childPath, 'require("node:fs").writeFileSync(process.argv[2],String(process.pid)); process.on("SIGTERM",()=>{}); setInterval(()=>{},1000)')
  const script = 'require("node:child_process").spawn(process.execPath,process.argv.slice(1),{stdio:"inherit"});setTimeout(()=>process.exit(0),100)'
  const result = await runCommand({ ...invocation(['-e', script, childPath, pidPath]), timeoutMs: 400 })
  assert.equal(result.status, 'timeout')
  const pid = Number(await readFile(pidPath, 'utf8'))
  t.after(async () => { try { process.kill(pid, 'SIGKILL') } catch {} })
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
  assert.ok(result.durationMs < 3000)
})

test('the deadline includes a blocked stdin writer and cancellation listeners are released', async () => {
  const { runCommand } = await import('../src/runner.js')
  const controller = new AbortController()
  const result = await runCommand({ ...invocation(['-e', 'setInterval(()=>{},1000)']), stdin: 'x'.repeat(512 * 1024), timeoutMs: 50, signal: controller.signal })
  assert.equal(result.status, 'timeout')
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  assert.ok(result.durationMs < 1500)
  const success = await runCommand({ ...invocation(['-e', 'process.exit(0)']), signal: controller.signal })
  assert.equal(success.status, 'exited')
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
})
