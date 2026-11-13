import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { CONTRACT_VERSIONS, HOST_VERSIONS } from './contracts.js'
import type { HostVersion } from './contracts.js'
import { HostHookError } from './host-errors.js'
import { snapshotJsonObject } from './bounded-json.js'
import type { JsonValue } from './types.js'

const FORMAT = 1
const MAX_PAYLOAD_BYTES = 32 * 1024 * 1024
const MAX_RETAINED_BYTES = 256 * 1024 * 1024
const MAX_SESSIONS = 1024
const MAX_PENDING = 128
const MAX_ID_BYTES = 4096
const MAX_DEPTH = 128
const BUSY_MS = 1000
const MAX_DATABASE_BYTES = 512 * 1024 * 1024
const JOURNAL_BYTES = 4 * 1024 * 1024
const FILE = 'native-sessions.sqlite'
const SIDECARS = ['', '-wal', '-shm', '-journal']
const SQL_BUSY = new Set([5, 6])
const SQL_FULL = 13
const SQL_INVALID = new Set([11, 26])
const SQL_SCHEMA = `CREATE TABLE scope (id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL, generation INTEGER NOT NULL, purge_generation INTEGER NOT NULL);
CREATE TABLE sessions (session_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, deleted INTEGER NOT NULL CHECK(deleted IN (0,1)), payload TEXT, checksum TEXT NOT NULL, bytes INTEGER NOT NULL CHECK(bytes>=0));`
interface Statement { get(...values: (string | number | null)[]): Record<string, unknown> | undefined; run(...values: (string | number | null)[]): unknown }
interface Database { exec(sql: string): void; prepare(sql: string): Statement; close(): void }
type DatabaseConstructor = new (path: string, options?: { readonly strict: true }) => Database
type Phase = 'load' | 'save' | 'delete'
export interface SessionStoreDiagnostic { readonly host: HostVersion; readonly phase: Phase; readonly operationID: string; readonly sessionID?: string; readonly code: string; readonly outcome: HostHookError['outcome']; readonly durationMs: number }
interface Options { readonly directory: string; readonly project: string; readonly host: HostVersion; readonly maxPayloadBytes?: number; readonly maxRetainedBytes?: number; readonly maxSessions?: number; readonly diagnostic?: (value: SessionStoreDiagnostic) => void | Promise<void> }
export interface StoredSession {
  readonly sessionID: string
  readonly exists: boolean
  readonly deleted: boolean
  readonly revision: number
  readonly generation: number
  readonly purgeGeneration: number
  readonly payload: Readonly<Record<string, JsonValue>> | null
}
function fail(code: string): never { throw new HostHookError(code, code === 'SESSION_STORE_CANCELLED' ? 'cancelled' : 'unsupported') }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function errno(error: unknown, code: string): boolean { return record(error) && error.code === code }
function cancelled(signal?: AbortSignal): void { if (signal?.aborted) fail('SESSION_STORE_CANCELLED') }
function hash(value: string): string { return createHash('sha256').update(value).digest('hex') }
function integer(value: unknown): number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) fail('SESSION_STORE_SCHEMA_INVALID'); return value }
function freeze<T>(value: T, depth = 0): T {
  if (depth > MAX_DEPTH) fail('SESSION_STORE_INPUT_INVALID')
  if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item, depth + 1); Object.freeze(value) }
  return value
}
function text(value: unknown, limit: number): string { return snapshotJsonObject(value, limit, kind => fail(kind === 'size' ? 'SESSION_STORE_LIMIT' : 'SESSION_STORE_INPUT_INVALID')).text }

function normalize(error: unknown): HostHookError {
  if (error instanceof HostHookError) return error
  if (record(error) && (SQL_BUSY.has(Number(error.errcode) & 0xff) || ['SQLITE_BUSY', 'SQLITE_LOCKED'].includes(String(error.code)))) return new HostHookError('SESSION_STORE_BUSY', 'failed')
  if (record(error) && (Number(error.errcode) === SQL_FULL || error.code === 'SQLITE_FULL')) return new HostHookError('SESSION_STORE_LIMIT', 'unsupported')
  if (record(error) && (SQL_INVALID.has(Number(error.errcode) & 0xff) || ['SQLITE_CORRUPT', 'SQLITE_NOTADB'].includes(String(error.code)))) return new HostHookError('SESSION_STORE_SCHEMA_INVALID', 'unsupported')
  return new HostHookError('SESSION_STORE_STORAGE_FAILED', 'failed')
}

async function database(path: string): Promise<Database> {
  let Constructor: DatabaseConstructor
  try {
    const module = process.versions.bun ? 'bun:sqlite' : 'node:sqlite'
    const sqlite = await import(module) as Record<string, unknown>
    const candidate = process.versions.bun ? sqlite.Database : sqlite.DatabaseSync
    if (typeof candidate !== 'function') return fail('SESSION_STORE_RUNTIME_UNAVAILABLE')
    Constructor = candidate as DatabaseConstructor
  } catch { return fail('SESSION_STORE_RUNTIME_UNAVAILABLE') }
  return process.versions.bun ? new Constructor(path, { strict: true }) : new Constructor(path)
}

export class SessionStore {
  private readonly maximum: number
  private readonly retained: number
  private readonly sessions: number
  private readonly receipts = new WeakSet<object>()
  private readonly active = new Set<Promise<unknown>>()
  private opening?: Promise<Database>
  private disposing?: Promise<void>
  private identity?: { readonly dev: number; readonly ino: number }
  private directoryIdentity?: { readonly dev: number; readonly ino: number }
  private observerFailures = 0
  private opened = false
  private closed = false

  constructor(private readonly options: Options) {
    this.options = { ...options }
    options = this.options
    this.maximum = options.maxPayloadBytes ?? MAX_PAYLOAD_BYTES
    this.retained = options.maxRetainedBytes ?? MAX_RETAINED_BYTES
    this.sessions = options.maxSessions ?? MAX_SESSIONS
    if (!isAbsolute(options.directory) || !isAbsolute(options.project) || options.directory.includes('\0') || options.project.includes('\0') || !Object.hasOwn(HOST_VERSIONS, options.host) || options.diagnostic !== undefined && typeof options.diagnostic !== 'function' || !Number.isSafeInteger(this.maximum) || this.maximum < 1 || this.maximum > MAX_PAYLOAD_BYTES || !Number.isSafeInteger(this.retained) || this.retained < this.maximum || this.retained > MAX_RETAINED_BYTES || !Number.isSafeInteger(this.sessions) || this.sessions < 1 || this.sessions > MAX_SESSIONS) fail('SESSION_STORE_OPTIONS_INVALID')
  }

  load(sessionID: string, signal?: AbortSignal): Promise<StoredSession> {
    return this.operation('load', async db => this.transaction(db, () => this.read(db, sessionID)), sessionID, signal)
  }

  save(previous: StoredSession, payload: Readonly<Record<string, JsonValue>>, signal?: AbortSignal): Promise<StoredSession> {
    if (!record(previous) || !this.receipts.has(previous)) return this.rejected('save', new HostHookError('SESSION_STORE_RECEIPT_INVALID', 'unsupported'))
    let input: string
    try { input = text(payload, this.maximum) } catch (error) { return this.rejected('save', error, previous.sessionID) }
    return this.write(previous, input, false, signal)
  }

  delete(previous: StoredSession, signal?: AbortSignal): Promise<StoredSession> { return this.write(previous, null, true, signal) }

  dispose(): Promise<void> {
    this.closed = true
    return this.disposing ??= (async () => {
      await Promise.allSettled([...this.active])
      if (this.opening) { const db = await this.opening.catch(() => undefined); if (db) db.close() }
      this.opened = false
    })()
  }

  private write(previous: StoredSession, payload: string | null, deleted: boolean, signal?: AbortSignal): Promise<StoredSession> {
    const phase = deleted ? 'delete' : 'save'
    if (!record(previous) || !this.receipts.has(previous)) return this.rejected(phase, new HostHookError('SESSION_STORE_RECEIPT_INVALID', 'unsupported'))
    return this.operation(phase, async db => this.transaction(db, () => {
      const current = this.read(db, previous.sessionID)
      if (current.exists !== previous.exists || current.revision !== previous.revision || !current.exists && current.purgeGeneration !== previous.purgeGeneration) fail('SESSION_STORE_CONFLICT')
      if (current.deleted) { if (deleted) return current; fail('SESSION_STORE_DELETED') }
      const bytes = payload === null ? 0 : Buffer.byteLength(payload)
      const usage = db.prepare('SELECT COUNT(*) AS sessions, COALESCE(SUM(bytes),0) AS bytes FROM sessions WHERE deleted=0 AND session_id<>?').get(previous.sessionID)!
      if (!deleted && (integer(usage.sessions) >= this.sessions || integer(usage.bytes) + bytes > this.retained)) fail('SESSION_STORE_LIMIT')
      const generation = current.generation + 1
      if (!Number.isSafeInteger(generation)) fail('SESSION_STORE_LIMIT')
      db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET revision=excluded.revision,deleted=excluded.deleted,payload=excluded.payload,checksum=excluded.checksum,bytes=excluded.bytes').run(previous.sessionID, generation, Number(deleted), payload, hash(payload ?? ''), bytes)
      db.prepare('UPDATE scope SET generation=? WHERE id=1').run(generation)
      const tombstones = integer(db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE deleted=1').get()?.count)
      if (tombstones > this.sessions) {
        db.prepare('DELETE FROM sessions WHERE session_id IN (SELECT session_id FROM sessions WHERE deleted=1 ORDER BY revision DESC LIMIT -1 OFFSET ?)').run(this.sessions)
        db.prepare('UPDATE scope SET purge_generation=? WHERE id=1').run(generation)
      }
      cancelled(signal)
      return this.read(db, previous.sessionID)
    }), previous.sessionID, signal)
  }

  private read(db: Database, sessionID: string): StoredSession {
    const scope = db.prepare('SELECT generation,purge_generation FROM scope WHERE id=1').get()!
    const generation = integer(scope.generation), purgeGeneration = integer(scope.purge_generation)
    if (purgeGeneration > generation) fail('SESSION_STORE_SCHEMA_INVALID')
    const row = db.prepare('SELECT revision,deleted,bytes,length(CAST(payload AS BLOB)) AS actualBytes FROM sessions WHERE session_id=?').get(sessionID)
    if (!row) return this.receipt({ sessionID, exists: false, deleted: false, revision: 0, generation, purgeGeneration, payload: null })
    const revision = integer(row.revision), bytes = integer(row.bytes)
    if (!revision || revision > generation || ![0, 1].includes(Number(row.deleted)) || bytes > this.maximum || row.deleted === 1 && bytes !== 0 || row.deleted === 0 && integer(row.actualBytes) !== bytes) fail('SESSION_STORE_SCHEMA_INVALID')
    const content = db.prepare('SELECT payload,checksum FROM sessions WHERE session_id=?').get(sessionID)!
    if (row.deleted === 1 ? content.payload !== null || content.checksum !== hash('') : typeof content.payload !== 'string' || content.checksum !== hash(content.payload)) fail('SESSION_STORE_CHECKSUM_INVALID')
    let payload: Record<string, JsonValue> | null = null
    if (row.deleted === 0) {
      try { const value: unknown = JSON.parse(content.payload as string); if (!record(value)) fail('SESSION_STORE_SCHEMA_INVALID'); payload = freeze(value as Record<string, JsonValue>) } catch (error) { if (error instanceof HostHookError) throw error; fail('SESSION_STORE_SCHEMA_INVALID') }
    }
    return this.receipt({ sessionID, exists: true, deleted: row.deleted === 1, revision, generation, purgeGeneration, payload })
  }

  private receipt(value: StoredSession): StoredSession { const receipt = Object.freeze(value); this.receipts.add(receipt); return receipt }
  private transaction<T>(db: Database, operation: () => T): T {
    db.exec('BEGIN IMMEDIATE')
    try { const result = operation(); db.exec('COMMIT'); return result } catch (error) { try { db.exec('ROLLBACK') } catch {} throw error }
  }

  inspect() { return Object.freeze({ opened: this.opened, closed: this.closed, pending: this.active.size, observerFailures: this.observerFailures }) }

  private rejected<T>(phase: Phase, error: unknown, sessionID?: string): Promise<T> { const failure = normalize(error); this.emit(phase, failure, performance.now(), sessionID); return Promise.reject(failure) }

  private emit(phase: Phase, failure: HostHookError, started: number, sessionID?: string): void {
    const value = Object.freeze({ host: this.options.host, phase, operationID: randomUUID(), ...(sessionID ? { sessionID } : {}), code: failure.code, outcome: failure.outcome, durationMs: Math.round(performance.now() - started) })
    try {
      const observed = (this.options.diagnostic ?? (value => { console.error(JSON.stringify({ component: 'opencode-harness-hooks', artifact: 'native-session-state', ...value })) }))(value)
      if (observed) void Promise.resolve(observed).catch(() => { this.observerFailures++ })
    } catch { this.observerFailures++ }
  }

  private operation<T>(phase: Phase, operation: (db: Database) => Promise<T>, sessionID: string, signal?: AbortSignal): Promise<T> {
    if (this.closed) return this.rejected(phase, new HostHookError('SESSION_STORE_CLOSED', 'cancelled'), sessionID)
    if (typeof sessionID !== 'string' || !sessionID || sessionID.includes('\0') || Buffer.byteLength(sessionID) > MAX_ID_BYTES) return this.rejected(phase, new HostHookError('SESSION_STORE_SESSION_INVALID', 'unsupported'))
    if (this.active.size >= MAX_PENDING) return this.rejected(phase, new HostHookError('SESSION_STORE_LIMIT', 'unsupported'), sessionID)
    const started = performance.now()
    const pending = (async () => {
      cancelled(signal)
      const db = await (this.opening ??= this.initialize())
      await this.files()
      cancelled(signal)
      return operation(db)
    })().catch((error: unknown) => { const failure = normalize(error); this.emit(phase, failure, started, sessionID); throw failure })
    this.active.add(pending)
    void pending.finally(() => this.active.delete(pending)).catch(() => {})
    return pending
  }

  private async files(): Promise<void> {
    const directory = await lstat(this.options.directory)
    if (!directory.isDirectory() || process.getuid && directory.uid !== process.getuid() || (directory.mode & 0o077) !== 0 || this.directoryIdentity && (this.directoryIdentity.dev !== directory.dev || this.directoryIdentity.ino !== directory.ino)) fail('SESSION_STORE_FILE_UNSAFE')
    for (const suffix of SIDECARS) {
      const info = await lstat(join(this.options.directory, FILE + suffix)).catch(error => { if (errno(error, 'ENOENT')) return undefined; throw error })
      if (info && (!info.isFile() || info.nlink !== 1 || process.getuid && info.uid !== process.getuid() || (info.mode & 0o077) !== 0)) fail('SESSION_STORE_FILE_UNSAFE')
      if (info && info.size > MAX_DATABASE_BYTES) fail('SESSION_STORE_LIMIT')
      if (!suffix && this.identity && (!info || info.dev !== this.identity.dev || info.ino !== this.identity.ino)) fail('SESSION_STORE_FILE_UNSAFE')
    }
  }

  private async initialize(): Promise<Database> {
    await mkdir(this.options.directory, { recursive: true, mode: 0o700 })
    const directory = await lstat(this.options.directory)
    if (!directory.isDirectory() || process.getuid && directory.uid !== process.getuid() || (directory.mode & 0o077) !== 0) fail('SESSION_STORE_FILE_UNSAFE')
    this.directoryIdentity = { dev: directory.dev, ino: directory.ino }
    await this.files()
    const path = join(this.options.directory, FILE), project = await realpath(this.options.project)
    const handle = await open(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600)
    let db: Database | undefined
    try {
      const before = await handle.stat()
      if (!before.isFile() || before.nlink !== 1 || process.getuid && before.uid !== process.getuid() || (before.mode & 0o077) !== 0) fail('SESSION_STORE_FILE_UNSAFE')
      db = await database(path)
      const after = await lstat(path)
      if (before.dev !== after.dev || before.ino !== after.ino) fail('SESSION_STORE_FILE_UNSAFE')
      this.identity = { dev: before.dev, ino: before.ino }
      db.exec('PRAGMA busy_timeout=' + BUSY_MS)
      const owner = hash(JSON.stringify([project, this.options.host, HOST_VERSIONS[this.options.host], CONTRACT_VERSIONS]))
      this.transaction(db, () => {
        const version = integer(db!.prepare('PRAGMA user_version').get()?.user_version)
        if (version === 0) {
          if (integer(db!.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table'").get()?.count) !== 0) fail('SESSION_STORE_SCHEMA_INVALID')
          db!.exec(SQL_SCHEMA)
          db!.prepare('INSERT INTO scope VALUES (1,?,0,0)').run(owner)
          db!.exec('PRAGMA user_version=' + FORMAT)
        } else if (version !== FORMAT) fail('SESSION_STORE_SCHEMA_INVALID')
        if (db!.prepare('SELECT owner FROM scope WHERE id=1').get()?.owner !== owner) fail('SESSION_STORE_OWNER_MISMATCH')
      })
      const pageSize = integer(db.prepare('PRAGMA page_size').get()?.page_size)
      if (!pageSize) fail('SESSION_STORE_SCHEMA_INVALID')
      db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA max_page_count=' + Math.floor(MAX_DATABASE_BYTES / pageSize) + '; PRAGMA wal_autocheckpoint=256; PRAGMA journal_size_limit=' + JOURNAL_BYTES)
      await this.files()
      this.opened = true
      return db
    } catch (error) { if (db) db.close(); throw error } finally { await handle.close() }
  }
}
