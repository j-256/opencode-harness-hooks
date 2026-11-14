import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { executeRegistration } from '../src/handlers.js'
import { claudePromptAttachments } from '../src/prompt-attachments.js'
import type { Registration } from '../src/types.js'
import type { DispatchResult } from '../src/engine.js'
import { nativeHookRecord } from '../src/hook-record-snapshot.js'

const oracle = JSON.parse(readFileSync(new URL('./fixtures/claude-mcp-prompt-oracle.json', import.meta.url), 'utf8')) as { cases: { mode: string; stdout: string; isError: boolean; bodies: unknown[] }[] }
function normalize(value: unknown): unknown {
  const body = JSON.parse(JSON.stringify(value)), item = body.attachment
  assert.match(item.toolUseID, /^(hook-)?[a-f0-9-]{36}$/)
  item.toolUseID = item.toolUseID.startsWith('hook-') ? 'hook-<uuid>' : '<uuid>'
  if (Object.hasOwn(item, 'durationMs')) { assert.ok(Number.isFinite(item.durationMs) && item.durationMs >= 0); item.durationMs = 0 }
  return body
}
for (const row of oracle.cases) test(`MCP prompt artifacts match the independent native ${row.mode} capture without a command execution record`, async () => {
  const registration: Registration = { id: 'mcp', sourceID: 'source', sourceDigest: 'a'.repeat(64), dialect: 'claude-code', event: 'UserPromptSubmit', groupIndex: 0, handlerIndex: 0, handler: { type: 'mcp_tool', server: 'fixture', tool: 'check', input: { value: 'OWNED_MCP_INPUT' } } }
  let calls = 0
  const result = await executeRegistration(registration, { host: 'v1', event: 'UserPromptSubmit', sessionID: 'session', cwd: process.cwd(), data: { prompt: 'MCP_SOURCE', transcript_path: '/unused', permission_mode: 'default' } }, { projectRoot: process.cwd(), environment: {}, captureMcpArtifacts: true, captureCommandArtifacts: true, mcp: { timeoutAccounting: 'wall', execute: async request => { calls++; assert.equal(request.server, 'fixture'); assert.equal(request.tool, 'check'); assert.deepEqual(request.input, { value: 'OWNED_MCP_INPUT' }); return { text: row.stdout, isError: row.isError, sourceToolNamespace: 'fixture' } } } })
  assert.equal(calls, 1); assert.equal(result.status, row.isError ? 'failed' : 'success'); assert.equal('commandArtifact' in result, false)
  assert.ok(result.status === 'success' || result.status === 'failed'); assert.ok(result.mcpArtifact)
  const entry = { sourceID: registration.sourceID, sourceDigest: registration.sourceDigest!, registrationID: registration.id, dialect: registration.dialect, configuredOrder: 0, completionOrder: 0, result }, { result: _result, ...origin } = entry
  const dispatched: DispatchResult = { entries: [entry], actions: result.actions.map(action => ({ ...origin, action })), cancelled: false, diagnostic: { dispatchID: 'dispatch', sessionID: 'session', event: 'UserPromptSubmit', durationMs: 1, cancelled: false, failed: row.isError ? 1 : 0, unsupported: 0, skipped: 0, background: 0, handlers: [] } }
  const records = claudePromptAttachments({ sessionID: 'session', event: 'UserPromptSubmit' }, dispatched)
  assert.deepEqual(records.map(record => normalize(record.body)), row.bodies)
  assert.ok(records.every(record => record.handler === 'mcp_tool'))
  if (['stdout', 'empty'].includes(row.mode)) assert.deepEqual(result.actions.filter(action => action.kind === 'context').map(action => action.text), ['UserPromptSubmit completed'])
  if (row.mode === 'plain') {
    const proof = result.mcpArtifact
    for (const [change, code] of [
      [{ mcpArtifact: { ...proof, server: '' } }, 'TRANSCRIPT_HOOK_EXECUTION_UNAVAILABLE'],
      [{ mcpArtifact: { ...proof, completedAt: NaN } }, 'TRANSCRIPT_HOOK_EXECUTION_UNAVAILABLE'],
      [{ mcpArtifact: { ...proof, status: 'tool-error' as const } }, 'TRANSCRIPT_HOOK_EXECUTION_UNAVAILABLE'],
      [{ mcpArtifact: { ...proof, sourceToolNamespace: 'foreign' } }, 'TRANSCRIPT_HOOK_EFFECT_UNSUPPORTED'],
      [{ httpArtifact: { kind: 'http' as const, completedAt: proof.completedAt, durationMs: 1 } }, 'TRANSCRIPT_HOOK_EXECUTION_UNAVAILABLE'],
    ] as const) assert.throws(() => claudePromptAttachments({ sessionID: 'session', event: 'UserPromptSubmit' }, { ...dispatched, entries: [{ ...entry, result: { ...result, ...change } }] }), { code })
    const { mcpArtifact: _proof, ...missing } = result
    assert.throws(() => claudePromptAttachments({ sessionID: 'session', event: 'UserPromptSubmit' }, { ...dispatched, entries: [{ ...entry, result: missing }] }), { code: 'TRANSCRIPT_HOOK_EXECUTION_UNAVAILABLE' })
  }
  if (row.mode === 'stdout' || row.isError) {
    const { handler: _handler, ...unmarked } = records[0]!
    assert.throws(() => nativeHookRecord(unmarked, 'UserPromptSubmit'), { code: 'SESSION_SNAPSHOT_SCHEMA_INVALID' })
    const changed = JSON.parse(JSON.stringify(records[0])); changed.body.attachment.exitCode = 0
    assert.throws(() => nativeHookRecord(changed, 'UserPromptSubmit'), { code: 'SESSION_SNAPSHOT_SCHEMA_INVALID' })
  }
})
