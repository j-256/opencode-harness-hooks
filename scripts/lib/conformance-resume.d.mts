export interface ResumeEvidence {
  readonly sessionRetained: boolean
  readonly prefixRetained: boolean
  readonly originalRetained: boolean
}
export function inspectResumeTranscript(rows: readonly unknown[], options: { readonly dialect: string; readonly sessionID: string; readonly callID: string; readonly original: string }): boolean
export function compareResumeEvidence(native: unknown, host: unknown): { readonly match: boolean; readonly native: ResumeEvidence; readonly host: ResumeEvidence }
