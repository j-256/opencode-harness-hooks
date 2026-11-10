import { constants } from 'node:fs'
import { lstat, mkdtemp, mkdir, open, rm, rmdir, unlink } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import type { Hash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { snapshotJsonObject } from './bounded-json.js'
import type { CodexStopPromptArtifacts } from './codex-stop-prompts.js'
import { renderCodexHookPrompt } from './codex-stop-prompts.js'
import { HostHookError } from './hosts/tools.js'
import type { JsonValue } from './types.js'

const MEBIBYTE = 1024 * 1024
const MAX_SESSION_BYTES = 32 * MEBIBYTE
const MAX_TOTAL_BYTES = 64 * MEBIBYTE
const MAX_SESSIONS = 1024
const DIRECTORIES_PER_SESSION = 4
const MAX_DIRECTORIES = MAX_SESSIONS * DIRECTORIES_PER_SESSION
const MAX_PENDING = 128
const MAX_RECORDS = 20000
const MAX_ID_BYTES = 4096
const READ_BYTES = 64 * 1024
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
type ObjectValue = Readonly<Record<string, JsonValue>>
export interface CodexRolloutHistoryRecord {
  readonly timestamp: string
  readonly type: 'response_item' | 'event_msg'
  readonly payload: ObjectValue
}
export interface CodexRolloutOptions {
  readonly temporaryParent?: string
  readonly now?: () => number
  readonly maxSessionBytes?: number
  readonly maxTotalBytes?: number
  readonly maxSessions?: number
}
interface Frame { readonly timestamp: string; readonly type: string; readonly payload: ObjectValue }
interface Projection { readonly ids: Set<string>; readonly turns: Set<string>; activeTurn: string | undefined }
interface State extends Projection {
  readonly path: string
  readonly dev: number
  readonly ino: number
  readonly stops: Map<string, string>
  hasher: Hash
  bytes: number
  records: number
  failed: boolean
  failureBytes: number
}
type FileSnapshot = Pick<State, 'dev' | 'ino' | 'bytes' | 'hasher'>
function fail(code: string): never { throw new HostHookError(code, code === 'CODEX_ROLLOUT_CANCELLED' ? 'cancelled' : code.includes('IO_FAILED') || code.includes('RECOVERY_REQUIRED') ? 'failed' : 'unsupported') }
function object(value: unknown): value is Record<string, JsonValue> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function id(value: unknown): value is string { return typeof value === 'string' && !!value && value.length <= MAX_ID_BYTES && Buffer.byteLength(value) <= MAX_ID_BYTES && !value.includes('\0') }
function iso(value: unknown): value is string { if (typeof value !== 'string') return false; try { return new Date(value).toISOString() === value } catch { return false } }
function keys(value: ObjectValue, allowed: readonly string[], code = 'CODEX_ROLLOUT_HISTORY_UNSUPPORTED') { if (Object.keys(value).some(key => !allowed.includes(key))) fail(code) }
function stopPayloads(event: ObjectValue, response: ObjectValue, model: ObjectValue) {
  const invalid = 'CODEX_ROLLOUT_INPUT_INVALID'
  keys(event, ['type', 'thread_id', 'turn_id', 'item', 'started_at_ms', 'completed_at_ms'], invalid)
  keys(response, ['type', 'id', 'role', 'content', 'internal_chat_message_metadata_passthrough'], invalid)
  keys(model, ['type', 'id', 'role', 'content'], invalid)
  const item = event.item, meta = response.internal_chat_message_metadata_passthrough
  if (!object(item) || !object(meta) || event.type !== 'item_completed' || item.type !== 'HookPrompt' || response.type !== 'message' || response.role !== 'user' || model.type !== 'message' || model.id !== response.id || model.role !== response.role || !Array.isArray(item.fragments) || !item.fragments.length || !Array.isArray(response.content) || !Array.isArray(model.content) || !Array.isArray(meta.content_item_kinds) || !Array.isArray(meta.content_item_metadata)) fail(invalid)
  keys(item, ['type', 'id', 'fragments'], invalid)
  keys(meta, ['turn_id', 'create_time', 'content_item_kinds', 'content_item_metadata'], invalid)
  const fragmentCount = item.fragments.length
  if ([response.content, model.content, meta.content_item_kinds, meta.content_item_metadata].some(values => values.length !== fragmentCount) || typeof meta.create_time !== 'number' || !Number.isFinite(meta.create_time) || meta.create_time < 0 || Number.isNaN(new Date(meta.create_time * 1000).getTime()) || typeof event.started_at_ms !== 'number' || typeof event.completed_at_ms !== 'number' || !Number.isSafeInteger(event.started_at_ms) || event.started_at_ms < 0 || !Number.isSafeInteger(event.completed_at_ms) || event.completed_at_ms < event.started_at_ms) fail(invalid)
  for (const [index, fragment] of item.fragments.entries()) {
    if (!object(fragment) || typeof fragment.text !== 'string' || !id(fragment.hookRunId)) fail(invalid)
    keys(fragment, ['text', 'hookRunId'], invalid)
    const rendered = renderCodexHookPrompt(fragment.text, fragment.hookRunId)
    for (const content of [response.content, model.content]) {
      const part = content[index]
      if (!object(part) || part.type !== 'input_text' || part.text !== rendered) fail('CODEX_ROLLOUT_IDENTITY_MISMATCH')
      keys(part, ['type', 'text'], invalid)
    }
    const provenance = meta.content_item_metadata[index]
    if (meta.content_item_kinds[index] !== 'unknown' || !object(provenance) || !object(provenance.provenance) || provenance.provenance.type !== 'harness' || provenance.provenance.hook !== true) fail(invalid)
    keys(provenance, ['provenance'], invalid)
    keys(provenance.provenance, ['type', 'hook'], invalid)
  }
}
function metadata(value: unknown): asserts value is ObjectValue {
  if (!object(value)) fail('CODEX_ROLLOUT_INPUT_INVALID')
  keys(value, ['id', 'session_id', 'timestamp', 'cwd', 'originator', 'cli_version', 'source', 'model_provider', 'base_instructions', 'history_mode', 'thread_source'])
  if (!id(value.id) || !UUID.test(value.id) || value.session_id !== value.id || !iso(value.timestamp) || !id(value.cwd) || !isAbsolute(value.cwd) || !id(value.originator) || !id(value.cli_version) || typeof value.source !== 'string' || !['unknown', 'cli', 'exec', 'mcp', 'vscode'].includes(value.source) || value.history_mode !== 'legacy' || value.thread_source !== undefined && value.thread_source !== 'user') fail('CODEX_ROLLOUT_INPUT_INVALID')
  if (value.model_provider !== undefined && value.model_provider !== null && typeof value.model_provider !== 'string') fail('CODEX_ROLLOUT_INPUT_INVALID')
  if (value.base_instructions !== undefined && value.base_instructions !== null && (!object(value.base_instructions) || Object.keys(value.base_instructions).some(key => key !== 'text') || typeof value.base_instructions.text !== 'string')) fail('CODEX_ROLLOUT_INPUT_INVALID')
}
function history(value: unknown, before: Projection): { frames: Frame[]; projection: Projection } {
  if (!Array.isArray(value) || value.length > MAX_RECORDS) fail('CODEX_ROLLOUT_INPUT_INVALID')
  const projection: Projection = { ids: new Set(before.ids), turns: new Set(before.turns), activeTurn: before.activeTurn }
  const frames: Frame[] = []
  for (const item of value) {
    if (!object(item) || !iso(item.timestamp) || !object(item.payload)) fail('CODEX_ROLLOUT_INPUT_INVALID')
    keys(item, ['timestamp', 'type', 'payload'])
    const payload = item.payload
    if (item.type === 'response_item') {
      keys(payload, ['type', 'id', 'role', 'content', 'phase'])
      if (!projection.activeTurn || payload.type !== 'message' || typeof payload.role !== 'string' || !['user', 'assistant'].includes(payload.role) || !Array.isArray(payload.content) || payload.phase !== undefined && payload.phase !== 'commentary' && payload.phase !== 'final_answer') fail('CODEX_ROLLOUT_HISTORY_UNSUPPORTED')
      if (payload.id !== undefined) {
        if (!id(payload.id) || projection.ids.has(payload.id)) fail('CODEX_ROLLOUT_IDENTITY_MISMATCH')
        projection.ids.add(payload.id)
      }
      for (const part of payload.content) if (!object(part) || Object.keys(part).some(key => !['type', 'text'].includes(key)) || part.type !== (payload.role === 'user' ? 'input_text' : 'output_text') || typeof part.text !== 'string') fail('CODEX_ROLLOUT_HISTORY_UNSUPPORTED')
    } else if (item.type === 'event_msg') {
      if (payload.type === 'task_started') {
        keys(payload, ['type', 'turn_id', 'model_context_window'])
        if (projection.activeTurn || !id(payload.turn_id) || projection.turns.has(payload.turn_id) || payload.model_context_window !== undefined && payload.model_context_window !== null && (!Number.isSafeInteger(payload.model_context_window) || Number(payload.model_context_window) < 0)) fail('CODEX_ROLLOUT_TURN_UNAVAILABLE')
        projection.activeTurn = payload.turn_id
        projection.turns.add(payload.turn_id)
      } else if (payload.type === 'task_complete') {
        keys(payload, ['type', 'turn_id', 'last_agent_message'])
        if (!projection.activeTurn || payload.turn_id !== projection.activeTurn || payload.last_agent_message !== undefined && payload.last_agent_message !== null && typeof payload.last_agent_message !== 'string') fail('CODEX_ROLLOUT_TURN_UNAVAILABLE')
        projection.activeTurn = undefined
      } else if (payload.type === 'user_message' || payload.type === 'agent_message') {
        if (!projection.activeTurn || typeof payload.message !== 'string') fail('CODEX_ROLLOUT_TURN_UNAVAILABLE')
        keys(payload, payload.type === 'user_message' ? ['type', 'message', 'images', 'local_images', 'text_elements'] : ['type', 'message', 'phase'])
        for (const field of ['images', 'local_images', 'text_elements']) if (payload[field] !== undefined && payload[field] !== null && (!Array.isArray(payload[field]) || payload[field].length)) fail('CODEX_ROLLOUT_HISTORY_UNSUPPORTED')
        if (payload.phase !== undefined && payload.phase !== 'commentary' && payload.phase !== 'final_answer') fail('CODEX_ROLLOUT_HISTORY_UNSUPPORTED')
      } else fail('CODEX_ROLLOUT_HISTORY_UNSUPPORTED')
    } else fail('CODEX_ROLLOUT_HISTORY_UNSUPPORTED')
    frames.push({ timestamp: item.timestamp, type: item.type, payload })
  }
  return { frames, projection }
}
function encode(frames: readonly Frame[], ordinal: number, limit: number): Buffer {
  const wrapped = frames.map((frame, index) => ({ timestamp: frame.timestamp, ordinal: ordinal + index, type: frame.type, payload: frame.payload }))
  const snapshot = snapshotJsonObject({ wrapped }, limit, kind => fail(kind === 'size' ? 'CODEX_ROLLOUT_LIMIT' : 'CODEX_ROLLOUT_INPUT_INVALID'))
  return Buffer.from((snapshot.value.wrapped as readonly JsonValue[]).map(row => JSON.stringify(row) + '\n').join(''))
}

export class CodexRollout {
  private readonly states = new Map<string, State>()
  private readonly serial = new Map<string, Promise<unknown>>()
  private readonly active = new Set<Promise<unknown>>()
  private readonly handles = new Set<FileHandle>()
  private readonly directories = new Map<string, { readonly dev: number; readonly ino: number }>()
  private readonly directoryWork = new Map<string, Promise<void>>()
  private readonly lifetime = new AbortController()
  private readonly sessionLimit: number
  private readonly totalLimit: number
  private readonly sessionCountLimit: number
  private readonly options: CodexRolloutOptions
  private root: Promise<string> | undefined
  private rootPath: string | undefined
  private rootOwnership: { readonly dev: number; readonly ino: number } | undefined
  private bytes = 0
  private queuedBytes = 0
  private reservedBytes = 0
  private reservedSessions = 0
  private pending = 0
  private creationFailed = false
  private uncertainCreationBytes = 0
  private disposing: Promise<void> | undefined

  constructor(options: CodexRolloutOptions = {}) {
    this.options = { ...options }
    this.sessionLimit = options.maxSessionBytes ?? MAX_SESSION_BYTES
    this.totalLimit = options.maxTotalBytes ?? MAX_TOTAL_BYTES
    this.sessionCountLimit = options.maxSessions ?? MAX_SESSIONS
    if (options.temporaryParent !== undefined && !isAbsolute(options.temporaryParent) || !Number.isSafeInteger(this.sessionLimit) || this.sessionLimit < 1 || this.sessionLimit > MAX_SESSION_BYTES || !Number.isSafeInteger(this.totalLimit) || this.totalLimit < this.sessionLimit || this.totalLimit > MAX_TOTAL_BYTES || options.now !== undefined && typeof options.now !== 'function') fail('CODEX_ROLLOUT_OPTIONS_INVALID')
    if (!Number.isSafeInteger(this.sessionCountLimit) || this.sessionCountLimit < 1 || this.sessionCountLimit > MAX_SESSIONS) fail('CODEX_ROLLOUT_OPTIONS_INVALID')
  }

  create(input: { readonly metadata: ObjectValue; readonly history: readonly CodexRolloutHistoryRecord[] }, signal?: AbortSignal): Promise<string> {
    if (this.creationFailed && !this.lifetime.signal.aborted && !signal?.aborted) return Promise.reject(new HostHookError('CODEX_ROLLOUT_RECOVERY_REQUIRED', 'failed'))
    return this.capture(input, signal, snapshot => {
      metadata(snapshot.metadata)
      const meta = snapshot.metadata
      const threadID = meta.id as string
      return this.schedule(threadID, async () => {
        this.check(signal)
        if (this.creationFailed) fail('CODEX_ROLLOUT_RECOVERY_REQUIRED')
        if (this.states.has(threadID)) fail('CODEX_ROLLOUT_SESSION_CONFLICT')
        if (this.states.size + this.reservedSessions >= this.sessionCountLimit) fail('CODEX_ROLLOUT_LIMIT')
        const projected = history(snapshot.history, { ids: new Set(), turns: new Set(), activeTurn: undefined })
        const frames: Frame[] = [{ timestamp: meta.timestamp as string, type: 'session_meta', payload: meta }, ...projected.frames]
        if (frames.length > MAX_RECORDS) fail('CODEX_ROLLOUT_LIMIT')
        const data = encode(frames, 0, this.sessionLimit)
        this.reserve(data.length)
        this.reservedSessions++
        let path: string | undefined
        let owned: { readonly dev: number; readonly ino: number } | undefined
        try {
          const root = await this.directory()
          await this.verifyRoot()
          this.check(signal)
          const folder = join(root, 'sessions', ...(meta.timestamp as string).slice(0, 10).split('-'))
          let parent = root
          for (const part of ['sessions', ...(meta.timestamp as string).slice(0, 10).split('-')]) { parent = join(parent, part); await this.folder(parent) }
          await this.verifyDirectory(folder)
          if (this.creationFailed) fail('CODEX_ROLLOUT_RECOVERY_REQUIRED')
          path = join(folder, 'rollout-' + (meta.timestamp as string).slice(0, 19).replaceAll(':', '-') + '-' + threadID + '.jsonl')
          const file = await this.file(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR)
          let closed = false
          try {
            const created = await file.stat()
            owned = { dev: created.dev, ino: created.ino }
            const pendingFile: FileSnapshot = { ...owned, bytes: data.length, hasher: createHash('sha256').update(data) }
            this.check(signal)
            await this.write(file, data, 0, signal)
            await file.sync()
            this.check(signal)
            await this.verify(file, pendingFile)
            const stat = await file.stat()
            await this.close(file); closed = true
            await this.verifyRoot()
            await this.verifyName(path, owned)
            this.check(signal)
            await this.readback(path, pendingFile)
            this.check(signal)
            this.states.set(threadID, { ...projected.projection, path, dev: stat.dev, ino: stat.ino, stops: new Map(), bytes: data.length, records: frames.length, hasher: pendingFile.hasher, failed: false, failureBytes: 0 })
            this.bytes += data.length
          } finally { if (!closed) await this.close(file) }
          return path
        } catch (error) {
          if (path && !this.states.has(threadID)) {
            let removed = false
            if (owned) try { await this.verifyRoot(); await this.verifyName(path, owned); await rm(path, { force: true }); removed = true } catch {}
            if (!removed) { this.creationFailed = true; this.uncertainCreationBytes += data.length; this.bytes += data.length }
          }
          throw error
        } finally { this.reservedBytes -= data.length; this.reservedSessions-- }
      })
    })
  }

  appendHistory(threadID: string, records: readonly CodexRolloutHistoryRecord[], signal?: AbortSignal): Promise<string> {
    return this.capture({ records }, signal, snapshot => this.schedule(threadID, async () => {
      const state = this.state(threadID), projected = history(snapshot.records, state)
      await this.append(state, projected.frames, signal)
      state.ids.clear(); projected.projection.ids.forEach(value => state.ids.add(value))
      state.turns.clear(); projected.projection.turns.forEach(value => state.turns.add(value))
      state.activeTurn = projected.projection.activeTurn
      return state.path
    }))
  }

  appendStop(threadID: string, input: CodexStopPromptArtifacts, signal?: AbortSignal): Promise<string> {
    return this.capture({ artifacts: input }, signal, snapshot => this.schedule(threadID, async () => {
      const state = this.state(threadID), artifacts = snapshot.artifacts
      if (!object(artifacts) || !object(artifacts.event) || !object(artifacts.event.item) || !object(artifacts.response) || !object(artifacts.response.internal_chat_message_metadata_passthrough)) fail('CODEX_ROLLOUT_INPUT_INVALID')
      const event = artifacts.event, response = artifacts.response, item = event.item as Record<string, JsonValue>
      const messageID = item.id
      const passthrough = response.internal_chat_message_metadata_passthrough as ObjectValue
      if (event.thread_id !== threadID || !id(event.turn_id) || !id(messageID) || response.id !== messageID || passthrough.turn_id !== event.turn_id) fail('CODEX_ROLLOUT_IDENTITY_MISMATCH')
      const fingerprint = createHash('sha256').update(JSON.stringify({ response, event, model: artifacts.model })).digest('hex')
      const previous = state.stops.get(messageID)
      if (previous) {
        if (previous !== fingerprint) fail('CODEX_ROLLOUT_STOP_CONFLICT')
        await this.verifyPath(state, signal)
        return state.path
      }
      if (state.activeTurn !== event.turn_id) fail('CODEX_ROLLOUT_TURN_UNAVAILABLE')
      if (state.ids.has(messageID)) fail('CODEX_ROLLOUT_IDENTITY_MISMATCH')
      if (!object(artifacts.model)) fail('CODEX_ROLLOUT_INPUT_INVALID')
      stopPayloads(event, response, artifacts.model)
      const time = (this.options.now ?? Date.now)()
      if (!Number.isFinite(time) || Number.isNaN(new Date(time).getTime())) fail('CODEX_ROLLOUT_INPUT_INVALID')
      const timestamp = new Date(time).toISOString()
      await this.append(state, [{ timestamp, type: 'response_item', payload: response }, { timestamp, type: 'event_msg', payload: event }], signal)
      state.stops.set(messageID, fingerprint)
      state.ids.add(messageID)
      return state.path
    }))
  }

  dispose(): Promise<void> {
    this.disposing ??= (async () => {
      this.lifetime.abort()
      await Promise.allSettled([...this.active])
      for (const file of this.handles) await this.close(file)
      if (this.root) await this.root.catch(() => {})
      if (this.rootPath) {
        await this.verifyRoot()
        for (const directory of this.directories.keys()) await this.verifyDirectory(directory)
        for (const state of this.states.values()) await this.verifyName(state.path, state)
        for (const [threadID, state] of this.states) { await this.verifyName(state.path, state); await unlink(state.path); this.states.delete(threadID); this.bytes -= state.bytes + state.failureBytes }
        const directories = [...this.directories.keys()].sort((left, right) => right.length - left.length)
        for (const directory of directories) { await this.verifyDirectory(directory); await rmdir(directory); this.directories.delete(directory) }
        await this.verifyRoot(); await rmdir(this.rootPath)
        this.rootPath = undefined; this.rootOwnership = undefined
        this.bytes = 0; this.uncertainCreationBytes = 0
      }
    })().catch(error => {
      if (error instanceof HostHookError) throw error
      if (error && typeof error === 'object' && 'code' in error && ['ENOTEMPTY', 'EEXIST'].includes(String(error.code))) fail('CODEX_ROLLOUT_RECOVERY_REQUIRED')
      fail('CODEX_ROLLOUT_IO_FAILED')
    }).finally(() => { this.disposing = undefined })
    return this.disposing
  }

  inspect() { return Object.freeze({ sessions: this.states.size, failedSessions: [...this.states.values()].filter(state => state.failed).length, bytes: this.bytes, uncertainBytes: this.uncertainCreationBytes + [...this.states.values()].reduce((total, state) => total + state.failureBytes, 0), queuedBytes: this.queuedBytes, reservedBytes: this.reservedBytes, pending: this.pending, created: this.rootPath !== undefined, disposed: this.lifetime.signal.aborted }) }

  private capture<T>(input: unknown, signal: AbortSignal | undefined, operation: (value: ObjectValue) => Promise<T>): Promise<T> {
    let held = 0
    try {
      this.check(signal)
      if (this.pending >= MAX_PENDING) fail('CODEX_ROLLOUT_LIMIT')
      const snapshot = snapshotJsonObject(input, Math.min(this.sessionLimit, this.totalLimit - this.bytes - this.queuedBytes - this.reservedBytes), kind => fail(kind === 'size' ? 'CODEX_ROLLOUT_LIMIT' : 'CODEX_ROLLOUT_INPUT_INVALID'))
      held = snapshot.bytes
      this.queuedBytes += held; this.pending++
      const result = Promise.resolve().then(() => operation(snapshot.value)).catch(error => { if (error instanceof HostHookError) throw error; fail('CODEX_ROLLOUT_IO_FAILED') }).finally(() => { this.queuedBytes -= held; this.pending--; this.active.delete(result) })
      this.active.add(result)
      return result
    } catch (error) { return Promise.reject(error) }
  }
  private schedule<T>(threadID: string, operation: () => Promise<T>): Promise<T> {
    if (!id(threadID) || !UUID.test(threadID)) return Promise.reject(new HostHookError('CODEX_ROLLOUT_IDENTITY_MISMATCH', 'unsupported'))
    const before = this.serial.get(threadID)
    const result = (before ?? Promise.resolve()).catch(() => {}).then(operation)
    this.serial.set(threadID, result)
    void result.finally(() => { if (this.serial.get(threadID) === result) this.serial.delete(threadID) }).catch(() => {})
    return result
  }
  private state(threadID: string): State { const state = this.states.get(threadID); if (!state) return fail('CODEX_ROLLOUT_SESSION_UNAVAILABLE'); if (state.failed) return fail('CODEX_ROLLOUT_RECOVERY_REQUIRED'); return state }
  private check(signal?: AbortSignal) { if (signal?.aborted || this.lifetime.signal.aborted) fail('CODEX_ROLLOUT_CANCELLED') }
  private directory(): Promise<string> {
    this.root ??= mkdtemp(join(this.options.temporaryParent ?? tmpdir(), 'harness-codex-rollout-')).then(async path => {
      this.rootPath = path
      const stat = await lstat(path)
      if (!stat.isDirectory()) fail('CODEX_ROLLOUT_ROOT_CHANGED')
      this.rootOwnership = { dev: stat.dev, ino: stat.ino }
      return path
    })
    return this.root
  }
  private reserve(bytes: number) { if (this.bytes + this.reservedBytes + bytes > this.totalLimit) fail('CODEX_ROLLOUT_LIMIT'); this.reservedBytes += bytes }
  private async file(path: string, flags: number): Promise<FileHandle> { const file = await open(path, flags | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600); this.handles.add(file); return file }
  private async close(file: FileHandle): Promise<void> { await file.close(); this.handles.delete(file) }
  private async write(file: FileHandle, data: Buffer, offset: number, signal?: AbortSignal): Promise<void> {
    let written = 0
    while (written < data.length) { this.check(signal); const result = await file.write(data, written, data.length - written, offset + written); if (!result.bytesWritten) fail('CODEX_ROLLOUT_IO_FAILED'); written += result.bytesWritten }
  }
  private async verify(file: FileHandle, state: FileSnapshot, bytes = state.bytes, digest = state.hasher.copy().digest('hex')) {
    const stat = await file.stat()
    if (!stat.isFile() || stat.dev !== state.dev || stat.ino !== state.ino || stat.size !== bytes) fail('CODEX_ROLLOUT_FILE_CHANGED')
    const hash = createHash('sha256'), buffer = Buffer.alloc(READ_BYTES)
    let read = 0
    while (read < bytes) { const result = await file.read(buffer, 0, Math.min(buffer.length, bytes - read), read); if (!result.bytesRead) fail('CODEX_ROLLOUT_FILE_CHANGED'); hash.update(buffer.subarray(0, result.bytesRead)); read += result.bytesRead }
    if (hash.digest('hex') !== digest) fail('CODEX_ROLLOUT_FILE_CHANGED')
  }
  private async verifyPath(state: State, signal?: AbortSignal) {
    this.check(signal)
    await this.readback(state.path, state)
    this.check(signal)
  }
  private async readback(path: string, state: FileSnapshot) {
    await this.verifyDirectory(dirname(path))
    const file = await this.file(path, constants.O_RDONLY)
    try { await this.verify(file, state) } finally { await file.close(); this.handles.delete(file) }
    await this.verifyRoot()
    await this.verifyName(path, state)
  }
  private async verifyName(path: string, owned: { readonly dev: number; readonly ino: number }) {
    await this.verifyDirectory(dirname(path))
    let stat
    try { stat = await lstat(path) } catch { return fail('CODEX_ROLLOUT_FILE_CHANGED') }
    if (!stat.isFile() || stat.dev !== owned.dev || stat.ino !== owned.ino) fail('CODEX_ROLLOUT_FILE_CHANGED')
  }
  private async verifyRoot() {
    if (!this.rootPath || !this.rootOwnership) fail('CODEX_ROLLOUT_ROOT_CHANGED')
    let stat
    try { stat = await lstat(this.rootPath) } catch { return fail('CODEX_ROLLOUT_ROOT_CHANGED') }
    if (!stat.isDirectory() || stat.dev !== this.rootOwnership.dev || stat.ino !== this.rootOwnership.ino) fail('CODEX_ROLLOUT_ROOT_CHANGED')
  }
  private async verifyDirectory(path: string): Promise<void> {
    if (path === this.rootPath) return this.verifyRoot()
    const owned = this.directories.get(path)
    if (!owned) return fail('CODEX_ROLLOUT_DIRECTORY_CHANGED')
    await this.verifyDirectory(dirname(path))
    let stat
    try { stat = await lstat(path) } catch { return fail('CODEX_ROLLOUT_DIRECTORY_CHANGED') }
    if (!stat.isDirectory() || stat.dev !== owned.dev || stat.ino !== owned.ino) fail('CODEX_ROLLOUT_DIRECTORY_CHANGED')
  }
  private async folder(path: string): Promise<void> {
    if (this.creationFailed) fail('CODEX_ROLLOUT_RECOVERY_REQUIRED')
    let pending = this.directoryWork.get(path)
    if (!pending) {
      if (!this.directories.has(path) && this.directories.size + this.directoryWork.size >= MAX_DIRECTORIES) fail('CODEX_ROLLOUT_LIMIT')
      pending = (async () => {
        if (this.directories.has(path)) return this.verifyDirectory(path)
        await this.verifyDirectory(dirname(path))
        try {
          if (this.creationFailed) fail('CODEX_ROLLOUT_RECOVERY_REQUIRED')
          try { await mkdir(path, { mode: 0o700 }) } catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') fail('CODEX_ROLLOUT_DIRECTORY_CHANGED'); throw error }
          const stat = await lstat(path)
          if (!stat.isDirectory()) fail('CODEX_ROLLOUT_DIRECTORY_CHANGED')
          this.directories.set(path, { dev: stat.dev, ino: stat.ino })
          await this.verifyDirectory(path)
        } catch (error) { this.creationFailed = true; throw error }
      })()
      this.directoryWork.set(path, pending)
      void pending.finally(() => { if (this.directoryWork.get(path) === pending) this.directoryWork.delete(path) }).catch(() => {})
    }
    await pending
    await this.verifyDirectory(path)
  }
  private async append(state: State, frames: readonly Frame[], signal?: AbortSignal) {
    this.check(signal)
    if (state.records + frames.length > MAX_RECORDS) fail('CODEX_ROLLOUT_LIMIT')
    const data = encode(frames, state.records, this.sessionLimit - state.bytes)
    if (state.bytes + data.length > this.sessionLimit) fail('CODEX_ROLLOUT_LIMIT')
    this.reserve(data.length)
    let file: FileHandle | undefined
    let written = 0
    let verified = false
    let retained = false
    const poison = () => { if (!retained) { state.failed = true; state.failureBytes += data.length; this.bytes += data.length; retained = true } }
    try {
      await this.verifyRoot()
      await this.verifyDirectory(dirname(state.path))
      file = await this.file(state.path, constants.O_RDWR)
      await this.verify(file, state)
      verified = true
      while (written < data.length) {
        this.check(signal)
        const result = await file.write(data, written, data.length - written, state.bytes + written)
        if (!result.bytesWritten) fail('CODEX_ROLLOUT_IO_FAILED')
        written += result.bytesWritten
      }
      await file.sync()
      this.check(signal)
      const next = state.hasher.copy().update(data)
      await this.verify(file, state, state.bytes + data.length, next.copy().digest('hex'))
      this.check(signal)
      await this.verifyName(state.path, state)
      await this.close(file); file = undefined
      await this.verifyRoot()
      await this.verifyName(state.path, state)
      this.check(signal)
      await this.readback(state.path, { dev: state.dev, ino: state.ino, bytes: state.bytes + data.length, hasher: next })
      this.check(signal)
      state.hasher = next; state.bytes += data.length; state.records += frames.length; this.bytes += data.length
    } catch (error) {
      if (verified) {
        try {
          file ??= await this.file(state.path, constants.O_RDWR)
          await this.verifyRoot()
          await this.verifyName(state.path, state)
          await this.verify(file, state, state.bytes + written, state.hasher.copy().update(data.subarray(0, written)).digest('hex'))
          if (written) { await file.truncate(state.bytes); await file.sync() }
          await this.verify(file, state)
          await this.verifyName(state.path, state)
          await this.close(file); file = undefined
          await this.readback(state.path, state)
        } catch { poison(); fail('CODEX_ROLLOUT_RECOVERY_REQUIRED') }
      }
      throw error
    } finally {
      this.reservedBytes -= data.length
      if (file) try { await this.close(file) } catch { poison(); fail('CODEX_ROLLOUT_RECOVERY_REQUIRED') }
    }
  }
}
