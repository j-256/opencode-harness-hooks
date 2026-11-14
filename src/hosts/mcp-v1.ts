import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { snapshotJsonObject } from '../bounded-json.js'
import type { McpHookOutput, McpHookRequest, McpHookService } from '../host-services.js'
import { HookServiceError, runService, UnsupportedServiceError } from '../service-execution.js'
import { EXECUTION_LIMITS } from '../runner.js'
import { V1ModelSessions } from './model-owned-v1.js'
import type { ModelSessionOptions, V1ModelClient, V1ModelConfiguration } from './model-owned-v1.js'
import { mcpInvocation } from './mcp-protocol-v1.js'
import { MCP_PROVIDER_ID, MCP_MODEL_ID } from './mcp-transport-v1.js'
export { MCP_PROVIDER_ID, MCP_MODEL_ID } from './mcp-transport-v1.js'

const MAX_REQUESTS = 32
const MAX_CONNECTIONS = 32
const MAX_SERVERS = 4096
const CONNECT_MS = 5000
interface Result { readonly data?: unknown; readonly error?: unknown }
interface ServerOptions { readonly query: { readonly directory: string }; readonly signal: AbortSignal }
export interface V1McpClient extends V1ModelClient {
  readonly mcp?: { readonly status?: (options: ServerOptions) => Promise<Result>; readonly connect?: (options: ServerOptions & { readonly path: { readonly name: string } }) => Promise<Result> }
}
type ModelDiagnostic = Parameters<NonNullable<ModelSessionOptions['diagnostic']>>[0]
type Diagnostic = Omit<ModelDiagnostic, 'phase'> & { readonly phase: ModelDiagnostic['phase'] | 'connection' }
interface Options extends Omit<ModelSessionOptions, 'client' | 'nested' | 'diagnostic'> { readonly client?: V1McpClient; readonly diagnostic?: (value: Diagnostic) => void }
interface Provider { readonly npm: string; readonly name: string; readonly models: Readonly<Record<string, unknown>>; readonly options: { readonly baseURL: string; readonly apiKey: string; readonly fetch: typeof fetch } }
interface Configuration extends V1ModelConfiguration { provider?: Record<string, unknown>; enabled_providers?: string[]; disabled_providers?: string[] }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function unavailable(code: string): never { throw new UnsupportedServiceError(code) }
function notReady(): never { throw new HookServiceError('MCP_SERVER_NOT_READY') }

export class V1McpTools extends V1ModelSessions implements McpHookService {
  readonly timeoutAccounting = 'wall' as const
  private readonly mcpLifetime = new AbortController()
  private readonly requests = new Set<Promise<McpHookOutput>>()
  private readonly connections = new Set<Promise<void>>()
  private readonly serverConnections = new Map<string, Promise<void>>()
  private readonly providers = new Map<Configuration, Provider>()
  private readonly allowlists = new Map<Configuration, { readonly original: string[]; readonly installed: string[] }>()
  private disposed?: Promise<void>
  private connectionFailures = 0
  private connectionObserverFailures = 0
  private constructor(private readonly mcpOptions: Options, private readonly mcpDirectory: string) { super(mcpOptions, mcpDirectory, 'mcp') }
  static async create(input: Options): Promise<V1McpTools> { const copied = { ...input }; return new V1McpTools(copied, await realpath(copied.directory)) }
  override configure(config: Configuration): void {
    if (config.disabled_providers?.includes(MCP_PROVIDER_ID)) unavailable('HOST_MCP_PROVIDER_DISABLED')
    const installed = this.providers.get(config)
    if (config.provider?.[MCP_PROVIDER_ID] !== undefined && config.provider[MCP_PROVIDER_ID] !== installed) unavailable('HOST_MCP_PROVIDER_CONFLICT')
    super.configure(config)
    const provider: Provider = { npm: '@ai-sdk/openai-compatible', name: 'MCP hook execution', models: { [MCP_MODEL_ID]: { name: 'MCP hook execution', limit: { context: EXECUTION_LIMITS.inputBytes, output: EXECUTION_LIMITS.outputBytes }, cost: { input: 0, output: 0 } } }, options: { apiKey: 'internal-not-a-credential', baseURL: 'https://opencode-harness-hooks.invalid/v1', fetch: async () => unavailable('HOST_MCP_REQUEST_OWNER_MISMATCH') } }
    config.provider ??= {}; config.provider[MCP_PROVIDER_ID] = provider; this.providers.set(config, provider)
    if (config.enabled_providers && !config.enabled_providers.includes(MCP_PROVIDER_ID)) {
      const original = config.enabled_providers, installed = [...original, MCP_PROVIDER_ID]
      config.enabled_providers = installed; this.allowlists.set(config, { original, installed })
    }
  }
  execute(input: McpHookRequest): Promise<McpHookOutput> {
    const operation = this.run({ ...input })
    this.requests.add(operation); void operation.finally(() => this.requests.delete(operation)).catch(() => {})
    return operation
  }
  private async run(request: McpHookRequest): Promise<McpHookOutput> {
    if (this.mcpLifetime.signal.aborted || request.signal.aborted) throw new HookServiceError('EXECUTION_CANCELLED')
    if (this.requests.size >= MAX_REQUESTS) unavailable('HOST_MCP_REQUEST_LIMIT')
    if (request.dialect === 'codex' || request.metadata && Object.keys(request.metadata).length) unavailable('HOST_MCP_REQUEST_METADATA_UNAVAILABLE')
    if (request.cwd !== this.mcpDirectory && request.cwd !== this.mcpOptions.directory || request.allowAuthentication !== false) unavailable('HOST_MCP_REQUEST_INVALID')
    const copied = snapshotJsonObject(request.input, EXECUTION_LIMITS.inputBytes, kind => { throw new HookServiceError(kind === 'size' ? 'EXECUTION_INPUT_LIMIT' : 'MCP_INPUT_INVALID') }).value
    const owner = this.session(request.sessionID), signal = AbortSignal.any([request.signal, owner.signal, owner.turnSignal, this.mcpLifetime.signal])
    try {
      return await runService(request.timeoutMs, signal, async current => {
        let status = await this.status(current)
        if (current.aborted) throw new HookServiceError('EXECUTION_CANCELLED')
        if (!Object.hasOwn(status, request.server)) throw new HookServiceError('MCP_SERVER_NOT_FOUND')
        let invocation = mcpInvocation(request.server, request.tool, copied, EXECUTION_LIMITS.inputBytes, Object.keys(status))
        const state = () => { const value = status[request.server]; return record(value) ? value.status : undefined }
        const ready = () => state() === 'connected'
        if (!ready()) {
          if (state() !== 'failed' || request.connectionPolicy === 'connected-only') notReady()
          if (request.connectionPolicy === 'connect-cached-without-waiting') {
            if (!this.serverConnections.has(request.server)) {
              if (this.connections.size >= MAX_CONNECTIONS) throw new HookServiceError('MCP_CONNECTION_LIMIT')
              const pending = this.observeConnection(request.server, request.sessionID)
              this.serverConnections.set(request.server, pending); this.connections.add(pending)
              void pending.finally(() => { this.connections.delete(pending); if (this.serverConnections.get(request.server) === pending) this.serverConnections.delete(request.server) }).catch(() => {})
            }
            notReady()
          }
          if (request.connectionPolicy !== 'wait-or-connect-cached') unavailable('HOST_MCP_CONNECTION_POLICY_UNAVAILABLE')
          await this.connect(request.server, current); status = await this.status(current); if (!ready()) notReady()
          invocation = mcpInvocation(request.server, request.tool, copied, EXECUTION_LIMITS.inputBytes, Object.keys(status))
        }
        const result = await this.evaluate({ sessionID: request.sessionID, cwd: request.cwd, prompt: 'Execute the reviewed MCP call', signal: current, mcp: invocation })
        if (typeof result.text !== 'string' || result.isError !== undefined && typeof result.isError !== 'boolean') throw new HookServiceError('MCP_OUTPUT_INVALID')
        return Object.freeze({ text: result.text, ...(result.isError === true ? { isError: true } : {}) })
      })
    } catch (error) { if (error instanceof HookServiceError || error instanceof UnsupportedServiceError) throw error; throw new HookServiceError('MCP_REQUEST_FAILED') }
  }
  private async status(signal: AbortSignal): Promise<Record<string, unknown>> {
    if (signal.aborted) throw new HookServiceError('EXECUTION_CANCELLED')
    const mcp = this.mcpOptions.client?.mcp
    if (!mcp?.status) unavailable('HOST_MCP_CONNECTION_UNAVAILABLE')
    const result = await mcp.status({ query: { directory: this.mcpDirectory }, signal })
    if (result.error || !record(result.data) || Object.keys(result.data).length > MAX_SERVERS) unavailable('HOST_MCP_CONNECTION_UNAVAILABLE')
    return result.data
  }
  private async observeConnection(server: string, sessionID: string): Promise<void> {
    const operationID = randomUUID(), started = performance.now()
    let success = false, code = 'MCP_CONNECTION_FAILED'
    try { await runService(CONNECT_MS, this.mcpLifetime.signal, child => this.connect(server, child)); success = true; code = 'MCP_CONNECTION_READY' }
    catch (error) { this.connectionFailures++; if (error instanceof HookServiceError && error.code === 'EXECUTION_CANCELLED') code = 'MCP_CONNECTION_CANCELLED'; throw error }
    finally {
      const value: Diagnostic = Object.freeze({ component: 'opencode-harness-hooks', operationID, sessionID, phase: 'connection', code, outcome: success ? 'success' : 'failed', durationMs: Math.round(performance.now() - started) })
      try { if (this.mcpOptions.diagnostic) this.mcpOptions.diagnostic(value); else console.error(JSON.stringify(value)) } catch { this.connectionObserverFailures++ }
    }
  }
  private async connect(server: string, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new HookServiceError('EXECUTION_CANCELLED')
    const mcp = this.mcpOptions.client?.mcp
    if (!mcp?.connect) unavailable('HOST_MCP_CONNECTION_UNAVAILABLE')
    const result = await mcp.connect({ path: { name: server }, query: { directory: this.mcpDirectory }, signal })
    if (result.error || result.data !== true) notReady()
  }
  override dispose(): Promise<void> {
    this.mcpLifetime.abort()
    return this.disposed ??= (async () => {
      await Promise.allSettled([...this.requests, ...this.connections]); await super.dispose()
      for (const [config, installed] of this.providers) if (config.provider?.[MCP_PROVIDER_ID] === installed) delete config.provider[MCP_PROVIDER_ID]
      this.providers.clear()
      for (const [config, value] of this.allowlists) if (config.enabled_providers === value.installed) config.enabled_providers = value.original
      this.allowlists.clear()
    })()
  }
  override inspect() { return Object.freeze({ ...super.inspect(), requests: this.requests.size, connections: this.connections.size, connectionFailures: this.connectionFailures, connectionObserverFailures: this.connectionObserverFailures }) }
}
