import { HostHookError, ToolBridge } from './tools.js'
import type { ToolCall, ToolHostOptions } from './tools.js'

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function outcome(tool: string, output: unknown): 'completed' | 'error' | 'unknown' {
  if (!record(output)) return 'unknown'
  if (Array.isArray(output.content)) return output.isError === true ? 'error' : output.isError === undefined || output.isError === false ? 'completed' : 'unknown'
  if (typeof output.output !== 'string' || typeof output.title !== 'string' || !record(output.metadata)) return 'unknown'
  if (tool.replace(/^(?:functions|opencode)\./, '') === 'bash') return typeof output.metadata.exit === 'number' && Number.isInteger(output.metadata.exit) ? output.metadata.exit === 0 ? 'completed' : 'error' : 'unknown'
  return 'completed'
}

export function createV1Hooks(options: ToolHostOptions) {
  const bridge = new ToolBridge('v1', options)
  return {
    'tool.execute.before': async (input: ToolCall, output: { args: unknown }) => {
      const replacement = await bridge.before(input, output.args)
      if (!replacement) return
      if (!record(output.args) || Reflect.ownKeys(output.args).some(key => !Object.getOwnPropertyDescriptor(output.args, key)?.configurable) || !Object.isExtensible(output.args)) {
        bridge.unknown(input)
        throw new HostHookError('HOST_TOOL_INPUT_IMMUTABLE', 'unsupported')
      }
      for (const key of Reflect.ownKeys(output.args)) Reflect.deleteProperty(output.args, key)
      for (const [key, value] of Object.entries(replacement)) Object.defineProperty(output.args, key, { value, writable: true, enumerable: true, configurable: true })
    },
    'tool.execute.after': async (input: ToolCall & { readonly args: unknown }, output: unknown) => bridge.after(input, input.args, outcome(input.tool, output), output),
    dispose: () => bridge.dispose(),
    disposeSession: (sessionID: string) => bridge.disposeSession(sessionID),
    inspect: () => bridge.inspect(),
  }
}
