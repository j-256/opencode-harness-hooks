import assert from 'node:assert/strict'
import { test } from 'node:test'
import { StartupRecords } from '../src/startup-records.js'
import { Sessions } from '../src/sessions.js'
import { PromptContexts } from '../src/prompt-contexts.js'
import { CodexTranscript } from '../src/codex-transcript.js'
import { HostHookError } from '../src/host-errors.js'
import { V1Startups } from '../src/hosts/startup-v1.js'
import type { TranscriptService } from '../src/transcript.js'
import type { SessionStartDelivery } from '../src/session-start.js'

function fixture(t: { after: (callback: () => Promise<void>) => void }, failure?: 'codex' | 'environment') {
  const sessions = new Sessions(), records = new StartupRecords(), contexts = new PromptContexts()
  const codex = new CodexTranscript({ host: 'v1', directory: '/project', history: async () => ({ id: 'session', messages: [] }) })
  const transcripts = {
    prepare: async () => '/artifacts/claude.jsonl',
    admitStart: (delivery: SessionStartDelivery) => records.admit(delivery),
    revokeStart: (...args: Parameters<StartupRecords['revoke']>) => records.revoke(...args),
    bindStart: (...args: Parameters<StartupRecords['bind']>) => records.bind(...args),
    unbindStart: (...args: Parameters<StartupRecords['unbind']>) => records.unbind(...args),
  } as unknown as TranscriptService
  if (failure === 'codex') codex.rememberStart = () => { throw new HostHookError('CODEX_TRANSCRIPT_INPUT_LIMIT', 'unsupported') }
  const startup = new V1Startups({ directory: '/project', client: { session: { get: async () => ({ data: { id: 'session' } }), messages: async () => ({ data: [] }) } } }, transcripts, codex, { host: { environment: { HOME: '/isolated' } } })
  const runtime = {
    hasStartHooks: true,
    report: { sources: ['claude-code', 'codex'].map(dialect => ({ enabled: true, dialect, events: ['SessionStart'] })) },
    sessions,
    start: async (event: SessionStartDelivery['event']) => {
      const session = sessions.get('session')
      const entry = { sourceID: 'source', sourceDigest: 'a'.repeat(64), registrationID: 'registration', dialect: 'claude-code' as const, configuredOrder: 0, completionOrder: 0, result: { status: 'success' as const, code: 'OK', actions: [{ kind: 'context' as const, placement: 'model' as const, channel: 'stdout' as const, text: 'START' }], commandArtifact: { status: 'exited' as const, exitCode: 0, signal: null, stdout: 'START\n', stderr: '', command: 'fixture', durationMs: 1, completedAt: Date.now(), timeoutMs: 5000 }, diagnostic: { sourceID: 'source', registrationID: 'registration', dialect: 'claude-code' as const, event: 'SessionStart', code: 'OK', outcome: 'success' as const, durationMs: 1 } } }
      await startup.service.admit({ event, session, signal: session.signal, ...(failure === 'environment' ? { environment: { files: [{ registrationID: 'invalid', path: 'relative.sh' }], registrationContext: {} } } : {}), dispatch: { entries: [entry], actions: [], cancelled: false, diagnostic: { dispatchID: 'dispatch', sessionID: 'session', event: 'SessionStart', cancelled: false, durationMs: 1, failed: 0, unsupported: 0, skipped: 0, background: 0, handlers: [] } } })
    },
  }
  startup.attach(runtime as unknown as Parameters<V1Startups['attach']>[0])
  t.after(async () => { sessions.dispose(); records.dispose(); contexts.dispose(); await startup.dispose(); await codex.dispose() })
  return { sessions, records, contexts, codex, startup }
}

for (const failure of ['codex', 'environment'] as const) test(`coordinator rolls back every consumer when ${failure} startup admission fails`, async t => {
  const f = fixture(t, failure)
  await assert.rejects(f.startup.ensure(f.sessions.get('session')), { code: failure === 'codex' ? 'CODEX_TRANSCRIPT_INPUT_LIMIT' : 'HOST_ENVIRONMENT_PLAN_INVALID' })
  assert.deepEqual(f.records.read('session'), [])
  assert.equal(f.codex.inspect().startupBatches, 0)
  assert.equal(f.contexts.inspect().prompts, 0)
})

test('failed model-context binding rolls back native bindings and withdraws the unsaved prompt', async t => {
  const f = fixture(t)
  f.sessions.prompt('session', 'failed', 'fixture')
  await f.startup.ensure(f.sessions.get('session'))
  f.contexts.remember(f.sessions.get('session'), ['Failed'], [])
  const remember = f.contexts.rememberStartup.bind(f.contexts)
  f.contexts.rememberStartup = () => { throw new HostHookError('HOST_PROMPT_CONTEXT_LIMIT', 'unsupported') }
  assert.throws(() => f.startup.bind(f.sessions.get('session'), f.contexts), { code: 'HOST_PROMPT_CONTEXT_LIMIT' })
  assert.deepEqual(f.records.beforePrompt('session', 'failed'), [])
  assert.equal(f.codex.inspect().startupBindings, 0)
  assert.equal(f.contexts.inspect().prompts, 0)
  f.contexts.rememberStartup = remember
  f.sessions.prompt('session', 'accepted', 'fixture')
  f.contexts.remember(f.sessions.get('session'), ['Accepted'], [])
  f.startup.bind(f.sessions.get('session'), f.contexts)
  assert.equal(f.records.beforePrompt('session', 'accepted').length, 1)
  assert.equal(f.codex.inspect().startupBindings, 1)
  f.contexts.layout(f.sessions.get('session'), [{ id: 'accepted', text: ['Accepted'] }])
  assert.ok(f.contexts.issue(f.sessions.get('session')))
})
