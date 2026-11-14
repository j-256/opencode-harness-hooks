export const MCP_TOOL_ERROR_TEXT = 'MCP tool returned an error'
export const MCP_ARTIFACT_KIND = 'mcp'
export const MCP_ARTIFACT_STATUS = Object.freeze({ SUCCESS: 'success', TOOL_ERROR: 'tool-error' } as const)
export const MCP_PROMPT_SUCCESS_TEXT = 'UserPromptSubmit completed'

export interface McpArtifact {
  readonly kind: typeof MCP_ARTIFACT_KIND
  readonly status: typeof MCP_ARTIFACT_STATUS[keyof typeof MCP_ARTIFACT_STATUS]
  readonly server: string
  readonly tool: string
  readonly stdout: string
  readonly completedAt: number
  readonly durationMs: number
  readonly sourceToolNamespace?: string
}
