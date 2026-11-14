import { sessionSnapshot } from './session-snapshot.js'
import type { SessionSnapshot } from './sessions.js'
import type { JsonValue } from './types.js'

export const CODEX_TRANSCRIPT_SNAPSHOT_KIND = 'codex-transcript-v1'
const FIELDS = ['directory', 'originals', 'starts', 'published']

export function codexTranscriptSnapshot(value: unknown, session: SessionSnapshot): Readonly<Record<string, JsonValue>> {
  const hasPrompts = value !== null && typeof value === 'object' && Object.hasOwn(value, 'prompts')
  const input = sessionSnapshot(CODEX_TRANSCRIPT_SNAPSHOT_KIND, value, session, [...FIELDS, ...(hasPrompts ? ['prompts'] : [])])
  return { ...input, prompts: hasPrompts ? input.prompts! : [] }
}
