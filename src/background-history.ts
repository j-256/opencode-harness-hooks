import { createHash } from 'node:crypto'
import type { BackgroundEntry, BackgroundRecords } from './background-records.js'
import { HostHookError } from './host-errors.js'
import type { SessionSnapshot } from './sessions.js'
import type { Dialect } from './contracts.js'

function hash(value: string): string { return createHash('sha256').update(value).digest('hex') }
function fail(): never { throw new HostHookError('BACKGROUND_HISTORY_OWNER_MISMATCH', 'unsupported') }
export class BackgroundHistory {
  private readonly rows: readonly BackgroundEntry[]
  private readonly positions = new Map<string, BackgroundEntry[]>()
  private readonly seen = new Set<string>()
  constructor(records: BackgroundRecords | undefined, session: SessionSnapshot, dialect: Dialect) {
    this.rows = records?.read(session).filter(row => row.anchor && row.dialect === dialect && (dialect === 'claude-code' ? row.artifact : row.model.length)) ?? []
    for (const row of this.rows) { const anchor = row.anchor!, key = this.key(anchor.kind, anchor.messageID, anchor.kind === 'tool' ? anchor.callID : undefined), group = this.positions.get(key) ?? []; group.push(row); this.positions.set(key, group) }
  }
  prompt(messageID: string, text: readonly string[]): readonly BackgroundEntry[] { return this.take('prompt', messageID, messageID, hash(JSON.stringify(text))) }
  tool(messageID: string, turnID: string, callID: string, output: string): readonly BackgroundEntry[] { return this.take('tool', messageID, turnID, hash(output), callID) }
  complete(): void { if (this.rows.some(row => !this.seen.has(row.id))) fail() }
  private take(kind: 'prompt' | 'tool', messageID: string, turnID: string, signature: string, callID?: string): readonly BackgroundEntry[] {
    const rows = this.positions.get(this.key(kind, messageID, callID)) ?? []
    for (const row of rows) { if (this.seen.has(row.id) || row.anchor!.turnID !== turnID || row.anchor!.signature !== signature) fail(); this.seen.add(row.id) }
    return rows
  }
  private key(kind: 'prompt' | 'tool', messageID: string, callID?: string): string { return JSON.stringify([kind, messageID, callID ?? null]) }
}
