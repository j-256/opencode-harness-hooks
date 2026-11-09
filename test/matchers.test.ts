import assert from 'node:assert/strict'
import { test } from 'node:test'
import fc from 'fast-check'
import type { Dialect } from '../src/contracts.js'
import type { LoadedSource, NativeEvent, Registration } from '../src/types.js'

function source(dialect: Dialect, event: string, matcher?: string): LoadedSource {
  const registration: Registration = { id: dialect, sourceID: dialect, dialect, event, groupIndex: 0, handlerIndex: 0, handler: { type: 'command', command: 'never-run' }, ...(matcher !== undefined ? { matcher } : {}) }
  return { id: dialect, dialect, path: '/fixture/config', digest: 'fixture', enabled: true, registrations: [registration], excluded: [] }
}

const event: NativeEvent = { event: 'PreToolUse', sessionID: 'fixture', cwd: '/fixture', tool: 'read' }

test('native simple matchers use exact names and differ on comma and hyphen handling', async () => {
  const { matchesPattern } = await import('../src/matchers.js')
  for (const dialect of ['claude-code', 'codex'] as const) {
    assert.equal(matchesPattern(dialect, 'PreToolUse', 'Read', ['NotebookRead']), false)
    assert.equal(matchesPattern(dialect, 'PreToolUse', 'Read|Write', ['Write']), true)
    for (const pattern of [undefined, '', '*']) assert.equal(matchesPattern(dialect, 'PreToolUse', pattern, []), true)
  }
  assert.equal(matchesPattern('claude-code', 'PreToolUse', 'Edit, Write', ['Write']), true)
  assert.equal(matchesPattern('codex', 'PreToolUse', 'Edit, Write', ['Write']), false)
  assert.equal(matchesPattern('claude-code', 'SubagentStart', 'my-agent', ['prefix-my-agent']), false)
  assert.equal(matchesPattern('codex', 'SubagentStart', 'my-agent', ['prefix-my-agent']), true)
  assert.equal(matchesPattern('claude-code', 'StopFailure', 'rate-limit', ['prefix-rate-limit']), true)
})

test('uses the source regex engine including Rust Unicode and syntax restrictions', async () => {
  const { matchesPattern } = await import('../src/matchers.js')
  assert.equal(matchesPattern('codex', 'PreToolUse', '^\\w+$', ['café']), true)
  assert.equal(matchesPattern('claude-code', 'PreToolUse', '^\\w+$', ['café']), false)
  assert.equal(matchesPattern('codex', 'PreToolUse', '(?i)^bash$', ['Bash']), true)
  assert.equal(matchesPattern('claude-code', 'PreToolUse', '^Bash(?=$)', ['Bash']), true)
  for (const dialect of ['claude-code', 'codex'] as const) {
    assert.throws(() => matchesPattern(dialect, 'PreToolUse', '[SECRET_SENTINEL', ['Bash']), error => {
      assert.equal(String(error).includes('SECRET_SENTINEL'), false)
      return error instanceof Error && error.message === 'MATCHER_INVALID'
    })
  }
  assert.throws(() => matchesPattern('codex', 'PreToolUse', '^Bash(?=$)', ['Bash']), /MATCHER_INVALID/)
})

test('selects event-specific fields and ignores matchers on events without matcher support', async () => {
  const { selectRegistrations } = await import('../src/matchers.js')
  for (const dialect of ['claude-code', 'codex'] as const) {
    assert.equal(selectRegistrations([source(dialect, 'SessionStart', 'resume')], { ...event, event: 'SessionStart', data: { source: 'resume' } }).length, 1)
    assert.equal(selectRegistrations([source(dialect, 'PreCompact', 'manual')], { ...event, event: 'PreCompact', data: { trigger: 'auto' } }).length, 0)
    assert.equal(selectRegistrations([source(dialect, 'Stop', 'never')], { ...event, event: 'Stop' }).length, 1)
    assert.equal(selectRegistrations([source(dialect, 'UserPromptSubmit', '[')], { ...event, event: 'UserPromptSubmit' }).length, 1)
    assert.equal(selectRegistrations([source(dialect, 'SessionStart', 'startup')], event).length, 0)
  }
  assert.equal(selectRegistrations([source('claude-code', 'Notification', 'idle_prompt')], { ...event, event: 'Notification', data: { notification_type: 'idle_prompt' } }).length, 1)
})

test('normalizes only explicitly known host tool names and preserves arbitrary identities', async () => {
  const { toolIdentity, selectRegistrations } = await import('../src/matchers.js')
  assert.equal(toolIdentity('claude-code', 'functions.bash'), 'Bash')
  assert.equal(toolIdentity('codex', 'opencode.read'), 'Read')
  assert.equal(toolIdentity('claude-code', 'vendor.read'), 'vendor.read')
  assert.equal(toolIdentity('codex', 'mcp__filesystem__read'), 'mcp__filesystem__read')
  assert.equal(toolIdentity('claude-code', 'custom.bash'), 'custom.bash')
  for (const dialect of ['claude-code', 'codex'] as const) {
    assert.equal(selectRegistrations([source(dialect, 'PreToolUse', 'Bash')], { ...event, tool: 'functions.bash' }).length, 1)
    assert.equal(selectRegistrations([source(dialect, 'PreToolUse', 'Read')], { ...event, tool: 'vendor.read' }).length, 0)
    assert.equal(selectRegistrations([source(dialect, 'PreToolUse', 'mcp__filesystem__.*')], { ...event, tool: 'mcp__filesystem__read' }).length, 1)
  }
  assert.equal(selectRegistrations([source('codex', 'PreToolUse', 'Edit|Write')], { ...event, tool: 'apply_patch' }).length, 1)
  assert.equal(selectRegistrations([source('claude-code', 'PreToolUse', 'Edit|Write')], { ...event, tool: 'apply_patch' }).length, 0)
})

test('retains repeated registrations in source order without mutating the event', async () => {
  const { selectRegistrations } = await import('../src/matchers.js')
  const first = source('claude-code', 'PreToolUse', 'Read')
  const second = source('codex', 'PreToolUse', 'Read')
  const result = selectRegistrations([first, second, first], Object.freeze(event))
  assert.deepEqual(result.map(item => item.sourceID), ['claude-code', 'codex', 'claude-code'])
  assert.equal(event.tool, 'read')
})

test('filters changed basenames and canonical models without inventing model aliases', async () => {
  const { selectRegistrations } = await import('../src/matchers.js')
  const file = source('claude-code', 'FileChanged', '^data\\.csv$')
  assert.equal(selectRegistrations([file], { ...event, event: 'FileChanged', data: { file_path: '/project/other.csv' } }).length, 0)
  assert.equal(selectRegistrations([file], { ...event, event: 'FileChanged', data: { file_path: '/project/data.csv' } }).length, 1)
  const model = source('claude-code', 'PreModelSwitch', 'claude-opus-5')
  assert.equal(selectRegistrations([model], { ...event, event: 'PreModelSwitch', matcherValue: 'claude-sonnet-5', data: { to_model: 'sonnet' } }).length, 0)
  assert.equal(selectRegistrations([model], { ...event, event: 'PreModelSwitch', matcherValue: 'claude-opus-5', data: { to_model: 'opus' } }).length, 1)
  assert.equal(selectRegistrations([model], { ...event, event: 'PreModelSwitch', data: { to_model: 'unknown-custom-model' } }).length, 1)
})

test('unknown tool identities remain unchanged across arbitrary namespaces', async () => {
  const { toolIdentity } = await import('../src/matchers.js')
  fc.assert(fc.property(fc.string(), value => {
    const tool = `external.${value}`
    assert.equal(toolIdentity('claude-code', tool), tool)
    assert.equal(toolIdentity('codex', tool), tool)
  }))
})
