import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { V1ShellReplay } from '../src/hosts/shell-replay.js'
import { Sessions } from '../src/sessions.js'

const run = promisify(execFile)
const quote = (text: string) => "'" + text.replaceAll("'", "'\"'\"'") + "'"
async function fixture(t: { after: (callback: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), 'shell-replay-')), files = join(root, 'environment')
  await mkdir(files, { mode: 0o700 })
  const replay = new V1ShellReplay({ temporaryParent: root }), sessions = new Sessions()
  sessions.prompt('session', 'turn', 'fixture')
  t.after(async () => { await replay.dispose(); sessions.dispose(); await rm(root, { recursive: true, force: true }) })
  const path = (index: number) => join(files, 'sessionstart-hook-' + index + '.sh')
  const plan = { files: [{ registrationID: 'first', path: path(0) }, { registrationID: 'last', path: path(1) }], registrationContext: {} }
  return { root, files, path, replay, sessions, plan }
}

for (const shell of ['/bin/bash', '/bin/zsh', '/bin/sh']) test(`opaque environment replay preserves functions, order, snapshot timing and shell arguments (${shell})`, { skip: !existsSync(shell) }, async t => {
  const f = await fixture(t), counter = join(f.root, 'counter')
  await writeFile(f.path(0), `export VALUE=first\nstartup_function(){ printf function; }\nprintf tick >> ${quote(counter)}\nexport LOCAL_COUNT=$((\${LOCAL_COUNT:-0}+1))\n`)
  await writeFile(f.path(1), 'export VALUE=last\n')
  f.replay.admit(f.sessions.get('session'), 'activation', f.plan)
  const executable = await f.replay.configure(shell)
  await writeFile(f.path(1), 'export VALUE=pretool\n')
  const extra = await f.replay.environment(f.sessions.get('session'))
  const env = { PATH: process.env.PATH, HOME: f.root, SHELL: shell, ...extra }
  const command = 'printf "%s|%s|%s|%s|%s" "$VALUE" "$(startup_function)" "$LOCAL_COUNT" "$0" "$1"'
  const first = await run(executable, ['-c', command, 'original-zero', 'original-one'], { env, cwd: f.root, timeout: 5000 })
  assert.equal(first.stdout, 'pretool|function|1|original-zero|original-one')
  await writeFile(f.path(1), 'export VALUE=after-first-shell\n')
  const second = await run(executable, ['-c', command, 'original-zero', 'original-one'], { env: { ...env, ...await f.replay.environment(f.sessions.get('session')) }, cwd: f.root, timeout: 5000 })
  assert.equal(second.stdout, first.stdout)
  assert.equal(await readFile(counter, 'utf8'), 'ticktick')
  const passthrough = await run(executable, ['-c', 'printf "%s:%s" "$0" "$1"', 'unchanged-zero', 'unchanged-one'], { env: { PATH: process.env.PATH, HOME: f.root }, timeout: 5000 })
  assert.equal(passthrough.stdout, 'unchanged-zero:unchanged-one')
})

test('retained native ordinals omitted by a resumed selection still execute in order', async t => {
  const f = await fixture(t)
  await writeFile(f.path(0), 'export VALUE=selected\n')
  await writeFile(f.path(1), 'export VALUE=retained\n')
  f.replay.admit(f.sessions.get('session'), 'resume', { ...f.plan, files: f.plan.files.slice(0, 1) })
  const executable = await f.replay.configure('/bin/bash')
  const env = { PATH: process.env.PATH, HOME: f.root, ...await f.replay.environment(f.sessions.get('session')) }
  assert.equal((await run(executable, ['-c', 'printf %s "$VALUE"'], { env, timeout: 5000 })).stdout, 'retained')
})

test('foreign files, missing ownership and cancellation cannot launch unowned environment code', async t => {
  const f = await fixture(t), outside = join(f.root, 'foreign.sh')
  await writeFile(outside, 'export VALUE=foreign\n')
  await symlink(outside, f.path(0))
  f.replay.admit(f.sessions.get('session'), 'activation', f.plan)
  await assert.rejects(f.replay.environment(f.sessions.get('session')), { code: 'HOST_ENVIRONMENT_FILE_UNSAFE' })
  const previous = f.sessions.get('session')
  f.sessions.close('session')
  await assert.rejects(f.replay.environment(previous), { code: 'HOST_ENVIRONMENT_CANCELLED' })
})

test('the internal launcher preserves ambient Bash startup exactly once', async t => {
  const f = await fixture(t), ambient = join(f.root, 'ambient.sh'), counter = join(f.root, 'ambient-counter')
  await writeFile(ambient, `printf ambient >> ${quote(counter)}\nexport AMBIENT=yes\n`)
  await writeFile(f.path(0), 'export VALUE=hook\n')
  f.replay.admit(f.sessions.get('session'), 'activation', f.plan)
  const executable = await f.replay.configure('/bin/bash')
  const env = { PATH: process.env.PATH, HOME: f.root, BASH_ENV: ambient, ...await f.replay.environment(f.sessions.get('session')) }
  const result = await run(executable, ['-c', 'printf "%s:%s" "$AMBIENT" "$VALUE"'], { env, timeout: 5000 })
  assert.equal(result.stdout, 'yes:hook')
  assert.equal(await readFile(counter, 'utf8'), 'ambient')
})

test('zero selected resume hooks still replay retained native files', async t => {
  const f = await fixture(t)
  await writeFile(f.path(0), 'export VALUE=retained-zero\n')
  f.replay.admit(f.sessions.get('session'), 'resume', { directory: f.files, files: [], registrationContext: {} })
  const executable = await f.replay.configure('/bin/bash')
  assert.equal((await run(executable, ['-c', 'printf %s "$VALUE"'], { env: { PATH: process.env.PATH, HOME: f.root, ...await f.replay.environment(f.sessions.get('session')) }, timeout: 5000 })).stdout, 'retained-zero')
})
