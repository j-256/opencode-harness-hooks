import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { compareRewakeEvidence, rewakeArtifactEvidence, rewakeModelEvidence } from '../scripts/lib/conformance-rewake.mjs'

const complete = delivery => ({ delivery, done: true, modelCalls: 3, sourceCalls: 6, notificationCallbacks: 1, backgroundEmissions: 1, sessionOwned: true, promptOwned: true, rawPrompt: true, artifactsOwned: true, historyOwned: true, originalResults: true, modelViews: [{ carrier: 'none', notification: false, context: false, ordered: true, copies: 0 }, ...Array.from({ length: 2 }, () => ({ carrier: delivery === 'active' ? 'tool:one' : 'system:user', notification: true, context: true, ordered: true, copies: 1 }))] })

for (const delivery of ['active', 'idle']) test(`independent ${delivery} wake evidence rejects equally wrong or incomplete observations`, async () => {
  const compare = compareRewakeEvidence, good = complete(delivery)
  assert.equal(compare(delivery, good, structuredClone(good)).status, 'passed')
  for (const mutation of [
    row => { row.done = false },
    row => { row.sourceCalls++ },
    row => { row.notificationCallbacks++ },
    row => { row.backgroundEmissions++ },
    row => { row.promptOwned = false },
    row => { row.sessionOwned = false },
    row => { row.rawPrompt = false },
    row => { row.artifactsOwned = false },
    row => { row.historyOwned = false },
    row => { row.originalResults = false },
    row => { row.modelViews[0].notification = true },
    row => { row.modelViews[1].carrier = 'user:unowned' },
    row => { row.modelViews[1].ordered = false },
    row => { row.modelViews[2].copies++ },
    row => { row.modelViews.pop() },
  ]) {
    const bad = structuredClone(good); mutation(bad)
    assert.equal(compare(delivery, good, bad).status, 'failed')
    assert.equal(compare(delivery, bad, structuredClone(bad)).status, 'failed')
  }
  assert.equal(compare(delivery, good, { ...good, unexpected: true }).status, 'failed')
})

test('model evidence checks exact independent notification bytes, owned carriers, ordering and duplicate copies', async () => {
  const oracle = JSON.parse(await readFile(new URL('./fixtures/claude-wake-oracle.json', import.meta.url), 'utf8')).cases.find(row => row.name === 'plain')
  const content = 'REWAKE_RESULT_1\n' + oracle.model + '\nREWAKE_CALLBACK'
  const expected = { carrier: 'tool:one', notification: true, context: true, ordered: true, copies: 1 }
  for (const row of [
    { role: 'tool', tool_call_id: 'toolu_rewake_one', content },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_rewake_one', content }] },
  ]) assert.deepEqual(rewakeModelEvidence([row], oracle.model), expected)
  assert.deepEqual(rewakeModelEvidence([{ role: 'user', content: [{ type: 'text', text: 'REWAKE_CALLBACK' }, { type: 'text', text: oracle.model }] }], oracle.model), { ...expected, carrier: 'system:user' })
  assert.equal(rewakeModelEvidence([{ role: 'tool', tool_call_id: 'toolu_rewake_two', content }], oracle.model).carrier, 'tool:other')
  assert.equal(rewakeModelEvidence([{ role: 'tool', tool_call_id: 'toolu_rewake_one', content: content.replace('automated background-task', 'changed background-task') }], oracle.model).notification, false)
  assert.equal(rewakeModelEvidence([{ role: 'tool', tool_call_id: 'toolu_rewake_one', content: 'REWAKE_CALLBACK\n' + oracle.model }], oracle.model).ordered, false)
  assert.equal(rewakeModelEvidence([{ role: 'tool', tool_call_id: 'toolu_rewake_one', content: content + content }], oracle.model).copies, 2)
  assert.equal(rewakeModelEvidence([{ role: 'developer', content }], oracle.model).carrier, 'unowned')
})

test('native artifact evidence rejects moved, repeated, corrupted and foreign notification records', async () => {
  const oracle = JSON.parse(await readFile(new URL('./fixtures/claude-wake-oracle.json', import.meta.url), 'utf8')).cases.find(row => row.name === 'plain')
  const journal = [{ type: 'user', uuid: 'result', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_rewake_one', content: 'REWAKE_RESULT_1' }] } }, { ...oracle.queuedBody, uuid: 'wake', parentUuid: 'result' }]
  assert.equal(rewakeArtifactEvidence(journal, 'active', oracle), true)
  for (const mutation of [
    value => { value[0].message.content[0].tool_use_id = 'toolu_rewake_two' },
    value => { value[1].parentUuid = 'missing' },
    value => { value[1].parentUuid = 'wake' },
    value => { value[1].attachment.origin.producer = 'user' },
    value => { value[1].attachment.source_uuid = 'unowned' },
    value => { value[1].attachment.timestamp = 'not a timestamp' },
    value => { value[1].rendered[0].content += 'changed' },
    value => { value.push(structuredClone(value[1])) },
  ]) { const wrong = structuredClone(journal); mutation(wrong); assert.equal(rewakeArtifactEvidence(wrong, 'active', oracle), false) }
  const system = { type: 'user', promptId: 'notification', message: { role: 'user', content: oracle.prompt }, origin: { kind: 'task-notification', producer: 'session-task' }, promptSource: 'system', turnOrigin: 'task_notification', queueSkipAttachments: true, turnPosition: { promptIndex: 0, turnIndex: 2 } }
  assert.equal(rewakeArtifactEvidence([system], 'idle', oracle, { promptID: 'notification' }), true)
  assert.equal(rewakeArtifactEvidence([system], 'idle', oracle, { promptID: 'foreign' }), false)
  assert.equal(rewakeArtifactEvidence([{ ...system, turnPosition: { promptIndex: 1, turnIndex: 2 } }], 'idle', oracle, { promptID: 'notification' }), false)
  assert.equal(rewakeArtifactEvidence([{ ...system, turnPosition: { promptIndex: 0, turnIndex: 3 } }], 'idle', oracle, { promptID: 'notification' }), false)
})
