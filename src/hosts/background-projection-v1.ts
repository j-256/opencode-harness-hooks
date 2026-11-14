import { createHash, randomUUID } from 'node:crypto'
import type { BackgroundAnchor, BackgroundEntry, BackgroundRecords } from '../background-records.js'
import { snapshotJsonObject } from '../bounded-json.js'
import { HostHookError } from '../host-errors.js'
import type { PromptProtocol } from '../prompt-contexts.js'
import { runService } from '../service-execution.js'
import { snapshotID } from '../session-snapshot.js'
import type { SessionSnapshot } from '../sessions.js'
import { MODEL_REQUEST_HEADER } from './model-v1.js'
import type { WakeRecords } from '../wake-records.js'

export const BACKGROUND_REQUEST_HEADER = 'x-opencode-harness-hooks-background'
const MAX_BYTES = 32 * 1024 * 1024
const MAX_ROWS = 10000
const MAX_TICKETS = 1024
const MAX_VARIANTS = 128
const MAX_PENDING = 8
const READ_MS = 5000
const TOOL_REMINDER_SEPARATOR = '\n\n'
interface Carrier { readonly anchor: BackgroundAnchor; readonly parts?: readonly string[] }
interface Layout { readonly session: SessionSnapshot; readonly users: readonly Carrier[]; readonly tools: readonly Carrier[]; readonly current: Carrier; readonly bytes: number }
interface ProjectionRow extends Pick<BackgroundEntry, 'anchor' | 'dialect' | 'model'> { readonly replacePrompt?: boolean }
interface Ticket { readonly layout: Layout; readonly providerID: string; readonly protocol: PromptProtocol; readonly signal: AbortSignal; readonly cleanup: () => void; readonly hashes: Map<string, string>; rows?: readonly ProjectionRow[]; preparing?: Promise<void> }
interface Options { readonly records: BackgroundRecords; readonly wakes?: WakeRecords; readonly prepare: (session: SessionSnapshot, anchor: BackgroundAnchor, signal: AbortSignal) => Promise<void>; readonly maxBytes?: number }
interface Target { readonly carrier: Carrier; readonly position: number; readonly part?: number }
interface Wire { readonly value: Record<string, unknown>; readonly field: 'input' | 'messages'; readonly source: readonly Record<string, unknown>[]; readonly responses: boolean; readonly targets: ReadonlyMap<string, Target> }
function fail(code = 'HOST_BACKGROUND_CARRIER_UNAVAILABLE'): never { throw new HostHookError(code, code === 'HOST_BACKGROUND_CANCELLED' ? 'cancelled' : 'unsupported') }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function hash(value: string): string { return createHash('sha256').update(value).digest('hex') }
function carrierKey(anchor: BackgroundAnchor): string { return JSON.stringify([anchor.kind, anchor.messageID, anchor.kind === 'tool' ? anchor.callID : null]) }
function sameAnchor(a: BackgroundAnchor, b: BackgroundAnchor): boolean { return a.kind === b.kind && a.sessionID === b.sessionID && a.turnID === b.turnID && a.messageID === b.messageID && a.signature === b.signature && (a.kind !== 'tool' || b.kind === 'tool' && a.callID === b.callID) }
function id(value: unknown): string { return snapshotID(value) ? value : fail('HOST_BACKGROUND_LAYOUT_UNAVAILABLE') }
function promptParts(value: unknown): readonly string[] {
  if (!Array.isArray(value) || !value.length || !value.every(part => record(part) && part.type === 'text' && typeof part.text === 'string' && part.synthetic !== true && part.ignored !== true)) fail('HOST_BACKGROUND_LAYOUT_UNAVAILABLE')
  return value.map(part => part.text as string)
}
async function body(request: Request, signal: AbortSignal): Promise<string> {
  return runService(READ_MS, signal, async current => {
    const reader = request.clone().body?.getReader(); if (!reader) fail('HOST_BACKGROUND_REQUEST_UNAVAILABLE')
    const cancel = () => { void reader.cancel().catch(() => {}) }; current.addEventListener('abort', cancel, { once: true })
    try {
      if (current.aborted) fail('HOST_BACKGROUND_CANCELLED')
      const chunks: Uint8Array[] = []; let bytes = 0
      while (true) { const next = await reader.read(); if (next.done) break; bytes += next.value.byteLength; if (bytes > MAX_BYTES) fail('HOST_BACKGROUND_LIMIT'); chunks.push(next.value) }
      return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
    } finally { current.removeEventListener('abort', cancel); cancel() }
  })
}
function textParts(value: unknown, type: string): readonly Record<string, unknown>[] {
  if (typeof value === 'string') return [{ type, text: value }]
  if (!Array.isArray(value) || !value.length || !value.every(part => record(part) && part.type === type && typeof part.text === 'string')) fail()
  return value
}
function toolText(value: unknown): string { if (typeof value !== 'string') fail(); return value }

export class V1BackgroundProjection {
  private readonly layouts = new Map<string, Layout>()
  private readonly tickets = new Map<string, Ticket>()
  private readonly lifetime = new AbortController()
  private readonly maxBytes: number
  private readonly records: BackgroundRecords
  private readonly wakes?: WakeRecords
  private readonly prepare: Options['prepare']
  private pending = 0
  constructor(options: Options) { this.records = options.records; if (options.wakes) this.wakes = options.wakes; this.prepare = options.prepare; this.maxBytes = options.maxBytes ?? MAX_BYTES; if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1 || this.maxBytes > MAX_BYTES) fail('HOST_BACKGROUND_LIMIT') }
  capture(owner: SessionSnapshot, input: unknown): void {
    this.live(owner)
    if (!Array.isArray(input) || !input.length || input.length > MAX_ROWS) fail('HOST_BACKGROUND_LAYOUT_UNAVAILABLE')
    const users: Carrier[] = [], tools: Carrier[] = [], seen = new Set<string>(), calls = new Set<string>()
    let current: Carrier | undefined
    const session = Object.freeze({ sessionID: id(owner.sessionID), turnID: id(owner.turnID), signal: owner.signal, turnSignal: owner.turnSignal })
    for (const [index, raw] of input.entries()) {
      if (!record(raw) || !record(raw.info) || raw.info.sessionID !== owner.sessionID || !Array.isArray(raw.parts)) fail('HOST_BACKGROUND_LAYOUT_UNAVAILABLE')
      const info = raw.info, messageID = id(info.id); if (seen.has(messageID)) fail('HOST_BACKGROUND_LAYOUT_UNAVAILABLE'); seen.add(messageID)
      if (info.role === 'user') {
        const text = promptParts(raw.parts), signature = hash(JSON.stringify(text))
        const carrier: Carrier = Object.freeze({ anchor: Object.freeze({ kind: 'prompt', sessionID: owner.sessionID, turnID: messageID, messageID, signature }), parts: Object.freeze(text.map(hash)) }); users.push(carrier)
        if (index === input.length - 1) current = carrier
      } else if (info.role === 'assistant') {
        const turnID = id(info.parentID); if (!users.some(row => row.anchor.messageID === turnID)) fail('HOST_BACKGROUND_LAYOUT_UNAVAILABLE')
        let lastTool: Carrier | undefined
        for (const part of raw.parts) {
          if (!record(part)) fail('HOST_BACKGROUND_LAYOUT_UNAVAILABLE')
          if (part.type !== 'tool') continue
          const callID = id(part.callID); if (calls.has(callID)) fail('HOST_BACKGROUND_LAYOUT_UNAVAILABLE'); calls.add(callID)
          if (!record(part.state) || part.state.status !== 'completed' || typeof part.state.output !== 'string') { lastTool = undefined; continue }
          const carrier: Carrier = Object.freeze({ anchor: Object.freeze({ kind: 'tool', sessionID: owner.sessionID, turnID, messageID, callID, signature: hash(part.state.output) }) }); tools.push(carrier); lastTool = carrier
        }
        if (index === input.length - 1) current = lastTool
      } else fail('HOST_BACKGROUND_LAYOUT_UNAVAILABLE')
    }
    if (!current || users.at(-1)?.anchor.messageID !== owner.turnID || current.anchor.turnID !== owner.turnID || users.length + tools.length > MAX_ROWS) fail('HOST_BACKGROUND_LAYOUT_UNAVAILABLE')
    const previous = this.layouts.get(owner.sessionID)
    if (previous && previous.session.signal !== owner.signal) fail('HOST_BACKGROUND_OWNER_MISMATCH')
    const before = new Map([...(previous?.users ?? []), ...(previous?.tools ?? [])].map(row => [carrierKey(row.anchor), row.anchor]))
    for (const row of [...users, ...tools]) { const old = before.get(carrierKey(row.anchor)); if (old && !sameAnchor(old, row.anchor)) fail('HOST_BACKGROUND_LAYOUT_CHANGED') }
    const bytes = Buffer.byteLength(JSON.stringify({ users, tools, current }))
    if (this.bytes() - (previous?.bytes ?? 0) + bytes > this.maxBytes || !previous && this.layouts.size >= MAX_TICKETS) fail('HOST_BACKGROUND_LIMIT')
    this.layouts.set(owner.sessionID, Object.freeze({ session, users: Object.freeze(users), tools: Object.freeze(tools), current, bytes }))
  }
  issue(session: SessionSnapshot, providerID: string, protocol: PromptProtocol): string {
    this.live(session)
    const layout = this.layouts.get(session.sessionID)
    if (!layout || layout.session.signal !== session.signal || layout.session.turnSignal !== session.turnSignal || layout.session.turnID !== session.turnID || !snapshotID(providerID) || !['openai', 'anthropic'].includes(protocol)) fail('HOST_BACKGROUND_LAYOUT_UNAVAILABLE')
    if (this.tickets.size >= MAX_TICKETS || this.bytes() + layout.bytes + Buffer.byteLength(providerID) > this.maxBytes) fail('HOST_BACKGROUND_LIMIT')
    const token = randomUUID(), controller = new AbortController(), signal = AbortSignal.any([session.signal, session.turnSignal, this.lifetime.signal, controller.signal])
    const cleanup = () => { this.tickets.delete(token); session.signal.removeEventListener('abort', cleanup); session.turnSignal.removeEventListener('abort', cleanup); this.lifetime.signal.removeEventListener('abort', cleanup); controller.abort() }
    const ticket: Ticket = { layout, providerID, protocol, signal, cleanup, hashes: new Map() }
    this.tickets.set(token, ticket)
    session.signal.addEventListener('abort', cleanup, { once: true }); session.turnSignal.addEventListener('abort', cleanup, { once: true }); this.lifetime.signal.addEventListener('abort', cleanup, { once: true })
    return token
  }
  owner(token: string): { readonly sessionID: string; readonly messageID: string } | undefined { const ticket = this.tickets.get(token); return ticket ? { sessionID: ticket.layout.session.sessionID, messageID: ticket.layout.session.turnID! } : undefined }
  async project(request: Request, token: string, providerID: string): Promise<Request> {
    const ticket = this.tickets.get(token)
    if (!ticket || ticket.signal.aborted || providerID !== ticket.providerID || request.headers.has(MODEL_REQUEST_HEADER) || request.headers.has(BACKGROUND_REQUEST_HEADER) && request.headers.get(BACKGROUND_REQUEST_HEADER) !== token) fail('HOST_BACKGROUND_REQUEST_UNAVAILABLE')
    if (this.pending >= MAX_PENDING) fail('HOST_BACKGROUND_LIMIT')
    this.pending++
    const signal = AbortSignal.any([ticket.signal, request.signal]), headers = new Headers(request.headers); headers.delete(BACKGROUND_REQUEST_HEADER); headers.delete('content-length')
    const output = (text: string) => { if (signal.aborted) fail('HOST_BACKGROUND_CANCELLED'); const result = new Request(request, { body: text, headers, signal }); result.headers.delete(BACKGROUND_REQUEST_HEADER); result.headers.delete('content-length'); return result }
    try {
      const text = await body(request, signal), fingerprint = hash(text)
      if ([...ticket.hashes.values()].includes(fingerprint)) return output(text)
      if (ticket.hashes.size >= MAX_VARIANTS || this.bytes() + 128 > this.maxBytes) fail('HOST_BACKGROUND_LIMIT')
      let value: unknown; try { value = JSON.parse(text) } catch { fail('HOST_BACKGROUND_REQUEST_UNAVAILABLE') }
      const wire = this.wire(ticket, value)
      this.validate(ticket, wire, ticket.rows ?? this.read(ticket.layout.session))
      if (!ticket.rows) {
        ticket.preparing ??= (async () => {
          await this.prepare(ticket.layout.session, ticket.layout.current.anchor, signal)
          if (signal.aborted) fail('HOST_BACKGROUND_CANCELLED')
          const rows = this.read(ticket.layout.session).filter(row => row.anchor)
          this.validate(ticket, wire, rows)
          ticket.rows = Object.freeze(rows)
        })().finally(() => { delete ticket.preparing })
        await ticket.preparing
      }
      this.validate(ticket, wire, ticket.rows!)
      const projected = this.overlay(ticket, wire), serialized = JSON.stringify(projected)
      if (Buffer.byteLength(serialized) > MAX_BYTES) fail('HOST_BACKGROUND_LIMIT')
      if (signal.aborted) fail('HOST_BACKGROUND_CANCELLED')
      ticket.hashes.set(fingerprint, hash(serialized))
      return output(serialized)
    } catch (error) { if (signal.aborted) throw new HostHookError('HOST_BACKGROUND_CANCELLED', 'cancelled'); throw error } finally { this.pending-- }
  }
  removeSession(sessionID: string): void { this.layouts.delete(sessionID); for (const ticket of this.tickets.values()) if (ticket.layout.session.sessionID === sessionID) ticket.cleanup() }
  dispose(): void { this.lifetime.abort(); this.layouts.clear(); for (const ticket of this.tickets.values()) ticket.cleanup() }
  inspect() { return Object.freeze({ layouts: this.layouts.size, tickets: this.tickets.size, bytes: this.bytes(), pending: this.pending, disposed: this.lifetime.signal.aborted }) }
  private live(session: SessionSnapshot): void { if (this.lifetime.signal.aborted || session.signal.aborted || session.turnSignal.aborted || !snapshotID(session.turnID)) fail('HOST_BACKGROUND_CANCELLED') }
  private bytes(): number { return [...this.layouts.values()].reduce((sum, row) => sum + row.bytes, 0) + [...this.tickets.values()].reduce((sum, ticket) => sum + ticket.layout.bytes + Buffer.byteLength(ticket.providerID) + ticket.hashes.size * 128, 0) }
  private wire(ticket: Ticket, input: unknown): Wire {
    const value = snapshotJsonObject(input, MAX_BYTES, kind => fail(kind === 'size' ? 'HOST_BACKGROUND_LIMIT' : 'HOST_BACKGROUND_REQUEST_UNAVAILABLE')).value
    const responses = ticket.protocol === 'openai' && Array.isArray(value.input) && value.messages === undefined, field = responses ? 'input' : 'messages', source = value[field]
    if (!Array.isArray(source) || source.length > MAX_ROWS || !source.every(record)) fail('HOST_BACKGROUND_REQUEST_UNAVAILABLE')
    const targets = new Map<string, Target>(), toolIDs = new Set<string>(); let userIndex = 0
    const addTool = (position: number, callID: unknown, output: unknown, part?: number) => {
      if (!snapshotID(callID) || toolIDs.has(callID)) fail(); toolIDs.add(callID)
      const carrier = ticket.layout.tools.find(row => row.anchor.kind === 'tool' && row.anchor.callID === callID)
      if (!carrier || hash(toolText(output)) !== carrier.anchor.signature) fail()
      targets.set(carrierKey(carrier.anchor), { carrier, position, ...(part !== undefined ? { part } : {}) })
    }
    for (const [position, raw] of source.entries()) {
      if (responses && raw.type === 'function_call_output') { addTool(position, raw.call_id, raw.output); continue }
      if (ticket.protocol === 'openai' && raw.role === 'tool') { addTool(position, raw.tool_call_id, raw.content); continue }
      if (raw.role !== 'user') continue
      if (ticket.protocol === 'anthropic' && Array.isArray(raw.content) && raw.content.some(part => record(part) && part.type === 'tool_result')) {
        if (!raw.content.length || !raw.content.every(part => record(part) && part.type === 'tool_result' && part.is_error !== true)) fail()
        for (const [part, result] of raw.content.entries()) addTool(position, result.tool_use_id, result.content, part)
        continue
      }
      const content = textParts(raw.content, responses ? 'input_text' : 'text'), carrier = ticket.layout.users[userIndex++]
      if (!carrier || content.length < carrier.parts!.length || content.slice(-carrier.parts!.length).some((part, index) => hash(part.text as string) !== carrier.parts![index])) fail()
      targets.set(carrierKey(carrier.anchor), { carrier, position })
    }
    if (userIndex !== ticket.layout.users.length || ticket.layout.tools.some(row => !targets.has(carrierKey(row.anchor)))) fail()
    return { value, field, source, responses, targets }
  }
  private read(session: SessionSnapshot): readonly ProjectionRow[] {
    const rows: ProjectionRow[] = [...this.records.read(session)]
    for (const row of this.wakes?.read(session) ?? []) {
      const binding = row.binding; if (!binding) continue
      rows.push({ dialect: 'claude-code', anchor: binding.anchor, model: binding.model, ...(binding.placement.kind === 'system' ? { replacePrompt: true } : {}) })
      if (binding.developer.length) rows.push({ dialect: 'codex', anchor: binding.anchor, model: binding.developer })
    }
    return rows
  }
  private validate(ticket: Ticket, wire: Wire, rows: readonly ProjectionRow[]): void {
    for (const row of rows) {
      if (!row.anchor) { if (row.model.length && row.dialect === 'codex' && ticket.protocol === 'anthropic') fail('HOST_BACKGROUND_ROLE_UNAVAILABLE'); continue }
      const target = wire.targets.get(carrierKey(row.anchor))
      if (!target || !sameAnchor(row.anchor, target.carrier.anchor)) fail()
      if (row.replacePrompt && row.anchor.kind !== 'prompt') fail()
      if (row.model.length && row.dialect === 'codex' && ticket.protocol === 'anthropic') fail('HOST_BACKGROUND_ROLE_UNAVAILABLE')
    }
  }
  private overlay(ticket: Ticket, wire: Wire): Record<string, unknown> {
    const changes = new Map<number, Record<string, unknown>>(), developers = new Map<number, unknown[]>()
    const groups = new Map<string, { readonly anchor: BackgroundAnchor; readonly model: string[]; replacement?: readonly string[] }>()
    for (const row of ticket.rows!) {
      if (!row.model.length || !row.anchor) continue
      const target = wire.targets.get(carrierKey(row.anchor))!
      if (row.dialect === 'codex') {
        const values = developers.get(target.position) ?? []
        for (const text of row.model) values.push(wire.responses ? { type: 'message', role: 'developer', content: [{ type: 'input_text', text }] } : { role: 'developer', content: text })
        developers.set(target.position, values); continue
      }
      const key = carrierKey(row.anchor), group = groups.get(key) ?? { anchor: row.anchor, model: [] }
      if (row.replacePrompt) { if (group.replacement) fail(); group.replacement = row.model } else group.model.push(...row.model)
      groups.set(key, group)
    }
    for (const group of groups.values()) {
      const target = wire.targets.get(carrierKey(group.anchor))!, raw = changes.get(target.position) ?? wire.source[target.position]!, suffix = group.model.join(TOOL_REMINDER_SEPARATOR)
      if (group.anchor.kind === 'prompt') {
        const type = wire.responses ? 'input_text' : 'text', content = textParts(raw.content, type)
        const original = group.replacement ? [...content.slice(0, -target.carrier.parts!.length), ...group.replacement.map((text, index) => ({ ...(index === group.replacement!.length - 1 ? content.at(-1) : { type }), text }))] : content
        changes.set(target.position, { ...raw, content: [...group.model.map((text, index) => ({ type, text: text + (index === group.model.length - 1 ? '\n' : '') })), ...original] })
      } else if (target.part !== undefined) {
        const content = [...raw.content as Record<string, unknown>[]], part = content[target.part]!
        content[target.part] = { ...part, content: toolText(part.content) + TOOL_REMINDER_SEPARATOR + suffix }; changes.set(target.position, { ...raw, content })
      } else {
        const field = wire.responses ? 'output' : 'content'; changes.set(target.position, { ...raw, [field]: toolText(raw[field]) + TOOL_REMINDER_SEPARATOR + suffix })
      }
    }
    return { ...wire.value, [wire.field]: wire.source.flatMap((raw, index) => [changes.get(index) ?? raw, ...(developers.get(index) ?? [])]) }
  }
}
