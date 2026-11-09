import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CallApprovals } from '../src/hosts/permissions.js'
import type { HostToolEvent } from '../src/hosts/tools.js'
import { Sessions } from '../src/sessions.js'

function scope(host: 'v1' | 'v2') {
  const sessions = new Sessions()
  sessions.prompt('session', 'turn', 'model')
  const controller = new AbortController()
  const event: HostToolEvent = { host, event: 'PreToolUse', sessionID: 'session', callID: 'call', tool: host === 'v1' ? 'bash' : 'shell', ...(host === 'v2' ? { messageID: 'message', agent: 'build' } : {}), toolInput: { command: 'original' }, effectiveInput: { command: 'effective' }, signal: controller.signal }
  return { sessions, controller, event }
}
const request = (id: string) => ({ id, sessionID: 'session', permission: 'bash', tool: { callID: 'call', messageID: 'message' } })

test('V1 replies once to each owned request while leaving unrelated calls and sessions untouched', async t => {
  const s = scope('v1')
  const approvals = new CallApprovals()
  t.after(() => approvals.dispose())
  t.after(() => s.sessions.dispose())
  approvals.remember(s.event, s.sessions.get('session'))
  const observed: unknown[] = []
  const reply = async (input: { readonly sessionID: string; readonly requestID: string; readonly signal: AbortSignal }) => { observed.push({ sessionID: input.sessionID, requestID: input.requestID }) }
  await approvals.replyV1(request('one'), reply)
  await approvals.replyV1(request('one'), reply)
  await approvals.replyV1(request('two'), reply)
  await approvals.replyV1({ ...request('foreign-session'), sessionID: 'other' }, reply)
  await approvals.replyV1({ ...request('foreign-call'), tool: { callID: 'other', messageID: 'message' } }, reply)
  await approvals.replyV1({ ...request('foreign-message'), tool: { callID: 'call', messageID: 'other' } }, reply)
  await approvals.replyV1({ ...request('missing-owner'), tool: undefined }, reply)
  assert.deepEqual(observed, [{ sessionID: 'session', requestID: 'one' }, { sessionID: 'session', requestID: 'two' }])
  assert.equal(approvals.inspect().replies, 2)
  assert.ok(!JSON.stringify(approvals.inspect()).includes('effective'))
})

test('V2 changes only an owned ask evaluation and preserves denials and foreign identities', async t => {
  const s = scope('v2')
  const approvals = new CallApprovals()
  t.after(() => approvals.dispose())
  t.after(() => s.sessions.dispose())
  approvals.remember(s.event, s.sessions.get('session'))
  const base = { sessionID: 'session', agent: 'build', action: 'shell', resources: ['command'], source: { type: 'tool' as const, id: 'call', messageID: 'message' }, effect: 'ask' as 'ask' | 'allow' | 'deny' }
  const allowed = structuredClone(base)
  approvals.applyV2(allowed)
  assert.equal(allowed.effect, 'allow')
  for (const changes of [
    { effect: 'deny' as const }, { sessionID: 'other' }, { agent: 'other' }, { source: { ...base.source, id: 'other' } }, { source: { ...base.source, messageID: 'other' } }, { source: undefined },
  ]) {
    const input = { ...base, ...changes }
    const expected = input.effect
    approvals.applyV2(input)
    assert.equal(input.effect, expected)
  }
  assert.equal(approvals.inspect().evaluations, 1)
})

test('V1 captures the validated request identity before asynchronous reply work starts', async t => {
  const s = scope('v1')
  const approvals = new CallApprovals()
  t.after(() => approvals.dispose())
  t.after(() => s.sessions.dispose())
  approvals.remember(s.event, s.sessions.get('session'))
  const input = request('owned')
  let requestID = ''
  const pending = approvals.replyV1(input, async value => { requestID = value.requestID })
  input.id = 'foreign'
  input.sessionID = 'foreign-session'
  await pending
  assert.equal(requestID, 'owned')
})

test('turn changes and completed calls remove preapproval without affecting another call', async t => {
  const s = scope('v2')
  const approvals = new CallApprovals()
  t.after(() => approvals.dispose())
  t.after(() => s.sessions.dispose())
  approvals.remember(s.event, s.sessions.get('session'))
  s.controller.abort()
  assert.equal(approvals.inspect().grants, 0)
  const next = { ...s.event, callID: 'next', signal: new AbortController().signal }
  approvals.remember(next, s.sessions.get('session'))
  s.sessions.prompt('session', 'new-turn', 'model')
  const pending = { sessionID: 'session', action: 'shell', resources: [], source: { type: 'tool' as const, id: 'next', messageID: 'message' }, effect: 'ask' as 'ask' | 'allow' | 'deny' }
  approvals.applyV2(pending)
  assert.equal(pending.effect, 'ask')
  assert.equal(approvals.inspect().grants, 0)
})

test('invalid call ownership and duplicate grants fail before installing approval', async t => {
  const s = scope('v2')
  const approvals = new CallApprovals()
  t.after(() => approvals.dispose())
  t.after(() => s.sessions.dispose())
  for (const changes of [{ sessionID: 'other' }, { callID: '' }, { event: 'PostToolUse' as const }]) {
    assert.throws(() => approvals.remember({ ...s.event, ...changes }, s.sessions.get('session')), { code: 'HOST_PERMISSION_SOURCE_UNAVAILABLE' })
  }
  const missingMessage = { ...s.event }
  delete missingMessage.messageID
  assert.throws(() => approvals.remember(missingMessage, s.sessions.get('session')), { code: 'HOST_PERMISSION_SOURCE_UNAVAILABLE' })
  assert.equal(approvals.inspect().grants, 0)
  approvals.remember(s.event, s.sessions.get('session'))
  assert.throws(() => approvals.remember(s.event, s.sessions.get('session')), { code: 'HOST_PERMISSION_CALL_BUSY' })
  assert.equal(approvals.inspect().grants, 1)
})

test('bounded V1 requests fail without replying and release retention when the call ends', async t => {
  const s = scope('v1')
  const diagnostics: unknown[] = []
  const approvals = new CallApprovals({ diagnostic: input => { diagnostics.push(input) } })
  t.after(() => approvals.dispose())
  t.after(() => s.sessions.dispose())
  approvals.remember(s.event, s.sessions.get('session'))
  const limit = 4096
  let replies = 0
  for (let i = 0; i <= limit; i++) await approvals.replyV1(request(String(i)), async () => { replies++ })
  assert.equal(replies, limit)
  assert.equal(approvals.inspect().requests, limit)
  assert.match(JSON.stringify(diagnostics), /HOST_PERMISSION_REQUEST_LIMIT/)
  s.controller.abort()
  assert.equal(approvals.inspect().requests, 0)
  assert.equal(approvals.inspect().grants, 0)
  await approvals.replyV1(request('expired'), async () => { replies++ })
  assert.equal(replies, limit)
})

test('V1 reply failures are diagnosed without exception text or blind repeated replies', async t => {
  const s = scope('v1')
  const diagnostics: unknown[] = []
  const approvals = new CallApprovals({ diagnostic: value => { diagnostics.push(value); throw new Error('Observer secret') } })
  t.after(() => approvals.dispose())
  t.after(() => s.sessions.dispose())
  approvals.remember(s.event, s.sessions.get('session'))
  let calls = 0
  const reply = async () => { calls++; throw new Error('Reply secret') }
  await approvals.replyV1(request('failure'), reply)
  await approvals.replyV1(request('failure'), reply)
  assert.equal(calls, 1)
  assert.equal(approvals.inspect().failures, 1)
  assert.equal(approvals.inspect().observerFailures, 1)
  assert.equal(JSON.stringify(diagnostics).includes('secret'), false)
  assert.match(JSON.stringify(diagnostics), /HOST_PERMISSION_REPLY_FAILED/)
})

test('disposal cancels and drains an active V1 reply and prevents a late approval', { timeout: 3000 }, async () => {
  const s = scope('v1')
  const approvals = new CallApprovals()
  approvals.remember(s.event, s.sessions.get('session'))
  let entered!: () => void
  const ready = new Promise<void>(resolve => { entered = resolve })
  let signal: AbortSignal | undefined
  const pending = approvals.replyV1(request('pending'), async input => {
    signal = input.signal
    entered()
    return new Promise<void>(resolve => { input.signal.addEventListener('abort', () => resolve(), { once: true }) })
  })
  await ready
  await approvals.dispose()
  await pending
  assert.equal(signal?.aborted, true)
  assert.equal(approvals.inspect().replies, 0)
  assert.equal(approvals.inspect().grants, 0)
  assert.throws(() => approvals.remember(s.event, s.sessions.get('session')), { code: 'HOST_TOOL_CANCELLED' })
  s.sessions.dispose()
})
