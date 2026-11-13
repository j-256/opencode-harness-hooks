import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import type { Stats } from 'node:fs'
import { link, lstat, mkdir, open, readdir, rmdir, unlink } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type { RegistrationContext } from './host-services.js'
import type { LoadedSource, Registration } from './types.js'

const DEFAULT_REGISTRATION_LIMIT = 256
const MAX_SOURCES = 64
const MAX_SNAPSHOT_REGISTRATIONS = 4096
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024
const MAX_ID_BYTES = 4096
const MAX_MANIFEST_BYTES = 1024
const PRIVATE_DIRECTORY_MODE = 0o700
const PRIVATE_FILE_MODE = 0o600
const MANIFEST_VERSION = 2
const MAX_SESSIONS = 1024
const HOOK_FILE = /^sessionstart-hook-(0|[1-9]\d*)\.sh$/

interface Options {
  readonly directory: string
  readonly sources: readonly LoadedSource[]
  readonly maxRegistrations?: number
}

export interface ClaudeEnvironmentPlan {
  readonly directory?: string
  readonly files: readonly { readonly registrationID: string; readonly path: string }[]
  readonly registrationContext: Readonly<Record<string, RegistrationContext>>
}

export class ClaudeEnvironmentError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'ClaudeEnvironmentError' }
}

function fail(code: string): never { throw new ClaudeEnvironmentError(code) }
function errno(error: unknown, code: string): boolean { return error !== null && typeof error === 'object' && 'code' in error && error.code === code }
function hash(value: string): string { return createHash('sha256').update(value).digest('hex') }
function validID(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && !value.includes('\0') && Buffer.byteLength(value) <= MAX_ID_BYTES }
function owned(info: Stats): boolean { return !process.getuid || info.uid === process.getuid() }
function cancelled(signal?: AbortSignal): void { if (signal?.aborted) fail('ENVIRONMENT_CANCELLED') }
function eligible(registration: Registration): boolean { return registration.dialect === 'claude-code' && registration.event === 'SessionStart' && registration.handler.type === 'command' && (registration.handler.args !== undefined || registration.handler.shell !== 'powershell') }
function revision(value: unknown, budget?: { bytes: number }): string {
  const text = JSON.stringify(value)
  const bytes = Buffer.byteLength(text)
  if (bytes > MAX_SNAPSHOT_BYTES || budget && budget.bytes + bytes > MAX_SNAPSHOT_BYTES) fail('ENVIRONMENT_SNAPSHOT_LIMIT')
  if (budget) budget.bytes += bytes
  return hash(text)
}
function signature(registration: Registration, budget?: { bytes: number }): string {
  return revision([registration.id, registration.sourceID, registration.dialect, registration.event, registration.groupIndex, registration.handlerIndex, registration.matcher, registration.handler, registration.projectRoot, registration.pluginRoot], budget)
}

async function privateDirectory(path: string, recursive = false): Promise<void> {
  await mkdir(path, { recursive, mode: PRIVATE_DIRECTORY_MODE }).catch(error => { if (!errno(error, 'EEXIST')) throw error })
  const info = await lstat(path)
  if (!info.isDirectory() || !owned(info) || (info.mode & 0o077) !== 0) fail('ENVIRONMENT_DIRECTORY_UNSAFE')
}

async function validateHookFile(path: string): Promise<void> {
  const info = await lstat(path).catch(error => { if (errno(error, 'ENOENT')) return undefined; throw error })
  if (info && (!info.isFile() || !owned(info) || info.nlink !== 1)) fail('ENVIRONMENT_FILE_UNSAFE')
}

async function validateManifest(path: string, expected?: string): Promise<Stats> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(error => {
    if (errno(error, 'ELOOP')) fail('ENVIRONMENT_FILE_UNSAFE')
    throw error
  })
  try {
    const info = await file.stat()
    if (!info.isFile() || !owned(info) || (info.mode & 0o077) !== 0) fail('ENVIRONMENT_FILE_UNSAFE')
    if (info.size > MAX_MANIFEST_BYTES) fail('ENVIRONMENT_LAYOUT_UNSUPPORTED')
    const buffer = Buffer.alloc(MAX_MANIFEST_BYTES + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, length)
      if (bytesRead === 0) break
      length += bytesRead
    }
    const text = buffer.subarray(0, length).toString('utf8')
    if (expected !== undefined) { if (!Buffer.from(text).equals(Buffer.from(expected))) fail('ENVIRONMENT_LAYOUT_UNSUPPORTED') }
    else {
      let manifest
      try { manifest = JSON.parse(text) } catch { fail('ENVIRONMENT_LAYOUT_UNSUPPORTED') }
      if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || Object.keys(manifest).sort().join(',') !== 'layout,version' || manifest.version !== MANIFEST_VERSION || typeof manifest.layout !== 'string' || !/^[a-f0-9]{64}$/.test(manifest.layout) || info.nlink !== 1) fail('ENVIRONMENT_LAYOUT_UNSUPPORTED')
    }
    const after = await file.stat()
    if (after.size !== length || after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) fail('ENVIRONMENT_FILE_UNSAFE')
    return info
  } finally { await file.close() }
}

async function reserveManifest(directory: string, text: string, signal?: AbortSignal): Promise<void> {
  const path = join(directory, 'manifest.json')
  try {
    await validateManifest(path, text)
    return
  } catch (error) { if (!errno(error, 'ENOENT')) throw error }
  const temporary = join(directory, randomUUID() + '.tmp')
  const file = await open(temporary, 'wx', PRIVATE_FILE_MODE)
  try {
    try { await file.writeFile(text) } finally { await file.close() }
    cancelled(signal)
    // Linking publishes complete bytes without replacing another activation's manifest
    await link(temporary, path).catch(error => { if (!errno(error, 'EEXIST')) throw error })
  } finally {
    await unlink(temporary)
  }
  await validateManifest(path, text)
}

export class ClaudeEnvironmentFiles {
  private readonly serial = new Map<string, Promise<unknown>>()
  private readonly deleted = new Set<string>()
  private readonly directories = new Map<string, Stats>()
  private rootOwnership?: Stats
  private readonly directory: string
  private readonly limit: number
  private readonly revision: string
  private readonly reviewed = new Map<string, { readonly signature: string; readonly digest: string; readonly order: number }>()

  constructor(options: Options) {
    const limit = options.maxRegistrations ?? DEFAULT_REGISTRATION_LIMIT
    if (!isAbsolute(options.directory) || options.directory.includes('\0') || !Number.isSafeInteger(limit) || limit < 1 || limit > DEFAULT_REGISTRATION_LIMIT) fail('ENVIRONMENT_OPTIONS_INVALID')
    if (!Array.isArray(options.sources) || options.sources.length > MAX_SOURCES) fail('ENVIRONMENT_SNAPSHOT_LIMIT')
    const ids = new Set<string>()
    const registrationIDs = new Set<string>()
    const budget = { bytes: 0 }
    let registrationCount = 0
    this.revision = revision(options.sources.flatMap((source: LoadedSource) => {
      if (!validID(source.id) || ids.has(source.id) || !['claude-code', 'codex'].includes(source.dialect) || !/^[a-f0-9]{64}$/.test(source.digest) || !validID(source.path) || !isAbsolute(source.path) || typeof source.enabled !== 'boolean') fail('ENVIRONMENT_SOURCE_INVALID')
      ids.add(source.id)
      if (source.dialect !== 'claude-code') return []
      registrationCount += source.registrations.length
      if (registrationCount > MAX_SNAPSHOT_REGISTRATIONS) fail('ENVIRONMENT_SNAPSHOT_LIMIT')
      const registrations = source.registrations.filter(eligible).map(registration => {
        if (!validID(registration.id) || registration.sourceID !== source.id || registrationIDs.has(registration.id) || registration.sourceDigest !== undefined && registration.sourceDigest !== source.digest) fail('ENVIRONMENT_SOURCE_INVALID')
        registrationIDs.add(registration.id)
        const digest = signature(registration, budget)
        if (source.enabled) this.reviewed.set(registration.id, { signature: digest, digest: source.digest, order: this.reviewed.size })
        return [registration.id, digest]
      })
      return [[source.id, source.digest, source.enabled, source.path, source.projectRoot, source.pluginRoot, registrations]]
    }), budget)
    this.directory = options.directory
    this.limit = limit
  }

  prepare(sessionID: string, registrations: readonly Registration[], signal?: AbortSignal): Promise<ClaudeEnvironmentPlan> {
    try {
      if (!Array.isArray(registrations) || registrations.length > this.limit) fail('ENVIRONMENT_REGISTRATION_LIMIT')
      const selected = structuredClone(registrations)
      return this.schedule(sessionID, () => this.prepareSession(sessionID, selected, signal))
    } catch (error) { return Promise.reject(error instanceof ClaudeEnvironmentError ? error : new ClaudeEnvironmentError('ENVIRONMENT_REGISTRATION_INVALID')) }
  }

  private async prepareSession(sessionID: string, registrations: readonly Registration[], signal?: AbortSignal): Promise<ClaudeEnvironmentPlan> {
    try {
      if (process.platform === 'win32') fail('ENVIRONMENT_PLATFORM_UNSUPPORTED')
      if (!validID(sessionID)) fail('ENVIRONMENT_SESSION_INVALID')
      if (this.deleted.has(sessionID)) fail('ENVIRONMENT_SESSION_DELETED')
      if (registrations.length > this.limit) fail('ENVIRONMENT_REGISTRATION_LIMIT')
      const ids = new Set<string>()
      let previousOrder = -1
      const selected = registrations.map(registration => {
        if (!validID(registration.id) || !validID(registration.sourceID) || ids.has(registration.id)) fail('ENVIRONMENT_REGISTRATION_INVALID')
        ids.add(registration.id)
        if (!eligible(registration)) fail('ENVIRONMENT_EVENT_UNSUPPORTED')
        const reviewed = this.reviewed.get(registration.id)
        if (!reviewed) fail('ENVIRONMENT_REGISTRATION_UNREVIEWED')
        if (registration.sourceDigest !== undefined && registration.sourceDigest !== reviewed.digest) fail('ENVIRONMENT_SOURCE_REVISION_UNAVAILABLE')
        if (signature(registration) !== reviewed.signature) fail('ENVIRONMENT_REGISTRATION_UNREVIEWED')
        if (reviewed.order <= previousOrder) fail('ENVIRONMENT_REGISTRATION_ORDER_INVALID')
        previousOrder = reviewed.order
        return registration.id
      })
      cancelled(signal)
      const directory = join(this.directory, hash(sessionID))
      const files = selected.map((registrationID, index) => Object.freeze({ registrationID, path: join(directory, `sessionstart-hook-${index}.sh`) }))
      const context: Record<string, RegistrationContext> = Object.create(null) as Record<string, RegistrationContext>
      for (const file of files) context[file.registrationID] = Object.freeze({ envFile: file.path })
      const plan = Object.freeze({ directory, files: Object.freeze(files), registrationContext: Object.freeze(context) })
      if (!files.length) return plan
      const manifest = JSON.stringify({ version: MANIFEST_VERSION, layout: this.revision }) + '\n'
      await privateDirectory(this.directory, true)
      await this.verifyDirectory(this.directory)
      cancelled(signal)
      await privateDirectory(directory)
      await this.verifyDirectory(directory, sessionID)
      await reserveManifest(directory, manifest, signal)
      for (const file of files) await validateHookFile(file.path)
      cancelled(signal)
      return plan
    } catch (error) {
      if (error instanceof ClaudeEnvironmentError) throw error
      fail('ENVIRONMENT_STORAGE_FAILED')
    }
  }

  removeSession(sessionID: string): Promise<void> {
    if (!validID(sessionID)) return Promise.reject(new ClaudeEnvironmentError('ENVIRONMENT_SESSION_INVALID'))
    if (!this.deleted.has(sessionID) && this.deleted.size >= MAX_SESSIONS) return Promise.reject(new ClaudeEnvironmentError('ENVIRONMENT_SNAPSHOT_LIMIT'))
    this.deleted.add(sessionID)
    return this.schedule(sessionID, async () => {
      try {
        const directory = join(this.directory, hash(sessionID))
        if (!await lstat(this.directory).catch(error => { if (errno(error, 'ENOENT')) return undefined; throw error })) return
        await this.verifyDirectory(this.directory)
        if (!await lstat(directory).catch(error => { if (errno(error, 'ENOENT')) return undefined; throw error })) return
        await this.verifyDirectory(directory, sessionID)
        const names = await readdir(directory)
        if (names.length > DEFAULT_REGISTRATION_LIMIT + 1 || names.some(name => name !== 'manifest.json' && (!HOOK_FILE.test(name) || Number(HOOK_FILE.exec(name)![1]) >= DEFAULT_REGISTRATION_LIMIT))) fail('ENVIRONMENT_LAYOUT_UNSUPPORTED')
        if (names.length && !names.includes('manifest.json')) fail('ENVIRONMENT_LAYOUT_UNSUPPORTED')
        const entries: { path: string; stat: Stats }[] = []
        for (const name of names.filter(name => name !== 'manifest.json')) {
          const path = join(directory, name), stat = await lstat(path)
          if (!stat.isFile() || !owned(stat) || stat.nlink !== 1 || (stat.mode & 0o022) !== 0) fail('ENVIRONMENT_FILE_UNSAFE')
          entries.push({ path, stat })
        }
        if (names.includes('manifest.json')) entries.push({ path: join(directory, 'manifest.json'), stat: await validateManifest(join(directory, 'manifest.json')) })
        for (const entry of entries) {
          await this.verifyDirectory(this.directory); await this.verifyDirectory(directory, sessionID)
          const stat = await lstat(entry.path)
          if (!stat.isFile() || stat.dev !== entry.stat.dev || stat.ino !== entry.stat.ino || stat.nlink !== 1 || !owned(stat) || stat.size !== entry.stat.size || stat.mtimeMs !== entry.stat.mtimeMs) fail('ENVIRONMENT_FILE_UNSAFE')
          await unlink(entry.path)
        }
        await this.verifyDirectory(this.directory); await this.verifyDirectory(directory, sessionID)
        await rmdir(directory); this.directories.delete(sessionID)
      } catch (error) { if (error instanceof ClaudeEnvironmentError) throw error; fail('ENVIRONMENT_STORAGE_FAILED') }
    })
  }

  private async verifyDirectory(path: string, sessionID?: string): Promise<void> {
    const stat = await lstat(path), previous = sessionID === undefined ? this.rootOwnership : this.directories.get(sessionID)
    if (!stat.isDirectory() || !owned(stat) || (stat.mode & 0o077) !== 0 || previous && (previous.dev !== stat.dev || previous.ino !== stat.ino)) fail('ENVIRONMENT_DIRECTORY_UNSAFE')
    if (sessionID === undefined) this.rootOwnership ??= stat
    else { if (!previous && this.directories.size >= MAX_SESSIONS) fail('ENVIRONMENT_SNAPSHOT_LIMIT'); this.directories.set(sessionID, stat) }
  }
  private schedule<T>(sessionID: string, operation: () => Promise<T>): Promise<T> {
    if (!validID(sessionID)) return Promise.reject(new ClaudeEnvironmentError('ENVIRONMENT_SESSION_INVALID'))
    if (this.serial.size >= MAX_SESSIONS && !this.serial.has(sessionID)) return Promise.reject(new ClaudeEnvironmentError('ENVIRONMENT_SNAPSHOT_LIMIT'))
    const pending = (this.serial.get(sessionID) ?? Promise.resolve()).catch(() => {}).then(operation)
    this.serial.set(sessionID, pending)
    void pending.finally(() => { if (this.serial.get(sessionID) === pending) this.serial.delete(sessionID) }).catch(() => {})
    return pending
  }
}
