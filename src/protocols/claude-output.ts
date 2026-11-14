import { z } from 'zod/v4'
import type { JsonValue } from '../types.js'
import { record } from './shared.js'

const DECISIONS = ['approve', 'block'] as const
const PERMISSION_DECISIONS = ['allow', 'deny', 'ask'] as const
const PERMISSION_MODES = ['acceptEdits', 'auto', 'bypassPermissions', 'default', 'dontAsk', 'plan'] as const
const DISCRIMINATORS = new Set(['async', 'hookEventName', 'behavior'])
const MAX_ENUM_VALUES = 6
const DISPLAY_TITLE_LIMIT = 200
const DISPLAY_DESCRIPTION_LIMIT = 2000
const DISPLAY_NAME_LIMIT = 64
const singleLineLabel = (value: string) => !value.includes('\n') && /\S/.test(value)
const PERMISSION_DISPLAY = z.object({ title: z.string().max(DISPLAY_TITLE_LIMIT).refine(singleLineLabel), description: z.string().max(DISPLAY_DESCRIPTION_LIMIT).regex(/\S/), displayName: z.string().max(DISPLAY_NAME_LIMIT).refine(singleLineLabel) })
const JSON_OBJECT = z.record(z.string(), z.unknown())
const PERMISSION_DESTINATION = z.enum(['userSettings', 'projectSettings', 'localSettings', 'session', 'cliArg'])
const RULE = z.object({ toolName: z.string(), ruleContent: z.string().optional() })
const permissionRules = <T extends 'addRules' | 'replaceRules' | 'removeRules'>(type: T) => z.object({ type: z.literal(type), rules: z.array(RULE), behavior: z.enum(PERMISSION_DECISIONS), destination: PERMISSION_DESTINATION })
const PERMISSION_UPDATE = z.discriminatedUnion('type', [
  permissionRules('addRules'), permissionRules('replaceRules'), permissionRules('removeRules'),
  z.object({ type: z.literal('setMode'), mode: z.preprocess(value => value === 'manual' ? 'default' : value, z.enum(PERMISSION_MODES)), destination: PERMISSION_DESTINATION }),
  z.object({ type: z.literal('addDirectories'), directories: z.array(z.string()), destination: PERMISSION_DESTINATION }),
  z.object({ type: z.literal('removeDirectories'), directories: z.array(z.string()), destination: PERMISSION_DESTINATION }),
])
const specific = <T extends string, S extends z.ZodRawShape>(event: T, fields: S) => z.object({ hookEventName: z.literal(event), ...fields })
const additional = () => ({ additionalContext: z.string().optional() })
const SYNC_OUTPUT = z.object({
  continue: z.boolean().optional(), suppressOutput: z.boolean().optional(), stopReason: z.string().optional(),
  decision: z.enum(DECISIONS).optional(), reason: z.string().optional(), systemMessage: z.string().optional(), terminalSequence: z.string().optional(),
  hookSpecificOutput: z.union([
    specific('PreToolUse', { permissionDecision: z.enum([...PERMISSION_DECISIONS, 'defer']).optional(), permissionDecisionReason: z.string().optional(), updatedInput: JSON_OBJECT.optional(), ...additional(), permissionDisplay: PERMISSION_DISPLAY.optional().catch(undefined) }),
    specific('UserPromptSubmit', { ...additional(), sessionTitle: z.string().optional(), suppressOriginalPrompt: z.boolean().optional() }),
    specific('UserPromptExpansion', { ...additional(), suppressOriginalPrompt: z.boolean().optional() }),
    specific('SessionStart', { ...additional(), initialUserMessage: z.string().optional(), sessionTitle: z.string().optional(), watchPaths: z.array(z.string()).optional(), reloadSkills: z.boolean().optional() }),
    specific('Setup', additional()),
    specific('PreModelSwitch', { permissionDecision: z.enum(PERMISSION_DECISIONS).optional(), permissionDecisionReason: z.string().optional() }),
    specific('PostModelSwitch', additional()), specific('SubagentStart', additional()),
    specific('PostToolUse', { ...additional(), classifierContext: z.string().optional(), updatedToolOutput: z.unknown().optional(), updatedMCPToolOutput: z.unknown().optional() }),
    specific('PostToolUseFailure', additional()), specific('PostToolBatch', additional()), specific('Stop', additional()), specific('SubagentStop', additional()),
    specific('PermissionDenied', { retry: z.boolean().optional() }), specific('Notification', additional()),
    specific('PermissionRequest', { decision: z.union([
      z.object({ behavior: z.literal('allow'), updatedInput: JSON_OBJECT.optional(), updatedPermissions: z.array(PERMISSION_UPDATE).optional() }),
      z.object({ behavior: z.literal('deny'), message: z.string().optional(), interrupt: z.boolean().optional() }),
    ]) }),
    specific('Elicitation', { action: z.enum(['accept', 'decline', 'cancel']).optional(), content: JSON_OBJECT.optional() }),
    specific('ElicitationResult', { action: z.enum(['accept', 'decline', 'cancel']).optional(), content: JSON_OBJECT.optional() }),
    specific('CwdChanged', { watchPaths: z.array(z.string()).optional() }), specific('FileChanged', { watchPaths: z.array(z.string()).optional() }),
    specific('WorktreeCreate', { worktreePath: z.string() }), specific('MessageDisplay', { displayContent: z.string().optional() }),
  ]).optional(),
})
const OUTPUT = z.union([z.object({ async: z.literal(true), asyncTimeout: z.number().optional() }), SYNC_OUTPUT])
export const CLAUDE_SPECIFIC_OUTPUT_FIELDS: readonly string[] = Object.freeze([...new Set(SYNC_OUTPUT.shape.hookSpecificOutput.unwrap().options.flatMap(option => Object.keys(option.shape)))])

type Issue = z.core.$ZodIssue
interface Failure { readonly path: readonly PropertyKey[]; readonly message: string }
function discriminator(issue: Issue): boolean { return issue.code === 'invalid_value' && DISCRIMINATORS.has(String(issue.path.at(-1))) }
function describe(issue: Issue): Failure {
  const parent: PropertyKey[] = []
  let current = issue
  while (current.code === 'invalid_union' && current.errors.length) {
    parent.push(...current.path)
    const relevant = current.errors.find(branch => branch.length > 0 && !branch.some(discriminator))
    if (relevant) { current = relevant[0]!; continue }
    const tags = current.errors.flatMap(branch => branch.filter(discriminator))
    const first = tags[0]
    if (first?.code !== 'invalid_value') return { path: parent, message: current.message }
    const values = [...new Set(tags.flatMap(tag => tag.code === 'invalid_value' ? tag.values.map(value => JSON.stringify(value)) : []))]
    return { path: [...parent, ...first.path], message: 'expected one of ' + values.slice(0, MAX_ENUM_VALUES).join(' | ') + (values.length > MAX_ENUM_VALUES ? ' | \u2026' : '') }
  }
  return { path: [...parent, ...current.path], message: current.message.replace(/^Invalid input: /, '') }
}
function path(value: readonly PropertyKey[]): string { return value.map(String).join('.') || '(root)' }

function validationError(body: Record<string, JsonValue>, error: z.ZodError): string {
  const issues = error.issues.map(describe)
  const first = issues[0]
  let message = first ? path(first.path) + ': ' + first.message : 'unknown error'
  const hook = body.hookSpecificOutput
  if (record(hook) && !Object.hasOwn(hook, 'hookEventName')) message = 'hookSpecificOutput is missing required field "hookEventName"'
  else if (record(hook) && hook.hookEventName === 'PermissionRequest' && !record(hook.decision) && first?.path[0] === 'hookSpecificOutput' && first.path[1] === 'decision') message += ' (PermissionRequest decision must be {"behavior": "allow"} or {"behavior": "deny", "message": "..."})'
  else if (first?.path.length === 1 && first.path[0] === 'decision' && typeof body.decision === 'string' && ['allow', 'deny', 'ask'].includes(body.decision)) {
    message += body.decision === 'ask' ? ' (top-level decision is the legacy approve|block field; for "ask" use hookSpecificOutput.permissionDecision in a PreToolUse hook)' : ` (top-level decision is the legacy approve|block field; for "${body.decision}" use hookSpecificOutput.permissionDecision in a PreToolUse hook, or hookSpecificOutput.decision: {"behavior": "${body.decision}"} in a PermissionRequest hook)`
  }
  const other = issues.slice(1).map(issue => '  - ' + path(issue.path) + ': ' + issue.message)
  return 'Hook JSON output validation failed \u2014 ' + message + (other.length ? '\n' + other.join('\n') : '') + "\n\nThe hook's output was: " + JSON.stringify(body, null, 2) + '\n\nExpected schema:\n' + EXPECTED_SCHEMA
}

export type ClaudeStopOutput =
  | { readonly kind: 'plain'; readonly text: string }
  | { readonly kind: 'sync'; readonly body: Readonly<Record<string, JsonValue>> }
  | { readonly kind: 'async' | 'unmapped-syntax' }
  | { readonly kind: 'invalid'; readonly category: 'schema' | 'event' | 'syntax'; readonly error: string }

export function parseClaudeStopOutput(stdout: string): ClaudeStopOutput {
  const text = stdout.trim()
  if (!text.startsWith('{')) return { kind: 'plain', text }
  let body: unknown
  try { body = JSON.parse(text) } catch {
    if (!text.endsWith('}')) return { kind: 'plain', text }
    const lines = text.split('\n').filter(line => line.trim())
    if (lines.length > 1 && lines.every(line => { try { const result = OUTPUT.safeParse(JSON.parse(line)); return !result.success || Object.keys(result.data).length === 0 } catch { return false } })) return { kind: 'plain', text }
    if (lines.length > 1 && lines.every(line => { try { JSON.parse(line); return true } catch { return false } })) return { kind: 'invalid', category: 'syntax', error: 'Hook output looks like a JSON object but is not valid JSON \u2014 JSON Parse error: Unable to parse JSON string. Emit the payload with a JSON encoder (jq, ConvertTo-Json, json.dumps) rather than string concatenation so backslashes and quotes inside strings are escaped.' }
    return { kind: 'unmapped-syntax' }
  }
  if (record(body) && body.async === true) return { kind: 'async' }
  const result = OUTPUT.safeParse(body)
  if (!result.success) return { kind: 'invalid', category: 'schema', error: validationError(body as Record<string, JsonValue>, result.error) }
  const normalized = result.data as Record<string, JsonValue>
  if (record(normalized.hookSpecificOutput) && normalized.hookSpecificOutput.hookEventName !== 'Stop') return { kind: 'invalid', category: 'event', error: `Failed to run: Hook returned incorrect event name: expected 'Stop' but got '${normalized.hookSpecificOutput.hookEventName}'. Full stdout: ` + JSON.stringify(normalized, null, 2) }
  return { kind: 'sync', body: normalized }
}

const EXPECTED_SCHEMA = JSON.stringify({
  "continue": "boolean (optional)",
  "suppressOutput": "boolean (optional)",
  "stopReason": "string (optional)",
  "decision": "\"approve\" | \"block\" (optional)",
  "reason": "string (optional)",
  "systemMessage": "string (optional)",
  "terminalSequence": "string (optional)",
  "hookSpecificOutput": {
    "for PreToolUse": {
      "hookEventName": "\"PreToolUse\"",
      "permissionDecision": "\"allow\" | \"deny\" | \"ask\" | \"defer\" (optional)",
      "permissionDecisionReason": "string (optional)",
      "updatedInput": "object (optional) - Modified tool input to use"
    },
    "for PermissionRequest": {
      "hookEventName": "\"PermissionRequest\"",
      "decision": {
        "to allow": {
          "behavior": "\"allow\"",
          "updatedInput": "object (optional) - Modified tool input to use",
          "updatedPermissions": "array (optional) - Permission updates"
        },
        "to deny": {
          "behavior": "\"deny\"",
          "message": "string (optional)",
          "interrupt": "boolean (optional)"
        }
      }
    },
    "for UserPromptSubmit": {
      "hookEventName": "\"UserPromptSubmit\"",
      "additionalContext": "string (optional)"
    },
    "for PostToolUse": {
      "hookEventName": "\"PostToolUse\"",
      "additionalContext": "string (optional)"
    },
    "for PostToolBatch": {
      "hookEventName": "\"PostToolBatch\"",
      "additionalContext": "string (optional)"
    },
    "for Stop / SubagentStop": {
      "hookEventName": "\"Stop\" | \"SubagentStop\"",
      "additionalContext": "string (optional) - Feedback for the model; the conversation continues so the model can act on it"
    }
  }
}, null, 2)
