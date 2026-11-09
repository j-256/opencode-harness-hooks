import type { HostVersion } from './contracts.js'
import type { JsonValue } from './types.js'

interface ToolSchema { readonly name: string; readonly fields: Readonly<Record<string, string>> }
const SCHEMAS: Readonly<Record<HostVersion, Readonly<Record<string, ToolSchema>>>> = Object.freeze({
  v1: {
    bash: { name: 'Bash', fields: {} }, read: { name: 'Read', fields: { filePath: 'file_path' } },
    write: { name: 'Write', fields: { filePath: 'file_path' } },
    edit: { name: 'Edit', fields: { filePath: 'file_path', oldString: 'old_string', newString: 'new_string', replaceAll: 'replace_all' } },
    apply_patch: { name: 'apply_patch', fields: { patchText: 'command' } },
  },
  v2: {
    shell: { name: 'Bash', fields: { background: 'run_in_background' } }, read: { name: 'Read', fields: { path: 'file_path' } },
    write: { name: 'Write', fields: { path: 'file_path' } },
    edit: { name: 'Edit', fields: { path: 'file_path', oldString: 'old_string', newString: 'new_string', replaceAll: 'replace_all' } },
    patch: { name: 'apply_patch', fields: { patchText: 'command' } },
  },
})

export class ToolInputMappingError extends Error {
  constructor() { super('TOOL_INPUT_AMBIGUOUS'); this.name = 'ToolInputMappingError' }
}
function schema(host: HostVersion, tool: string): ToolSchema | undefined {
  const name = tool.replace(/^(?:functions|opencode)\./, '')
  return Object.hasOwn(SCHEMAS[host], name) ? SCHEMAS[host][name] : undefined
}
export function toolName(host: HostVersion, tool: string): string { return schema(host, tool)?.name ?? tool }

function translate(input: Readonly<Record<string, JsonValue>>, fields: Readonly<Record<string, string>>): Record<string, JsonValue> {
  const seen = new Set<string>()
  return Object.fromEntries(Object.entries(input).map(([key, value]) => {
    const target = Object.hasOwn(fields, key) ? fields[key]! : key
    if (seen.has(target)) throw new ToolInputMappingError()
    seen.add(target)
    return [target, structuredClone(value)]
  }))
}
export function nativeToolInput(host: HostVersion, tool: string, input: Readonly<Record<string, JsonValue>>): Record<string, JsonValue> {
  return translate(input, schema(host, tool)?.fields ?? {})
}
export function hostToolInput(host: HostVersion, tool: string, input: Readonly<Record<string, JsonValue>>): Record<string, JsonValue> {
  return translate(input, Object.fromEntries(Object.entries(schema(host, tool)?.fields ?? {}).map(([key, value]) => [value, key])))
}
