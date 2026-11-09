import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { interpretOutput } from '../src/protocol.js'
import type { ExecutionResult } from '../src/runner.js'
import type { Registration } from '../src/types.js'
import { CONTRACT_VERSIONS } from '../src/contracts.js'

test('Claude prompt interpretation preserves the independently observed native context channels and blocking', async () => {
  const oracle = JSON.parse(await readFile(new URL('fixtures/claude-prompt-oracle.json', import.meta.url), 'utf8'))
  assert.equal(oracle.contractVersion, CONTRACT_VERSIONS['claude-code'])
  const registration: Registration = { id: 'fixture:UserPromptSubmit:0:0', sourceID: 'fixture', dialect: 'claude-code', event: 'UserPromptSubmit', groupIndex: 0, handlerIndex: 0, handler: { type: 'command', command: 'fixture' } }
  for (const row of oracle.cases) {
    const result: ExecutionResult = { status: 'exited', exitCode: 0, signal: null, stdout: typeof row.output === 'string' ? row.output : JSON.stringify(row.output), stderr: '', durationMs: 1 }
    const effect = interpretOutput(registration, { event: 'UserPromptSubmit', sessionID: 'session', cwd: '/project' }, result)
    assert.equal(effect.status, 'success')
    if (row.native.modelCalled) {
      assert.deepEqual(effect.actions.filter(action => action.kind === 'context'), [{ kind: 'context', placement: 'model', channel: row.native.channel, text: row.native.text }])
      assert.deepEqual(effect.actions.filter(action => action.kind === 'warning'), row.native.warning ? [{ kind: 'warning', text: row.native.warning }] : [])
    } else {
      assert.ok(effect.actions.some(action => action.kind === 'block-event' && action.reason === row.output.reason))
      assert.equal(effect.actions.some(action => action.kind === 'context'), false)
    }
  }
})
