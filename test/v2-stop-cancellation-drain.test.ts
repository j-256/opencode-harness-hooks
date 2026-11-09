import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { V2StopBridge } from '../src/hosts/v2-stop.js'
import { HostHookError } from '../src/hosts/tools.js'
import { Sessions } from '../src/sessions.js'
import { PromptContexts } from '../src/prompt-contexts.js'
import type { TranscriptService } from '../src/transcript.js'

function latch() {
  let resolve!: () => void
  return { promise: new Promise<void>(done => { resolve = done }), resolve: () => resolve() }
}

for (const superseded of [false, true]) test(`a later real model waits for captured Stop settlement with superseded waiter ${superseded}`, async t => {
  const sessions = new Sessions(), contexts = new PromptContexts()
  sessions.prompt('session', 'original')
  const owner = sessions.get('session')
  contexts.remember(owner, ['Original'], [])
  const ready = latch(), started = latch(), interrupt = latch(), interrupted = latch(), release = latch()
  const rows = [{ type: 'user', id: 'original', text: 'Original', time: { created: 1 } }, { type: 'assistant', id: 'answer', model: { id: 'fixture' }, finish: 'stop', time: { created: 2 }, content: [{ type: 'text', text: 'Answer' }] }]
  const bridge = new V2StopBridge({
    directory: tmpdir(), contexts,
    runtime: { sessions, stop: async () => { started.resolve(); await release.promise; throw new HostHookError('HOST_STOP_CANCELLED', 'cancelled') } },
    transcripts: { prepare: async () => tmpdir(), admitStopInterruption: () => ({ reminders: [], feedback: [], interrupted: true }) } as unknown as TranscriptService,
    history: async id => ({ id, messages: rows }), synthetic: async () => assert.fail('Unadmitted Stop must not submit feedback'),
    subscribe: async function* ({ signal }) {
      let seq = 0
      const event = (type: string, data: Record<string, unknown> = {}) => ({ type: 'session.' + type, id: 'event-' + ++seq, created: seq, durable: { aggregateID: 'session', seq, version: 1 }, data: { sessionID: 'session', ...data } })
      yield event('inbox.enqueued', { inboxID: 'original', item: { type: 'user', payload: { text: 'Original', files: [] }, delivery: 'steer' } })
      yield event('execution.started')
      yield event('inbox.delivered', { inboxID: 'original' })
      ready.resolve()
      await interrupt.promise
      yield event('execution.interrupted', { reason: 'user' })
      interrupted.resolve()
      if (!signal.aborted) await new Promise<void>(done => signal.addEventListener('abort', () => done(), { once: true }))
    },
  })
  t.after(async () => { release.resolve(); interrupt.resolve(); sessions.dispose(); contexts.dispose(); await bridge.dispose() })
  bridge.accept(owner, 'Original')
  await ready.promise
  const idle = bridge.idle({ sessionID: 'session', background: [] })
  await started.promise
  interrupt.resolve()
  await interrupted.promise
  sessions.prompt('session', 'next')
  const next = sessions.get('session')
  contexts.remember(next, ['Next'], [])
  bridge.accept(next, 'Next')
  let settled = false
  const messages = [{ id: 'original', role: 'user', content: [{ type: 'text', text: 'Original' }] }, { id: 'answer', role: 'assistant', content: [{ type: 'text', text: 'Answer' }] }, { id: 'next', role: 'user', content: [{ type: 'text', text: 'Next' }] }]
  const context = bridge.context(next, messages).finally(() => { settled = true })
  try {
    await new Promise<void>(done => setImmediate(done))
    assert.equal(settled, false)
    if (superseded) {
      sessions.prompt('session', 'third')
      await assert.rejects(context, { code: 'HOST_STOP_CANCELLED', outcome: 'cancelled' })
      assert.equal(sessions.get('session').turnID, 'third')
      assert.equal(sessions.get('session').turnSignal.aborted, false)
    }
  } finally { release.resolve() }
  await idle
  if (!superseded) {
    await context
    bridge.guard(next)
    assert.equal(next.turnSignal.aborted, false)
  }
})
