import assert from 'node:assert/strict'
import { test } from 'node:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { V2StopBridge } from '../src/hosts/v2-stop.js'
import type { V2SyntheticInput } from '../src/hosts/v2-stop.js'
import { Sessions } from '../src/sessions.js'
import { PromptContexts } from '../src/prompt-contexts.js'
import type { StopDelivery } from '../src/stop.js'
import type { TranscriptService } from '../src/transcript.js'

const CREATED = Date.parse('2026-01-01T00:00:00Z')
const CONCURRENT_SESSIONS = 21
const ASSISTANT_BYTES = 775000

test('admitted feedback cancellation consumes its reserved history capacity under concurrent session pressure', async t => {
  const sessions = new Sessions(), contexts = new PromptContexts()
  const rows = new Map<string, any[]>(), inputs = new Map<string, V2SyntheticInput>()
  const queue: { raw: unknown; done: () => void }[] = []
  const sequences = new Map<string, number>()
  let wake: (() => void) | undefined
  const emit = (sessionID: string, type: string, data: Record<string, unknown> = {}) => {
    const seq = (sequences.get(sessionID) ?? 0) + 1
    sequences.set(sessionID, seq)
    return new Promise<void>(done => { queue.push({ raw: { id: sessionID + '-event-' + seq, type: 'session.' + type, created: CREATED + seq, durable: { aggregateID: sessionID, seq, version: 1 }, data: { sessionID, ...data } }, done }); wake?.() })
  }
  let interruptAdmitted = false, transcriptRetired = false
  const effects = { continuations: [{}], context: [], feedback: [], warnings: [], extensions: [], resultReplacements: [], unresolved: [] } as unknown as StopDelivery['effects']
  let bridge!: V2StopBridge
  bridge = new V2StopBridge({
    directory: tmpdir(), contexts,
    runtime: { sessions, stop: async event => {
      const session = sessions.get(event.sessionID)
      await bridge.admit({ session, event, effects, signal: session.turnSignal } as StopDelivery)
      return { host: 'v2', sessionID: event.sessionID, messageID: event.messageID, completionID: event.completionID, dispatchID: 'fixture', control: 'continue' }
    } },
    transcripts: {
      prepare: async () => join(tmpdir(), 'unused-transcript'), admitStop: () => ['Feedback'],
      reserveContinuation: () => ({ admit() {}, release() {} }),
      stopModelInput: () => ({ reminders: [], feedback: ['Feedback'] }),
      admitStopInterruption: () => { interruptAdmitted = true; return { reminders: [], feedback: ['Feedback'], interrupted: true } },
      retireStopContinuation: () => { transcriptRetired = true },
    } as unknown as TranscriptService,
    history: async id => ({ id, messages: rows.get(id)! }),
    synthetic: async input => {
      inputs.set(input.sessionID, input)
      return { id: input.id, sessionID: input.sessionID, type: 'synthetic', delivery: input.delivery, time: { created: CREATED + 3 }, payload: { text: input.text, description: input.description, metadata: input.metadata } }
    },
    subscribe: async function* ({ signal }) {
      const abort = () => wake?.()
      signal.addEventListener('abort', abort, { once: true })
      try {
        while (!signal.aborted) {
          if (!queue.length) await new Promise<void>(resolve => { wake = resolve })
          const item = queue.shift()
          if (item) { try { yield item.raw } finally { item.done() } }
        }
      } finally { signal.removeEventListener('abort', abort); for (const item of queue.splice(0)) item.done() }
    },
  })
  t.after(async () => { sessions.dispose(); contexts.dispose(); await bridge.dispose() })
  const text = 'x'.repeat(ASSISTANT_BYTES)
  for (let index = 0; index < CONCURRENT_SESSIONS; index++) {
    const id = 'session-' + index
    sessions.prompt(id, 'prompt')
    const owner = sessions.get(id)
    contexts.remember(owner, ['Original'], [])
    bridge.accept(owner, 'Original')
    rows.set(id, [{ type: 'user', id: 'prompt', text: 'Original', time: { created: CREATED } }, { type: 'assistant', id: 'answer', model: { id: 'fixture' }, finish: 'stop', time: { created: CREATED + 1 }, content: [{ type: 'text', text }] }])
    await emit(id, 'inbox.enqueued', { inboxID: 'prompt', item: { type: 'user', payload: { text: 'Original', files: [] }, delivery: 'steer' } })
    await emit(id, 'execution.started')
    await emit(id, 'inbox.delivered', { inboxID: 'prompt' })
    await bridge.idle({ sessionID: id, background: [] })
    const input = inputs.get(id)!
    rows.get(id)!.push({ type: 'synthetic', id: input.id, text: input.text, description: input.description, metadata: input.metadata, time: { created: CREATED + 3 } })
    await emit(id, 'inbox.enqueued', { inboxID: input.id, item: { type: 'synthetic', payload: { text: input.text, metadata: input.metadata }, delivery: 'steer' } })
    await emit(id, 'inbox.delivered', { inboxID: input.id })
    await bridge.context(owner, [])
  }
  const id = 'session-0', owner = sessions.get(id), model = { id: 'fixture', providerID: 'fixture' }, error = { type: 'aborted', message: 'Step interrupted' }
  await emit(id, 'step.started', { assistantMessageID: 'aborted', agent: 'build', model, started: CREATED + 6 })
  rows.get(id)!.push({ type: 'assistant', id: 'aborted', agent: 'build', model, time: { created: CREATED + 6, completed: CREATED + 7 }, finish: 'error', error, content: [] })
  await emit(id, 'step.failed', { assistantMessageID: 'aborted', error })
  await emit(id, 'execution.interrupted', { reason: 'user' })
  assert.equal(owner.turnSignal.aborted, true)
  sessions.prompt(id, 'next')
  const next = sessions.get(id)
  contexts.remember(next, ['Next'], [])
  bridge.accept(next, 'Next')
  rows.get(id)!.push({ type: 'user', id: 'next', text: 'Next', time: { created: CREATED + 9 } })
  const messages = rows.get(id)!.map(row => ({ id: row.id, role: row.type === 'assistant' ? 'assistant' : 'user', content: row.type === 'assistant' ? row.content : [{ type: 'text', text: row.text }] }))
  const filtered = await bridge.context(next, messages)
  assert.equal(interruptAdmitted, true)
  assert.equal(transcriptRetired, true)
  assert.deepEqual(filtered?.map((row: any) => row.id), ['prompt', 'answer', 'next'])
  assert.equal(next.turnSignal.aborted, false)
  bridge.guard(next)
})
