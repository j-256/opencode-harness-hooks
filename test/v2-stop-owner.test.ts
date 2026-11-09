import assert from 'node:assert/strict'
import { test } from 'node:test'
import { V2StopBridge } from '../src/hosts/v2-stop.js'
import { HostHookError } from '../src/hosts/tools.js'
import { Sessions } from '../src/sessions.js'
import { PromptContexts } from '../src/prompt-contexts.js'

test('a replaced Stop attempt cannot change an earlier known interruption outcome while cancellation drains', async () => {
  const sessions = new Sessions(), contexts = new PromptContexts()
  sessions.prompt('session', 'original')
  let entered!: () => void, interrupted!: () => void, release!: () => void
  const started = new Promise<void>(resolve => { entered = resolve }), receipt = new Promise<void>(resolve => { interrupted = resolve }), waiting = new Promise<void>(resolve => { release = resolve })
  const messages: unknown[] = [{ type: 'user', id: 'original', text: 'Original' }, { type: 'assistant', id: 'answer', finish: 'stop', content: [{ type: 'text', text: 'Answer' }] }]
  let stops = 0
  const bridge = new V2StopBridge({
    directory: '/fixture', contexts,
    runtime: { sessions, stop: async () => { if (!stops++) { entered(); await waiting; throw new HostHookError('HOST_STOP_CANCELLED', 'cancelled') } throw new HostHookError('HOST_STOP_OVERLAP', 'unsupported') } },
    history: async () => ({ id: 'session', messages }), synthetic: async () => { throw new Error('Unexpected synthetic input') },
    transcripts: { prepare: async () => '/fixture/transcript', observe: () => {}, dispose: async () => {}, admitStopInterruption: (event, owner) => { assert.equal(event.completionID, 'answer'); assert.equal(owner.turnID, 'original'); assert.equal(owner.turnSignal.aborted, true); interrupted(); return { reminders: [], feedback: [], interrupted: true } } },
    subscribe: async function* ({ signal }) {
      const event = (type: string, seq: number, data = {}) => ({ id: 'event-' + seq, type: 'session.' + type, created: seq, durable: { aggregateID: 'session', seq, version: 1 }, data: { sessionID: 'session', ...data } })
      yield event('inbox.enqueued', 1, { inboxID: 'original', item: { type: 'user', payload: { text: 'Original' }, delivery: 'steer' } })
      yield event('execution.started', 2)
      yield event('inbox.delivered', 4, { inboxID: 'original' })
      await started
      yield event('execution.interrupted', 13, { reason: 'user' })
      if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
    },
  })
  bridge.accept(sessions.get('session'), 'Original')
  const original = bridge.idle({ sessionID: 'session', background: [] })
  try {
    await receipt
    sessions.prompt('session', 'next')
    bridge.accept(sessions.get('session'), 'Next')
    messages.push({ type: 'user', id: 'next', text: 'Next' }, { type: 'assistant', id: 'next-answer', finish: 'stop', content: [{ type: 'text', text: 'Next answer' }] })
    await assert.rejects(bridge.idle({ sessionID: 'session', background: [] }), { code: 'HOST_STOP_OVERLAP' })
    release()
    await assert.doesNotReject(original)
  } finally { release(); await bridge.dispose(); sessions.dispose(); contexts.dispose() }
})
