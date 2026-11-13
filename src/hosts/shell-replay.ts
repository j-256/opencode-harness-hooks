import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import type { Stats } from 'node:fs'
import { access, lstat, mkdir, mkdtemp, open, readdir, rm, rmdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { HostHookError } from '../host-errors.js'
import type { SessionSnapshot } from '../sessions.js'
import type { ClaudeEnvironmentPlan } from '../claude-environment-files.js'

const MAX_SESSIONS = 1024
const MAX_FILES = 256
const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_CAPTURE_BYTES = 8 * 1024 * 1024
const MAX_RETAINED_BYTES = 64 * 1024 * 1024
const MAX_CAPTURES = 16
const SNAPSHOT_ENV = 'OPENCODE_HARNESS_ENV_SNAPSHOT'
const FILE_NAME = /^sessionstart-hook-(0|[1-9]\d*)\.sh$/
interface Plan extends ClaudeEnvironmentPlan { readonly directory?: string }
interface State { readonly signal: AbortSignal; readonly activationID: string; readonly signature: string; readonly directory?: string; readonly cleanup: () => void; pending?: Promise<string>; snapshot?: string }
interface Snapshot { readonly path: string; readonly bytes: number; readonly stat: Stats }
function fail(code: string): never { throw new HostHookError(code, code === 'HOST_ENVIRONMENT_CANCELLED' ? 'cancelled' : 'unsupported') }
function quote(text: string): string { return "'" + text.replaceAll("'", "'\"'\"'") + "'" }
function missing(error: unknown): boolean { return error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT' }
function owned(info: { readonly uid: number }): boolean { return !process.getuid || info.uid === process.getuid() }
function check(signal: AbortSignal): void { if (signal.aborted) fail('HOST_ENVIRONMENT_CANCELLED') }

export class V1ShellReplay {
  private readonly states = new Map<string, State>()
  private readonly wrappers = new Map<string, Promise<string>>()
  private readonly active = new Set<Promise<unknown>>()
  private readonly lifetime = new AbortController()
  private readonly deleted = new Set<string>()
  private readonly snapshots = new Map<string, Set<Snapshot>>()
  private readonly captureWork = new Map<string, Set<Promise<unknown>>>()
  private readonly removals = new Map<string, Promise<void>>()
  private readonly wrapperFiles = new Map<string, Snapshot>()
  private readonly wrapperDirectories = new Map<string, Stats>()
  private directory?: Promise<string>
  private rootOwnership?: Stats
  private retainedBytes = 0
  private captures = 0
  private disposing?: Promise<void>

  constructor(private readonly options: { readonly temporaryParent?: string } = {}) {
    if (options.temporaryParent !== undefined && !isAbsolute(options.temporaryParent)) fail('HOST_ENVIRONMENT_OPTIONS_INVALID')
  }

  admit(session: SessionSnapshot, activationID: string, plan: Plan): void {
    check(AbortSignal.any([this.lifetime.signal, session.signal]))
    if (this.deleted.has(session.sessionID)) fail('HOST_ENVIRONMENT_SESSION_DELETED')
    if (!activationID || activationID.includes('\0') || !Array.isArray(plan.files) || plan.files.length > MAX_FILES) fail('HOST_ENVIRONMENT_PLAN_INVALID')
    const directory = plan.directory ?? (plan.files[0] ? dirname(plan.files[0].path) : undefined)
    if (directory !== undefined && !isAbsolute(directory) || plan.files.some(file => !isAbsolute(file.path) || file.path.includes('\0') || dirname(file.path) !== directory || !FILE_NAME.test(basename(file.path)))) fail('HOST_ENVIRONMENT_PLAN_INVALID')
    const signature = JSON.stringify([directory, plan.files.map(file => [file.registrationID, file.path])])
    const previous = this.states.get(session.sessionID)
    if (previous && previous.signal !== session.signal) fail('HOST_ENVIRONMENT_OWNER_MISMATCH')
    if (previous?.activationID === activationID) { if (previous.signature !== signature) fail('HOST_ENVIRONMENT_OWNER_MISMATCH'); return }
    if (previous?.pending) fail('HOST_ENVIRONMENT_CAPTURE_BUSY')
    if (!previous && this.states.size >= MAX_SESSIONS) fail('HOST_ENVIRONMENT_LIMIT')
    const cleanup = () => { const state = this.states.get(session.sessionID); if (state?.signal !== session.signal) return; this.states.delete(session.sessionID); session.signal.removeEventListener('abort', cleanup) }
    if (previous) session.signal.removeEventListener('abort', previous.cleanup)
    this.states.set(session.sessionID, { signal: session.signal, activationID, signature, ...(directory ? { directory } : {}), cleanup })
    session.signal.addEventListener('abort', cleanup, { once: true })
  }

  configure(program: string): Promise<string> {
    if (this.lifetime.signal.aborted) return Promise.reject(new HostHookError('HOST_ENVIRONMENT_CANCELLED', 'cancelled'))
    if (!isAbsolute(program) || program.includes('\0')) return Promise.reject(new HostHookError('HOST_ENVIRONMENT_SHELL_INVALID', 'unsupported'))
    const previous = this.wrappers.get(program)
    if (previous) return previous
    const pending = (async () => {
      await access(program, constants.X_OK)
      const directory = join(await this.root(), 'shell-' + createHash('sha256').update(program).digest('hex'))
      await mkdir(directory, { mode: 0o700 })
      this.wrapperDirectories.set(directory, await lstat(directory))
      const path = join(directory, basename(program))
      const script = `#!/bin/bash
if [ -z "\${${SNAPSHOT_ENV}-}" ]; then exec ${quote(program)} "$@"; fi
harness_login=
case "\${1-}" in
  -c|-lc|-cl) harness_flag=$1; shift ;;
  -l) harness_login=-l; shift; [ "\${1-}" = -c ] || { echo HOST_SHELL_INVOCATION_UNSUPPORTED >&2; exit 70; }; harness_flag=-c; shift ;;
  *) echo HOST_SHELL_INVOCATION_UNSUPPORTED >&2; exit 70 ;;
esac
[ "$#" -gt 0 ] || { echo HOST_SHELL_INVOCATION_UNSUPPORTED >&2; exit 70; }
harness_command=$1
shift
harness_command='. "$${SNAPSHOT_ENV}"
'"$harness_command"
if [ -n "$harness_login" ]; then exec ${quote(program)} "$harness_login" "$harness_flag" "$harness_command" "$@"; fi
exec ${quote(program)} "$harness_flag" "$harness_command" "$@"
`
      await writeFile(path, script, { flag: 'wx', mode: 0o700 })
      this.wrapperFiles.set(path, { path, bytes: Buffer.byteLength(script), stat: await lstat(path) })
      if (this.lifetime.signal.aborted) fail('HOST_ENVIRONMENT_CANCELLED')
      return path
    })()
    this.wrappers.set(program, pending)
    this.track(pending)
    return pending
  }

  async environment(session: SessionSnapshot): Promise<Readonly<Record<string, string>>> {
    const signal = AbortSignal.any([this.lifetime.signal, session.signal, session.turnSignal])
    check(signal)
    if (this.deleted.has(session.sessionID)) fail('HOST_ENVIRONMENT_SESSION_DELETED')
    const state = this.states.get(session.sessionID)
    if (!state) return {}
    if (state.signal !== session.signal) fail('HOST_ENVIRONMENT_OWNER_MISMATCH')
    if (!state.snapshot && !state.pending) {
      const pending = this.capture(session.sessionID, state, signal)
      state.pending = pending
      this.track(pending)
      const work = this.captureWork.get(session.sessionID) ?? new Set<Promise<unknown>>()
      work.add(pending); this.captureWork.set(session.sessionID, work)
      void pending.finally(() => { work.delete(pending); if (!work.size) this.captureWork.delete(session.sessionID) }).catch(() => {})
      void pending.finally(() => { if (state.pending === pending) delete state.pending }).catch(() => {})
    }
    const path = state.snapshot ?? await state.pending!
    check(signal)
    if (this.states.get(session.sessionID) !== state) fail('HOST_ENVIRONMENT_OWNER_MISMATCH')
    return Object.freeze({ [SNAPSHOT_ENV]: path })
  }

  async removeSession(sessionID: string): Promise<void> {
    if (!sessionID || sessionID.includes('\0')) fail('HOST_ENVIRONMENT_PLAN_INVALID')
    if (!this.deleted.has(sessionID) && this.deleted.size >= MAX_SESSIONS) fail('HOST_ENVIRONMENT_LIMIT')
    this.deleted.add(sessionID)
    const existing = this.removals.get(sessionID)
    if (existing) return existing
    const pending = (async () => { await Promise.allSettled([...(this.captureWork.get(sessionID) ?? [])]); await this.removeSnapshots(sessionID) })()
    this.removals.set(sessionID, pending); this.track(pending)
    void pending.finally(() => { if (this.removals.get(sessionID) === pending) this.removals.delete(sessionID) }).catch(() => {})
    return pending
  }

  private async removeSnapshots(sessionID: string): Promise<void> {
    const snapshots = this.snapshots.get(sessionID)
    if (!snapshots?.size) return
    await this.verifyRoot()
    for (const snapshot of snapshots) await this.verifySnapshot(snapshot)
    for (const snapshot of snapshots) {
      await this.verifyRoot(); await this.verifySnapshot(snapshot)
      await rm(snapshot.path)
      snapshots.delete(snapshot); this.retainedBytes -= snapshot.bytes
    }
    this.snapshots.delete(sessionID)
  }

  inspect() { return Object.freeze({ retainedBytes: this.retainedBytes, retainedSessions: this.snapshots.size, captures: this.captures, pending: this.active.size }) }

  dispose(): Promise<void> {
    return this.disposing ??= this.disposeOwned().finally(() => { delete this.disposing })
  }

  private async disposeOwned(): Promise<void> {
    this.lifetime.abort()
    await Promise.allSettled([...this.active])
    if (this.directory) {
      const directory = await this.directory
      await this.verifyRoot()
      const files = [...this.snapshots.values()].flatMap(snapshots => [...snapshots])
      const paths = new Set([...files.map(file => file.path), ...this.wrapperFiles.keys(), ...this.wrapperDirectories.keys()])
      if ((await readdir(directory)).some(name => !paths.has(join(directory, name)))) fail('HOST_ENVIRONMENT_FILE_CHANGED')
      for (const path of this.wrapperDirectories.keys()) {
        await this.verifyWrapperDirectory(path)
        if ((await readdir(path)).some(name => !this.wrapperFiles.has(join(path, name)))) fail('HOST_ENVIRONMENT_FILE_CHANGED')
      }
      for (const file of [...files, ...this.wrapperFiles.values()]) await this.verifySnapshot(file)
      for (const sessionID of this.snapshots.keys()) await this.removeSnapshots(sessionID)
      for (const [path, file] of this.wrapperFiles) { await this.verifyRoot(); await this.verifyWrapperDirectory(dirname(path)); await this.verifySnapshot(file); await rm(path); this.wrapperFiles.delete(path) }
      for (const path of this.wrapperDirectories.keys()) { await this.verifyRoot(); await this.verifyWrapperDirectory(path); await rmdir(path); this.wrapperDirectories.delete(path) }
      await this.verifyRoot(); await rmdir(directory)
      delete this.directory; delete this.rootOwnership
    }
    for (const state of this.states.values()) state.signal.removeEventListener('abort', state.cleanup)
    this.states.clear(); this.wrappers.clear(); this.snapshots.clear(); this.retainedBytes = 0
  }

  private root(): Promise<string> { return this.directory ??= mkdtemp(join(this.options.temporaryParent ?? tmpdir(), 'harness-shell-replay-')).then(async path => { this.rootOwnership = await lstat(path); return path }) }
  private async verifyRoot(): Promise<void> {
    const info = this.directory ? await lstat(await this.directory).catch(() => undefined) : undefined, saved = this.rootOwnership
    if (!info?.isDirectory() || !saved || info.dev !== saved.dev || info.ino !== saved.ino || !owned(info) || (info.mode & 0o077) !== 0) fail('HOST_ENVIRONMENT_FILE_CHANGED')
  }
  private async verifySnapshot(snapshot: Snapshot): Promise<void> {
    const info = await lstat(snapshot.path).catch(() => undefined), saved = snapshot.stat
    if (!info?.isFile() || info.dev !== saved.dev || info.ino !== saved.ino || !owned(info) || info.nlink !== 1 || (info.mode & 0o077) !== 0 || info.size !== saved.size || info.mtimeMs !== saved.mtimeMs) fail('HOST_ENVIRONMENT_FILE_CHANGED')
  }
  private async verifyWrapperDirectory(path: string): Promise<void> {
    const info = await lstat(path).catch(() => undefined), saved = this.wrapperDirectories.get(path)
    if (!info?.isDirectory() || !saved || info.dev !== saved.dev || info.ino !== saved.ino || !owned(info) || (info.mode & 0o077) !== 0) fail('HOST_ENVIRONMENT_FILE_CHANGED')
  }
  private track(pending: Promise<unknown>): void { this.active.add(pending); void pending.finally(() => this.active.delete(pending)).catch(() => {}) }

  private async capture(sessionID: string, state: State, signal: AbortSignal): Promise<string> {
    if (this.captures >= MAX_CAPTURES) fail('HOST_ENVIRONMENT_LIMIT')
    this.captures++
    let path: string | undefined
    let reservation = 0
    try {
      const chunks: string[] = []
      let bytes = 0
      if (state.directory) {
        const directory = await lstat(state.directory).catch(error => { if (missing(error)) return undefined; throw error })
        if (directory && (!directory.isDirectory() || !owned(directory) || (directory.mode & 0o077) !== 0)) fail('HOST_ENVIRONMENT_FILE_UNSAFE')
        const files = (directory ? await readdir(state.directory) : []).flatMap(name => { const match = FILE_NAME.exec(name); return match ? [{ name, order: Number(match[1]) }] : [] }).sort((left, right) => left.order - right.order)
        if (files.length > MAX_FILES || files.some(file => file.order >= MAX_FILES)) fail('HOST_ENVIRONMENT_LIMIT')
        for (const file of files) {
          check(signal)
          const handle = await open(join(state.directory, file.name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(error => { if (missing(error)) return undefined; fail('HOST_ENVIRONMENT_FILE_UNSAFE') })
          if (!handle) continue
          try {
            const info = await handle.stat()
            if (!info.isFile() || !owned(info) || info.nlink !== 1 || (info.mode & 0o022) !== 0) fail('HOST_ENVIRONMENT_FILE_UNSAFE')
            if (info.size > MAX_FILE_BYTES) fail('HOST_ENVIRONMENT_LIMIT')
            const buffer = Buffer.alloc(MAX_FILE_BYTES + 1)
            let offset = 0
            while (offset < buffer.length) { check(signal); const read = await handle.read(buffer, offset, buffer.length - offset, offset); if (!read.bytesRead) break; offset += read.bytesRead }
            if (offset > MAX_FILE_BYTES || bytes + offset > MAX_CAPTURE_BYTES) fail('HOST_ENVIRONMENT_LIMIT')
            const after = await handle.stat()
            if (after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) fail('HOST_ENVIRONMENT_FILE_CHANGED')
            chunks.push(buffer.subarray(0, offset).toString('utf8') + '\n'); bytes += offset + 1
          } finally { await handle.close() }
        }
      }
      check(signal)
      const content = chunks.join('')
      bytes = Buffer.byteLength(content)
      if (this.retainedBytes + bytes > MAX_RETAINED_BYTES) fail('HOST_ENVIRONMENT_LIMIT')
      this.retainedBytes += bytes
      reservation = bytes
      path = join(await this.root(), 'snapshot-' + createHash('sha256').update(JSON.stringify([sessionID, state.activationID])).digest('hex') + '-' + randomUUID() + '.sh')
      await writeFile(path, content, { flag: 'wx', mode: 0o600 })
      check(signal)
      if (this.deleted.has(sessionID)) fail('HOST_ENVIRONMENT_SESSION_DELETED')
      if (this.states.get(sessionID) !== state) fail('HOST_ENVIRONMENT_OWNER_MISMATCH')
      if (!this.snapshots.has(sessionID) && this.snapshots.size >= MAX_SESSIONS) fail('HOST_ENVIRONMENT_LIMIT')
      const snapshots = this.snapshots.get(sessionID) ?? new Set<Snapshot>()
      snapshots.add({ path, bytes, stat: await lstat(path) }); this.snapshots.set(sessionID, snapshots)
      state.snapshot = path
      reservation = 0
      return path
    } catch (error) {
      this.retainedBytes -= reservation
      if (path) await rm(path, { force: true })
      if (signal.aborted) fail('HOST_ENVIRONMENT_CANCELLED')
      if (error instanceof HostHookError) throw error
      fail('HOST_ENVIRONMENT_CAPTURE_FAILED')
    } finally { this.captures-- }
  }
}
