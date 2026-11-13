import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'
import { HostHookError } from '../host-errors.js'
import { runService } from '../service-execution.js'
import type { createRuntime, RuntimeServices } from '../runtime.js'
import type { SessionStartEvent, SessionStartServices } from '../session-start.js'
import type { StartupBatch } from '../startup-records.js'
import type { SessionSnapshot } from '../sessions.js'
import type { TranscriptService } from '../transcript.js'
import type { CodexTranscriptService } from '../codex-transcript.js'
import type { PromptContexts } from '../prompt-contexts.js'
import type { V1Input } from './plugin-v1.js'
import { V1ShellReplay } from './shell-replay.js'

const METADATA_MS = 5000
const MAX_SESSIONS = 1024
interface State { readonly activationID: string; readonly pending: Promise<unknown>; event?: SessionStartEvent; batch?: StartupBatch; bound?: string }
type Runtime = Awaited<ReturnType<typeof createRuntime>>
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function fail(code: string): never { throw new HostHookError(code, 'unsupported') }
function rollback(operations: readonly (() => void)[]): void {
  let failed = false
  for (const operation of [...operations].reverse()) { try { operation() } catch { failed = true } }
  if (failed) fail('HOST_STARTUP_ROLLBACK_FAILED')
}

export class V1Startups {
  readonly service: SessionStartServices
  private runtime?: Runtime
  private readonly states = new Map<string, State>()
  private readonly created = new Set<string>()
  private createdOverflow = false
  private readonly shell = new V1ShellReplay()
  private readonly wrappers = new Map<string, string>()
  private readonly originalShells = new Map<{ shell?: string }, string | undefined>()
  private readonly environment: Readonly<NodeJS.ProcessEnv>
  private config?: { shell?: string }
  private wrapper?: string
  private defaultModel?: string

  constructor(private readonly input: V1Input, private readonly transcripts: TranscriptService, private readonly codex: CodexTranscriptService, private readonly services: RuntimeServices) {
    this.environment = { ...(services.host?.environment ?? process.env) }
    const state = this.environment.XDG_STATE_HOME ?? join(this.environment.HOME ?? homedir(), '.local', 'state')
    this.service = services.sessionStart ?? { environmentDirectory: join(state, 'opencode-harness-hooks', createHash('sha256').update(input.directory).digest('hex'), 'claude-environment'), admit: async delivery => {
      if (!this.transcripts.admitStart || !this.transcripts.revokeStart) fail('HOST_STARTUP_ARTIFACT_UNAVAILABLE')
      const current = this.states.get(delivery.event.sessionID)
      if (!current || current.activationID !== delivery.event.activationID) fail('HOST_STARTUP_OWNER_MISMATCH')
      const undo: (() => void)[] = []
      try {
        if (this.has('codex') && (!this.codex.rememberStart || !this.codex.revokeStart)) fail('HOST_STARTUP_ARTIFACT_UNAVAILABLE')
        const batch = this.transcripts.admitStart(delivery)
        undo.push(() => this.transcripts.revokeStart!(delivery.session, delivery.event.activationID))
        if (this.has('codex')) {
          this.codex.rememberStart!(delivery.session, delivery.event.activationID, batch.model.codex)
          undo.push(() => this.codex.revokeStart!(delivery.session, delivery.event.activationID))
        }
        if (delivery.environment) this.shell.admit(delivery.session, delivery.event.activationID, delivery.environment)
        current.batch = batch
      } catch (error) {
        rollback(undo)
        throw error
      }
    } }
  }

  attach(runtime: Runtime): void { this.runtime = runtime }
  private get active(): Runtime { if (!this.runtime) fail('HOST_STARTUP_UNAVAILABLE'); return this.runtime }
  private has(dialect: string): boolean { return this.active.report.sources.some(source => source.enabled && source.dialect === dialect && source.events.includes('SessionStart')) }

  event(type: string, properties: unknown): void {
    if (!this.active.hasStartHooks || !record(properties)) return
    const info = record(properties.info) ? properties.info : undefined
    const id = typeof properties.sessionID === 'string' ? properties.sessionID : typeof info?.id === 'string' ? info.id : undefined
    if (!id || info?.id !== undefined && info.id !== id) return
    if (type === 'session.created') {
      if (this.created.size >= MAX_SESSIONS && !this.created.has(id)) { this.createdOverflow = true; return }
      this.created.add(id)
    }
    if (type === 'session.deleted') { this.created.delete(id); this.states.delete(id) }
  }

  async configure(config: { shell?: string; model?: string }): Promise<void> {
    if (config.model?.includes('/')) this.defaultModel = config.model.slice(config.model.indexOf('/') + 1)
    if (!this.active.hasStartHooks || this.services.sessionStart || !this.has('claude-code')) return
    let program = config.shell ?? process.env.SHELL
    if (config.shell && this.wrappers.has(config.shell)) {
      if (!this.originalShells.has(config)) this.originalShells.set(config, this.wrappers.get(config.shell))
      this.wrapper = config.shell; this.config = config
      return
    }
    this.originalShells.set(config, config.shell)
    const executable = async (path: string) => { try { await access(path, constants.X_OK); return true } catch { return false } }
    if (program && !isAbsolute(program)) {
      let found: string | undefined
      for (const entry of (process.env.PATH ?? '').split(delimiter)) { const path = join(entry, program); if (await executable(path)) { found = path; break } }
      program = found
    }
    if (!program || !await executable(program)) {
      program = process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash'
      if (!await executable(program)) program = '/bin/sh'
    }
    this.wrapper = await this.shell.configure(program)
    this.wrappers.set(this.wrapper, program)
    config.shell = this.wrapper
    this.config = config
  }

  async begin(sessionID: string): Promise<void> {
    if (!this.active.hasStartHooks || !this.created.has(sessionID) || !this.defaultModel) return
    this.active.sessions.model(sessionID, this.defaultModel)
    const session = this.active.sessions.get(sessionID)
    await this.ensure(session, session.signal)
  }

  async ensure(session: SessionSnapshot, waiter: AbortSignal = session.turnSignal): Promise<void> {
    if (!this.active.hasStartHooks) return
    if (this.createdOverflow) fail('HOST_STARTUP_LIMIT')
    let current = this.states.get(session.sessionID)
    if (!current) {
      if (this.states.size >= MAX_SESSIONS) fail('HOST_STARTUP_LIMIT')
      const activationID = randomUUID()
      const pending = (async () => {
        if (!this.input.client) fail('HOST_STARTUP_METADATA_UNAVAILABLE')
        const info = await runService(METADATA_MS, session.signal, signal => this.input.client!.session.get({ path: { id: session.sessionID }, signal }))
        if (info.error || !record(info.data) || info.data.id !== session.sessionID) fail('HOST_STARTUP_METADATA_UNAVAILABLE')
        const source = this.created.has(session.sessionID) ? 'startup' : 'resume'
        let event: SessionStartEvent = { host: 'v1', event: 'SessionStart', sessionID: session.sessionID, activationID, cwd: this.input.directory, data: { source, transcript_path: null, ...(session.model ? { model: session.model } : {}) } }
        if (this.has('claude-code')) {
          const path = await this.transcripts.prepare(event, session, session.signal)
          event = { ...event, dialectData: { ...event.dialectData, 'claude-code': { transcript_path: path } } }
        }
        if (this.has('codex')) {
          if (!this.codex.prepareStart) fail('HOST_STARTUP_ARTIFACT_UNAVAILABLE')
          const view = await this.codex.prepareStart(event, session, session.signal)
          event = { ...event, dialectData: { ...event.dialectData, codex: { transcript_path: view.transcriptPath } }, nativeSessionIDs: { codex: view.sessionID } }
        }
        const state = this.states.get(session.sessionID)
        if (!state || state.activationID !== activationID) fail('HOST_STARTUP_OWNER_MISMATCH')
        state.event = event
        await this.active.start(event)
      })()
      current = { activationID, pending }
      this.states.set(session.sessionID, current)
      void pending.catch(() => {})
    }
    await runService(null, waiter, () => current!.pending)
  }

  bind(session: SessionSnapshot, contexts: PromptContexts): void {
    const state = this.states.get(session.sessionID)
    if (!state?.batch || state.bound) return
    if (!session.turnID || session.turnSignal.aborted || session.signal.aborted) throw new HostHookError('HOST_STARTUP_CANCELLED', 'cancelled')
    const undo: (() => void)[] = [() => contexts.withdraw(session)]
    try {
      if (this.has('claude-code') && (!this.transcripts.bindStart || !this.transcripts.unbindStart) || this.has('codex') && (!this.codex.bindStart || !this.codex.unbindStart)) fail('HOST_STARTUP_ARTIFACT_UNAVAILABLE')
      if (this.has('claude-code')) {
        this.transcripts.bindStart!(session, state.activationID, session.turnID)
        undo.push(() => this.transcripts.unbindStart!(session, state.activationID, session.turnID!))
      }
      if (this.has('codex')) {
        this.codex.bindStart!(session, state.activationID, session.turnID)
        undo.push(() => this.codex.unbindStart!(session, state.activationID, session.turnID!))
      }
      contexts.rememberStartup(session, state.batch.model)
      state.bound = session.turnID
    } catch (error) {
      rollback(undo)
      throw error
    }
  }

  async model(session: SessionSnapshot): Promise<void> {
    const state = this.states.get(session.sessionID)
    if (!state?.event) return
    if (this.has('claude-code')) await this.transcripts.prepare(state.event, session, session.turnSignal)
    if (this.has('codex')) await this.codex.prepareStart!(state.event, session, session.turnSignal)
  }

  async shellEnvironment(session: SessionSnapshot): Promise<Readonly<Record<string, string>>> {
    if (!this.active.hasStartHooks || this.services.sessionStart || !this.has('claude-code')) return {}
    await this.ensure(session)
    if (!this.wrapper || this.config?.shell !== this.wrapper) fail('HOST_ENVIRONMENT_CONFIG_UNAVAILABLE')
    if (this.input.client?.config) {
      const config = await runService(METADATA_MS, session.turnSignal, signal => this.input.client!.config!.get({ signal }))
      if (config.error || !record(config.data) || config.data.shell !== this.wrapper) fail('HOST_ENVIRONMENT_CONFIG_UNAVAILABLE')
    }
    return this.shell.environment(session)
  }

  async dispose(): Promise<void> {
    for (const [config, original] of this.originalShells) {
      if (!config.shell || !this.wrappers.has(config.shell)) continue
      if (original === undefined) delete config.shell
      else config.shell = original
    }
    await this.shell.dispose(); this.states.clear(); this.created.clear(); this.wrappers.clear(); this.originalShells.clear()
  }
}
