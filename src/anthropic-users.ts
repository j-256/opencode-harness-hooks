interface Layout { readonly parts: readonly string[]; readonly joinPrevious?: true }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function textParts(content: unknown): readonly Record<string, unknown>[] | undefined {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  return Array.isArray(content) && content.length && content.every(part => record(part) && part.type === 'text' && typeof part.text === 'string') ? content : undefined
}

export function expandAnthropicUsers(source: readonly Record<string, unknown>[], layout: readonly Layout[], fingerprint: (text: string) => string): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = []
  let index = 0
  for (const raw of source) {
    const parts = raw.role === 'user' ? textParts(raw.content) : undefined
    if (!parts) { result.push(raw); continue }
    const segments: Record<string, unknown>[] = []
    let offset = 0, next = index
    while (offset < parts.length) {
      const expected = layout[next]
      if (!expected?.parts.length || next > index && !expected.joinPrevious || expected.parts.some((hash, position) => !parts[offset + position] || fingerprint(parts[offset + position]!.text as string) !== hash)) break
      segments.push({ ...raw, content: parts.slice(offset, offset + expected.parts.length) })
      offset += expected.parts.length; next++
    }
    if (offset === parts.length && segments.length > 1) { result.push(...segments); index = next }
    else { result.push(raw); index++ }
  }
  return result
}

export function mergeAnthropicUsers(source: readonly unknown[]): unknown[] {
  const result: unknown[] = []
  for (const raw of source) {
    const previous = result.at(-1)
    if (record(raw) && record(previous) && raw.role === 'user' && previous.role === 'user') {
      const before = textParts(previous.content), after = textParts(raw.content)
      const { content: _before, ...oldFields } = previous, { content: _after, ...newFields } = raw
      if (before && after && JSON.stringify(oldFields) === JSON.stringify(newFields)) { result[result.length - 1] = { ...previous, content: [...before, ...after] }; continue }
    }
    result.push(raw)
  }
  return result
}
