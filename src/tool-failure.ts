import type { HostToolEvent } from './tool-types.js'

export const MAX_TOOL_RESULT_BYTES = 8 * 1024 * 1024
const MAX_SHELL_EXIT = 255

export function v1ShellFailure(event: HostToolEvent): { readonly output: string; readonly error: string } | undefined {
  if (event.host !== 'v1' || event.event !== 'PostToolUseFailure' || event.tool.replace(/^(?:functions|opencode)\./, '') !== 'bash') return
  try {
    const result = event.result
    if (!result || typeof result !== 'object' || Array.isArray(result)) return
    const { output, title, metadata } = result as Record<string, unknown>
    if (typeof output !== 'string' || typeof title !== 'string' || !metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return
    const exit = (metadata as Record<string, unknown>).exit
    if (typeof exit !== 'number' || !Number.isInteger(exit) || exit <= 0 || exit > MAX_SHELL_EXIT) return
    const error = `Exit code ${exit}\n${output}`
    if (Buffer.byteLength(error) > MAX_TOOL_RESULT_BYTES) return
    return { output, error }
  } catch { return }
}
