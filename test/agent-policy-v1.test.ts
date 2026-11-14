import assert from 'node:assert/strict'
import { test } from 'node:test'
import { inheritAgentPolicy } from '../src/hosts/agent-policy-v1.js'

function request(permission: unknown, parent: Record<string, unknown> = { agent: 'restricted' }, tools?: Record<string, boolean>) {
  return { directory: '/owned/project', signal: new AbortController().signal, parent, ...(tools ? { tools } : {}), client: { app: { agents: async () => ({ data: [{ name: 'restricted', permission }] }) } } }
}

test('child policies preserve resolved caller-agent denies and retain the readonly hook gate', async () => {
  const rules = await inheritAgentPolicy(request([{ permission: '*', pattern: '*', action: 'allow' }, { permission: 'bash', pattern: 'rm *', action: 'deny' }]))
  assert.ok(rules.some(rule => rule.permission === 'bash' && rule.pattern === 'rm *' && rule.action === 'deny'))
  assert.ok(rules.some(rule => rule.permission === '*' && rule.action === 'ask'))
  assert.ok(rules.some(rule => rule.permission === 'read' && rule.action === 'allow'))
  assert.equal(rules.some(rule => rule.permission === 'bash' && rule.action === 'allow'), false)
  assert.deepEqual(rules.at(-1), { permission: 'harness_hook_verdict', pattern: '*', action: 'allow' })
})

test('parent session restrictions and a current message tool mask follow the host replacement boundary', async () => {
  const parent = { agent: 'restricted', permission: [{ permission: 'read', pattern: '*', action: 'deny' }] }
  const saved = await inheritAgentPolicy(request([{ permission: '*', pattern: '*', action: 'allow' }], parent))
  assert.ok(saved.some(rule => rule.permission === 'read' && rule.action === 'deny'))
  const current = await inheritAgentPolicy(request([{ permission: '*', pattern: '*', action: 'allow' }], parent, { read: true, bash: false }))
  assert.equal(current.some(rule => rule.permission === 'read' && rule.action === 'deny'), false)
  assert.ok(current.some(rule => rule.permission === 'bash' && rule.action === 'deny'))
})

test('policy lookup rejects an unobserved actor, malformed rules and missing public SDK capability', async () => {
  await assert.rejects(inheritAgentPolicy({ ...request([]), agent: 'foreign' }), { code: 'HOST_AGENT_PERMISSION_POLICY_UNAVAILABLE' })
  await assert.rejects(inheritAgentPolicy(request([{ permission: '*', pattern: '*', action: 'invalid' }])), { code: 'HOST_AGENT_PERMISSION_POLICY_UNAVAILABLE' })
  await assert.rejects(inheritAgentPolicy({ ...request([]), client: undefined }), { code: 'HOST_AGENT_PERMISSION_POLICY_UNAVAILABLE' })
})

test('hook agents cannot delegate new inference sessions or open interactive questions', async () => {
  const rules = await inheritAgentPolicy(request([{ permission: '*', pattern: '*', action: 'allow' }]))
  for (const permission of ['task', 'question']) {
    const decision = rules.filter(rule => rule.permission === '*' || rule.permission === permission).at(-1)?.action
    assert.equal(decision, 'deny', permission)
  }
})
