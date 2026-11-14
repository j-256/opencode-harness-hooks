import { createHash } from 'node:crypto'
import { HostHookError } from './host-errors.js'
import type { SessionSnapshot } from './sessions.js'
import type { WakeEntry, WakeRecords } from './wake-records.js'

const hash = (text: string) => createHash('sha256').update(text).digest('hex')
function fail(): never { throw new HostHookError('WAKE_HISTORY_OWNER_MISMATCH', 'unsupported') }
export class WakeHistory {
  private readonly rows: readonly WakeEntry[]
  private readonly positions = new Map<string, WakeEntry[]>()
  private readonly seen = new Set<string>()
  constructor(records: WakeRecords | undefined, session: SessionSnapshot) {
    this.rows = records?.read(session).filter(row => row.binding) ?? []
    for (const row of this.rows) { const anchor = row.binding!.anchor, key = this.key(anchor.kind, anchor.messageID, anchor.kind === 'tool' ? anchor.callID : undefined), group = this.positions.get(key) ?? []; group.push(row); this.positions.set(key, group) }
  }
  prompt(messageID: string, text: readonly string[]): readonly WakeEntry[] { return this.take('prompt', messageID, messageID, hash(JSON.stringify(text))) }
  tool(messageID: string, turnID: string, callID: string, output: string): readonly WakeEntry[] { return this.take('tool', messageID, turnID, hash(output), callID) }
  complete(): void { if (this.rows.some(row => !this.seen.has(row.deliveryID))) fail() }
  private take(kind: 'prompt' | 'tool', messageID: string, turnID: string, signature: string, callID?: string): readonly WakeEntry[] {
    const rows = this.positions.get(this.key(kind, messageID, callID)) ?? []
    for (const row of rows) { const anchor = row.binding!.anchor; if (this.seen.has(row.deliveryID) || anchor.turnID !== turnID || anchor.signature !== signature) fail(); this.seen.add(row.deliveryID) }
    return rows
  }
  private key(kind: 'prompt' | 'tool', messageID: string, callID?: string): string { return JSON.stringify([kind, messageID, callID ?? null]) }
}
