import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import type { Stats } from 'node:fs'
import { link, lstat, mkdir, open, unlink } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type { RegistrationContext } from './host-services.js'
import type { Registration } from './types.js'

const DEFAULT_REGISTRATION_LIMIT = 256
const MAX_ID_BYTES = 4096
const MAX_MANIFEST_BYTES = 1024
const PRIVATE_DIRECTORY_MODE = 0o700
const PRIVATE_FILE_MODE = 0o600
const MANIFEST_VERSION = 1

interface Options {
  readonly directory: string
  readonly maxRegistrations?: number
}

export interface ClaudeEnvironmentPlan {
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

async function privateDirectory(path: string, recursive = false): Promise<void> {
  await mkdir(path, { recursive, mode: PRIVATE_DIRECTORY_MODE }).catch(error => { if (!errno(error, 'EEXIST')) throw error })
  const info = await lstat(path)
  if (!info.isDirectory() || !owned(info) || (info.mode & 0o077) !== 0) fail('ENVIRONMENT_DIRECTORY_UNSAFE')
}

async function validateHookFile(path: string): Promise<void> {
  const info = await lstat(path).catch(error => { if (errno(error, 'ENOENT')) return undefined; throw error })
  if (info && (!info.isFile() || !owned(info) || info.nlink !== 1)) fail('ENVIRONMENT_FILE_UNSAFE')
}

async function validateManifest(path: string, expected: string): Promise<void> {
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
    if (!buffer.subarray(0, length).equals(Buffer.from(expected))) fail('ENVIRONMENT_LAYOUT_UNSUPPORTED')
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
  private readonly directory: string
  private readonly limit: number

  constructor(options: Options) {
    const limit = options.maxRegistrations ?? DEFAULT_REGISTRATION_LIMIT
    if (!isAbsolute(options.directory) || options.directory.includes('\0') || !Number.isSafeInteger(limit) || limit < 1 || limit > DEFAULT_REGISTRATION_LIMIT) fail('ENVIRONMENT_OPTIONS_INVALID')
    this.directory = options.directory
    this.limit = limit
  }

  async prepare(sessionID: string, registrations: readonly Registration[], signal?: AbortSignal): Promise<ClaudeEnvironmentPlan> {
    try {
      if (process.platform === 'win32') fail('ENVIRONMENT_PLATFORM_UNSUPPORTED')
      if (!validID(sessionID)) fail('ENVIRONMENT_SESSION_INVALID')
      if (registrations.length > this.limit) fail('ENVIRONMENT_REGISTRATION_LIMIT')
      const ids = new Set<string>()
      const revisions = registrations.map(registration => {
        if (!validID(registration.id) || !validID(registration.sourceID) || ids.has(registration.id)) fail('ENVIRONMENT_REGISTRATION_INVALID')
        ids.add(registration.id)
        if (registration.dialect !== 'claude-code' || registration.event !== 'SessionStart' || registration.handler.type !== 'command' || registration.handler.args === undefined && registration.handler.shell === 'powershell') fail('ENVIRONMENT_EVENT_UNSUPPORTED')
        if (typeof registration.sourceDigest !== 'string' || !/^[a-f0-9]{64}$/.test(registration.sourceDigest)) fail('ENVIRONMENT_SOURCE_REVISION_UNAVAILABLE')
        return [registration.id, registration.sourceID, registration.sourceDigest] as const
      })
      cancelled(signal)
      const directory = join(this.directory, hash(sessionID))
      const files = revisions.map(([registrationID], index) => Object.freeze({ registrationID, path: join(directory, `sessionstart-hook-${index}.sh`) }))
      const context: Record<string, RegistrationContext> = Object.create(null) as Record<string, RegistrationContext>
      for (const file of files) context[file.registrationID] = Object.freeze({ envFile: file.path })
      const plan = Object.freeze({ files: Object.freeze(files), registrationContext: Object.freeze(context) })
      if (!files.length) return plan
      const manifest = JSON.stringify({ version: MANIFEST_VERSION, layout: hash(JSON.stringify(revisions)) }) + '\n'
      await privateDirectory(this.directory, true)
      cancelled(signal)
      await privateDirectory(directory)
      await reserveManifest(directory, manifest, signal)
      for (const file of files) await validateHookFile(file.path)
      cancelled(signal)
      return plan
    } catch (error) {
      if (error instanceof ClaudeEnvironmentError) throw error
      fail('ENVIRONMENT_STORAGE_FAILED')
    }
  }
}
