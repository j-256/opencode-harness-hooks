import { stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { handlerTimeoutMs } from './timeouts.js'
import type { HostServices } from './host-services.js'
import { snapshotCommandContexts } from './host-services.js'
import type { CommandInvocation } from './runner.js'
import type { JsonValue, NativeEvent, Registration } from './types.js'

const CLAUDE_ENV_FILE_EVENTS = new Set(['SessionStart', 'Setup', 'CwdChanged', 'FileChanged'])
const CODEX_RESTRICTED_ENV = new Set([
  'CODEX_EXEC_SERVER_NOISE_AUTH_TOKEN', 'NODE_REPL_AUTH_TOKEN', 'CODEX_GUARDIAN_DECISIONS_API_KEY',
  'OPENAI_FEDERATION_RULE_ID', 'OPENAI_IDENTITY_TOKEN_FILE', 'OPENAI_WORKLOAD_IDENTITY_CONTEXT',
])
const CLAUDE_PATH_VARIABLES = new Set(['CLAUDE_PROJECT_DIR', 'CLAUDE_PLUGIN_ROOT', 'CLAUDE_PLUGIN_DATA'])

export class CommandContextError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'CommandContextError' }
}

function commandEnvironment(registration: Registration, payload: Readonly<Record<string, JsonValue>>, host: HostServices): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...host.environment }
  const context = host.sourceContext?.[registration.sourceID]
  if (registration.dialect === 'claude-code') {
    for (const key of Object.keys(environment)) {
      if (key.startsWith('OTEL_') || key.startsWith('CLAUDE_PLUGIN_OPTION_')) delete environment[key]
    }
    environment.CLAUDE_PROJECT_DIR = registration.projectRoot ?? host.projectRoot
    delete environment.CLAUDE_PLUGIN_ROOT
    delete environment.CLAUDE_PLUGIN_DATA
    delete environment.CLAUDE_ENV_FILE
    if (registration.pluginRoot !== undefined) environment.CLAUDE_PLUGIN_ROOT = registration.pluginRoot
    if (context?.pluginData !== undefined) environment.CLAUDE_PLUGIN_DATA = context.pluginData
    const envFile = host.registrationContext?.[registration.id]?.envFile
    if (envFile !== undefined && CLAUDE_ENV_FILE_EVENTS.has(registration.event) && (registration.handler.args !== undefined || registration.handler.shell !== 'powershell')) environment.CLAUDE_ENV_FILE = envFile
    for (const [key, value] of Object.entries(context?.pluginOptions ?? {})) {
      environment[`CLAUDE_PLUGIN_OPTION_${key.toUpperCase()}`] = typeof value === 'string' ? value : JSON.stringify(value)
    }
  } else {
    for (const key of Object.keys(environment)) if (CODEX_RESTRICTED_ENV.has(key.toUpperCase())) delete environment[key]
    delete environment.CODEX_TOOL_CALL_ID
    environment.CODEX_THREAD_ID = String(payload.session_id ?? '')
    if (typeof payload.tool_use_id === 'string') environment.CODEX_TOOL_CALL_ID = payload.tool_use_id
    if (registration.pluginRoot !== undefined) {
      environment.PLUGIN_ROOT = registration.pluginRoot
      environment.CLAUDE_PLUGIN_ROOT = registration.pluginRoot
    }
    if (context?.pluginData !== undefined) {
      environment.PLUGIN_DATA = context.pluginData
      environment.CLAUDE_PLUGIN_DATA = context.pluginData
    }
  }
  return environment
}

function substituteExec(value: string, registration: Registration, environment: Readonly<NodeJS.ProcessEnv>, host: HostServices): string {
  return value.replace(/\$\{([^{}]+)\}/g, (original: string, key: string) => {
    if (CLAUDE_PATH_VARIABLES.has(key)) {
      if (environment[key] === undefined) throw new CommandContextError('COMMAND_PATH_UNAVAILABLE')
      return environment[key]
    }
    if (registration.pluginRoot !== undefined && key.startsWith('user_config.')) {
      const name = key.slice('user_config.'.length)
      const options = host.sourceContext?.[registration.sourceID]?.pluginOptions
      if (!options || !Object.hasOwn(options, name)) throw new CommandContextError('COMMAND_OPTION_UNAVAILABLE')
      const option = options[name]
      return typeof option === 'string' ? option : JSON.stringify(option)
    }
    return original
  })
}

async function commandCwd(registration: Registration, event: NativeEvent, host: HostServices): Promise<string> {
  if (registration.dialect !== 'claude-code') return event.cwd
  for (const candidate of [event.cwd, host.sessionDirectory, registration.projectRoot ?? host.projectRoot, host.environment.HOME, tmpdir()]) {
    if (candidate === undefined) continue
    try { if ((await stat(candidate)).isDirectory()) return candidate } catch {}
  }
  throw new CommandContextError('COMMAND_CWD_UNAVAILABLE')
}

export async function prepareCommand(registration: Registration, event: NativeEvent, payload: Readonly<Record<string, JsonValue>>, services: HostServices): Promise<CommandInvocation> {
  const host = snapshotCommandContexts({ ...services, environment: { ...services.environment } })
  const environment = commandEnvironment(registration, payload, host)
  const context = host.sourceContext?.[registration.sourceID]
  const exec = registration.dialect === 'claude-code' && registration.handler.args !== undefined
  let command = registration.handler.command ?? ''
  if (registration.dialect === 'codex' && process.platform === 'win32' && typeof registration.handler.commandWindows === 'string') command = registration.handler.commandWindows
  if (!exec && registration.dialect === 'claude-code' && registration.pluginRoot !== undefined && /\$\{user_config\./.test(command)) throw new CommandContextError('COMMAND_SHELL_OPTION_REFERENCE')
  if (!exec && registration.handler.shell === 'powershell' && !context?.shell) throw new CommandContextError('HOST_POWERSHELL_UNAVAILABLE')
  if (exec) command = substituteExec(command, registration, environment, host)
  const args = exec ? registration.handler.args?.map(value => substituteExec(value, registration, environment, host)) : undefined
  return {
    command, ...(args === undefined ? {} : { args }), cwd: await commandCwd(registration, event, host), env: environment,
    stdin: JSON.stringify(payload), timeoutMs: handlerTimeoutMs(registration, host),
    shell: context?.shell ?? (registration.dialect === 'codex' ? { program: environment.SHELL ?? '/bin/sh', args: ['-lc'] } : { program: '/bin/sh', args: ['-c'] }),
    ...(host.signal ? { signal: host.signal } : {}),
    ...(host.maxInputBytes === undefined ? {} : { maxInputBytes: host.maxInputBytes }),
    ...(host.maxOutputBytes === undefined ? {} : { maxOutputBytes: host.maxOutputBytes }),
  }
}
