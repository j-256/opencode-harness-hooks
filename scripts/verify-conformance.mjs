#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { ConformanceError, validateCatalog, readInventory, coverageReport } from './lib/conformance.mjs'

const HELP = `Usage: node scripts/verify-conformance.mjs [-r] [-c CASE] [-H v1|v2] [-C PATH] [-o PATH]

List pinned native requirements and existing evidence without executing hooks.
An optional case compares actual native behavior with an installed OpenCode.
Pins: Claude Code 2.1.318, Codex 0.167.0, OpenCode V1 1.19.5 and V2 2.2.5.
Requires Node.js 22+. Inventory and help need no binaries, build or account.

Options:
  -c, --case ID          Run claude.pretooluse.control (V1 only): native Claude
                        PreToolUse denial and an allowed side-effect control
  -H, --host VERSION     Completeness target, v1 (default) or v2
  -C, --claude-binary PATH   Claude executable (CLAUDE_BINARY, then claude)
  -o, --opencode-binary PATH OpenCode executable (OPENCODE_V1_BINARY, then opencode)
  -r, --require-complete Fail when the selected profile has unverified obligations
  -h, --help            Show this help without checking dependencies

Execution needs npm run build, the pinned binaries and POSIX process groups.
It uses disposable HOME/config/project state and a deterministic loopback
provider with synthetic credentials; no model account is required. Native
permission bypass is fixture-only and does not verify trust. Machine-managed
native settings can remain active. Source config and hook bytes are shared.

The repository-owned conformance/catalog.json declares versions, events, event
facets, stable requirement IDs, classified evidence, cases and V1 exceptions.
Existing fixtures are evidence available, never automatic passing results.
JSON goes to stdout; errors go to stderr without provider traffic or local paths.
A passing case verifies only its named requirements, not its whole event.
Exit status: 0 inventory/case succeeded; 1 runtime or comparison failure;
2 usage/version/platform; 3 missing dependency/build; 4 incomplete profile
(JSON is preserved for status 4). Other missing requirements remain visible.
`

try {
  let parsed
  try { parsed = parseArgs({ options: { help: { type: 'boolean', short: 'h' }, case: { type: 'string', short: 'c' }, host: { type: 'string', short: 'H' }, 'claude-binary': { type: 'string', short: 'C' }, 'opencode-binary': { type: 'string', short: 'o' }, 'require-complete': { type: 'boolean', short: 'r' } }, strict: true, allowPositionals: false }) } catch { throw new ConformanceError('CONFORMANCE_USAGE_INVALID: use --help', 2) }
  if (parsed.values.help) process.stdout.write(HELP)
  else {
    const host = parsed.values.host ?? 'v1'
    for (const name of ['case', 'host', 'claude-binary', 'opencode-binary']) if (parsed.values[name] !== undefined && !parsed.values[name].trim()) throw new ConformanceError('CONFORMANCE_USAGE_VALUE: ' + name, 2)
    if (!['v1', 'v2'].includes(host)) throw new ConformanceError('CONFORMANCE_USAGE_HOST', 2)
    const root = fileURLToPath(new URL('..', import.meta.url))
    const catalog = validateCatalog(JSON.parse(await readFile(new URL('../conformance/catalog.json', import.meta.url), 'utf8')))
    const runs = []
    if (parsed.values.case !== undefined) {
      const scenario = catalog.cases.find(row => row.id === parsed.values.case)
      if (!scenario || !scenario.hosts.includes(host) || scenario.id !== 'claude.pretooluse.control') throw new ConformanceError('CONFORMANCE_USAGE_CASE', 2)
      const { runClaudePretoolControl } = await import('./lib/conformance-pretool.mjs')
      runs.push(await runClaudePretoolControl({ catalog, packageRoot: root, claudeBinary: parsed.values['claude-binary'] ?? process.env.CLAUDE_BINARY ?? 'claude', opencodeBinary: parsed.values['opencode-binary'] ?? process.env.OPENCODE_V1_BINARY ?? 'opencode' }))
    }
    const report = coverageReport(catalog, await readInventory(catalog, root), runs)
    process.stdout.write(JSON.stringify({ ...report, requestedHost: host, platform: process.platform, architecture: process.arch }, null, 2) + '\n')
    if (parsed.values['require-complete'] && !report.profiles[host].complete) process.exitCode = 4
  }
} catch (error) {
  process.stderr.write((error instanceof ConformanceError ? error.message : 'CONFORMANCE_RUN_FAILED') + '\n')
  process.exitCode = error instanceof ConformanceError ? error.status : 1
}
