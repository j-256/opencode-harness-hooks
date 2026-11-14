import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mcpInvocation, mcpOutput } from '../src/hosts/mcp-protocol-v1.js'

test('only an injective raw server/tool identity can authorize the flat host tool', () => {
  assert.equal(mcpInvocation('fixture', 'check', {}).hostTool, 'fixture_check')
  assert.equal(mcpInvocation('server-2', 'check-3', {}).hostTool, 'server-2_check-3')
  for (const [server, tool] of [['fixture', 'check.read'], ['fixture', 'check_read'], ['fixture_x', 'check'], ['fixture.x', 'check'], ['', 'check'], ['fixture', ''], ['fixture', '*'], ['fixture', 'check\0']]) assert.throws(() => mcpInvocation(server!, tool!, {}), { code: 'HOST_MCP_TOOL_IDENTITY_UNAVAILABLE' })
})

test('MCP arguments are bounded private snapshots rather than mutable caller objects', () => {
  const input = { nested: { name: 'Original' }, count: 3 }, invocation = mcpInvocation('fixture', 'check', input)
  input.nested.name = 'Changed'
  assert.deepEqual(JSON.parse(JSON.stringify(invocation.input)), { nested: { name: 'Original' }, count: 3 })
  assert.equal(Object.getPrototypeOf(invocation.input), null)
  assert.throws(() => mcpInvocation('fixture', 'check', input, 4), { code: 'EXECUTION_INPUT_LIMIT' })
  const cycle: Record<string, unknown> = {}; cycle.self = cycle
  assert.throws(() => mcpInvocation('fixture', 'check', cycle), { code: 'MCP_INPUT_INVALID' })
})

test('native text policy blocks combine without treating resource or image data as hook text', () => {
  assert.deepEqual(mcpOutput({ content: [{ type: 'text', text: '{"continue":false}' }] }), { text: '{"continue":false}' })
  const result = mcpOutput({ content: [{ type: 'text', text: '{"continue":' }, { type: 'text', text: 'false}' }, { type: 'image', data: 'PRIVATE_IMAGE', mimeType: 'image/png' }] })
  assert.deepEqual(JSON.parse(result.text), { continue: false })
  assert.ok(!result.text.includes('PRIVATE_IMAGE'))
  assert.deepEqual(mcpOutput({ content: [] }), { text: '' })
  assert.deepEqual(mcpOutput({ content: [], structuredContent: null }), { text: '' })
})

test('MCP isError cannot become a successful native policy even if its text contains one', () => {
  assert.deepEqual(mcpOutput({ isError: true, content: [{ type: 'text', text: '{"continue":false}' }] }), { text: '', isError: true })
})

test('host-synthesized structured text is explicitly incompatible with raw native output', () => {
  const structuredContent = { continue: false }, text = JSON.stringify(structuredContent)
  for (const content of [[], [{ type: 'text', text }]]) assert.throws(() => mcpOutput({ content, structuredContent }), { code: 'HOST_MCP_RAW_OUTPUT_UNAVAILABLE' })
  assert.deepEqual(mcpOutput({ content: [{ type: 'text', text: '{"continue":true}' }], structuredContent }), { text: '{"continue":true}' })
})

test('malformed and oversized MCP callbacks cannot publish partial output', () => {
  for (const value of [undefined, null, {}, { content: {} }, { content: [null] }, { content: [{ type: 'text', text: 3 }] }, { content: [], isError: 'wrong' }]) assert.throws(() => mcpOutput(value), { code: 'MCP_OUTPUT_INVALID' })
  assert.throws(() => mcpOutput({ content: [{ type: 'text', text: 'PRIVATE_TOO_LARGE' }] }, 4), { code: 'EXECUTION_OUTPUT_LIMIT' })
})

test('literal native and stock observations retain canonical identity and raw-output losses', async () => {
  const { readFile } = await import('node:fs/promises')
  const fixture = JSON.parse(await readFile(new URL('./fixtures/v1-mcp-boundaries.json', import.meta.url), 'utf8'))
  assert.equal(fixture.identity.nativeExecutedTool, fixture.identity.requestedTool)
  assert.equal(fixture.identity.hostExecutedTool, 'check.read')
  assert.notEqual(fixture.identity.hostExecutedTool, fixture.identity.requestedTool)
  assert.throws(() => mcpInvocation(fixture.identity.server, fixture.identity.requestedTool, {}), { code: 'HOST_MCP_TOOL_IDENTITY_UNAVAILABLE' })
  assert.equal(fixture.structuredOnly.nativeParentEffect, true)
  assert.deepEqual(fixture.structuredOnly.serverResult.content, [])
  assert.equal(fixture.structuredOnly.hostPublicAfter.content[0].text, '{"continue":false}')
  assert.throws(() => mcpOutput(fixture.structuredOnly.hostPublicAfter), { code: 'HOST_MCP_RAW_OUTPUT_UNAVAILABLE' })
})

test('a complete raw server inventory permits wider server names only when the flat target has one possible owner', () => {
  assert.equal(mcpInvocation('fixture.x', 'check', {}, undefined, ['fixture.x', 'other']).hostTool, 'fixture_x_check')
  assert.equal(mcpInvocation('fixture_x', 'check', {}, undefined, ['fixture_x']).hostTool, 'fixture_x_check')
  for (const servers of [['fixture.x', 'fixture_x'], ['fixture.x', 'fixture'], ['other'], ['fixture.x', 'fixture.x']]) assert.throws(() => mcpInvocation('fixture.x', 'check', {}, undefined, servers), { code: 'HOST_MCP_TOOL_IDENTITY_UNAVAILABLE' })
  assert.throws(() => mcpInvocation('fixture', 'check_read', {}, undefined, ['fixture']), { code: 'HOST_MCP_TOOL_IDENTITY_UNAVAILABLE' })
})
