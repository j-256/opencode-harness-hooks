import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { claudeBackgroundArtifact } from '../src/background-artifacts.js'
import type { BackgroundDelivery } from '../src/background-types.js'
import { EXECUTION_LIMITS } from '../src/runner.js'

interface Capture { name: string; stdout: string; stderr: string; exitCode: number; response: unknown; rendered: string[]; renderedRole: string | null }
const oracle = JSON.parse(readFileSync(new URL('./fixtures/claude-background-artifacts-oracle.json', import.meta.url), 'utf8')) as { cases: Capture[] }
function delivery(row: Capture): BackgroundDelivery {
  return { id: 'job', sourceID: 'native', sourceDigest: 'reviewed-source', registrationID: 'hook', dialect: 'claude-code', event: 'UserPromptSubmit', mode: 'safe-point', actions: [], completion: { completedAt: 1700000000000, execution: { status: 'exited', exitCode: row.exitCode, signal: null, stdout: row.stdout, stderr: row.stderr, durationMs: 1, processID: 12345 } } }
}

test('background artifact sanitation and rendering match each captured native completion independently of model actions', () => {
  for (const row of oracle.cases) {
    const result = claudeBackgroundArtifact(delivery(row))
    if (row.response === null) { assert.equal(result, undefined, row.name); continue }
    assert.ok(result, row.name)
    const body = JSON.parse(JSON.stringify(result.body))
    assert.deepEqual(body, { type: 'attachment', attachment: { type: 'async_hook_response', processId: 'async_hook_12345', hookName: 'UserPromptSubmit', hookEvent: 'UserPromptSubmit', response: row.response, stdout: row.stdout, stderr: row.stderr, exitCode: row.exitCode }, ...(row.rendered.length ? { rendered: row.rendered.map(content => ({ content })), renderedRole: row.renderedRole } : {}) }, row.name)
    assert.deepEqual(result.model, row.rendered, row.name); assert.equal(result.created, 1700000000000)
    assert.ok(Object.isFrozen(result.body)); assert.ok(Object.isFrozen(result.model))
  }
})

test('cancelled work, wake output and Codex completions cannot produce an ordinary Claude artifact', () => {
  const row = oracle.cases.find(row => row.name === 'pretty')!, input = delivery(row)
  assert.equal(claudeBackgroundArtifact({ ...input, dialect: 'codex' }), undefined)
  assert.equal(claudeBackgroundArtifact({ ...input, mode: 'wake' }), undefined)
  assert.equal(claudeBackgroundArtifact({ ...input, completion: { ...input.completion!, execution: { ...input.completion!.execution, status: 'cancelled' } } }), undefined)
})

test('recognized artifact output requires owned process and completed execution metadata without inventing identifiers', () => {
  const input = delivery(oracle.cases[0]!)
  const { processID: _processID, ...execution } = input.completion!.execution
  assert.throws(() => claudeBackgroundArtifact({ ...input, completion: { ...input.completion!, execution } }), { code: 'BACKGROUND_ARTIFACT_IDENTITY_UNAVAILABLE' })
  assert.throws(() => claudeBackgroundArtifact({ ...input, completion: { ...input.completion!, completedAt: NaN } }), { code: 'BACKGROUND_ARTIFACT_METADATA_INVALID' })
})

test('artifact capture bounds the combined raw execution streams before retaining them', () => {
  const input = delivery(oracle.cases[0]!)
  assert.throws(() => claudeBackgroundArtifact({ ...input, completion: { ...input.completion!, execution: { ...input.completion!.execution, stderr: 'x'.repeat(EXECUTION_LIMITS.outputBytes) } } }), { code: 'BACKGROUND_ARTIFACT_LIMIT' })
})
