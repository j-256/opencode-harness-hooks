#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { ConformanceError, validateCatalog, readInventory, coverageReport, conformanceExitStatus } from './lib/conformance.mjs'

const EXECUTABLE_CASES = new Set(['claude.pretooluse.control', 'codex.pretooluse.control', 'claude-code.v1.stop-load-rejection', 'codex.v1.stop-load-rejection'])
const HELP = `Usage: node scripts/verify-conformance.mjs [-r] [-c CASE ...] [-H v1|v2] [-C PATH] [-X PATH] [-o PATH]

List pinned native requirements and existing evidence without executing hooks.
An optional case compares actual native behavior with an installed OpenCode.
Pins: Claude Code 2.1.318, Codex 0.167.0, OpenCode V1 1.19.5 and V2 2.2.5.
Requires Node.js 22+. Inventory and help need no binaries, build or account.

Options:
  -c, --case ID          Repeat for independent cases (V1 only):
                        claude.pretooluse.control, codex.pretooluse.control,
                        claude-code.v1.stop-load-rejection,
                        codex.v1.stop-load-rejection
  -H, --host VERSION     Completeness target, v1 (default) or v2
  -C, --claude-binary PATH   Claude executable (CLAUDE_BINARY, then claude)
  -X, --codex-binary PATH    Codex executable (CODEX_BINARY, then codex)
  -o, --opencode-binary PATH OpenCode executable (OPENCODE_V1_BINARY, then opencode)
  -r, --require-complete Fail when the selected profile has unverified obligations
  -h, --help            Show this help without checking dependencies

Execution needs npm run build, applicable pinned binaries and POSIX process groups.
Stop rejection cases require OpenCode and Git, without a native executable.
It uses disposable HOME/config/project state and a deterministic loopback
provider with synthetic credentials; no model account is required. Native
permission bypass is fixture-only and does not verify trust. Machine-managed
native settings can remain active. Source config and hook bytes are shared.
Codex hook trust is bypassed for the fixture, never verified by the case.

The repository-owned conformance/catalog.json declares versions, events, event
facets, stable requirement IDs, classified evidence, cases and V1 exceptions.
Existing fixtures are evidence available, never automatic passing results.
JSON goes to stdout; errors go to stderr without provider traffic or local paths.
A passing case verifies only its named requirements, not its whole event.
A completed comparison mismatch retains a failed receipt in JSON and exits 1;
other selected cases still run. Runtime/precondition failures stop execution.
Exit status: 0 inventory/case succeeded; 1 runtime or comparison failure;
2 usage/version/platform; 3 missing dependency/build; 4 incomplete profile
(JSON is preserved for status 4). Other missing requirements remain visible.
`
function binary(value) {
  if (typeof value !== 'string' || !value.trim()) throw new ConformanceError('CONFORMANCE_USAGE_BINARY', 2)
  return value.includes('/') || value.includes('\\') ? resolve(value) : value
}

try {
  let parsed
  try { parsed = parseArgs({ options: { help: { type: 'boolean', short: 'h' }, case: { type: 'string', short: 'c', multiple: true }, host: { type: 'string', short: 'H' }, 'claude-binary': { type: 'string', short: 'C' }, 'codex-binary': { type: 'string', short: 'X' }, 'opencode-binary': { type: 'string', short: 'o' }, 'require-complete': { type: 'boolean', short: 'r' } }, strict: true, allowPositionals: false }) } catch { throw new ConformanceError('CONFORMANCE_USAGE_INVALID: use --help', 2) }
  if (parsed.values.help) process.stdout.write(HELP)
  else {
    const host = parsed.values.host ?? 'v1'
    for (const name of ['host', 'claude-binary', 'codex-binary', 'opencode-binary']) if (parsed.values[name] !== undefined && !parsed.values[name].trim()) throw new ConformanceError('CONFORMANCE_USAGE_VALUE: ' + name, 2)
    if (!['v1', 'v2'].includes(host)) throw new ConformanceError('CONFORMANCE_USAGE_HOST', 2)
    const cases = parsed.values.case ?? []
    if (new Set(cases).size !== cases.length) throw new ConformanceError('CONFORMANCE_USAGE_DUPLICATE_CASE', 2)
    const root = fileURLToPath(new URL('..', import.meta.url))
    const catalog = validateCatalog(JSON.parse(await readFile(new URL('../conformance/catalog.json', import.meta.url), 'utf8')))
    const runs = []
    const scenarios = cases.map(id => catalog.cases.find(row => row.id === id))
    if (scenarios.some(row => !row || !row.hosts.includes(host) || !EXECUTABLE_CASES.has(row.id))) throw new ConformanceError('CONFORMANCE_USAGE_CASE', 2)
    for (const scenario of scenarios) {
      const options = { catalog, packageRoot: root, dialect: scenario.dialect, opencodeBinary: binary(parsed.values['opencode-binary'] ?? process.env.OPENCODE_V1_BINARY ?? 'opencode') }
      if (scenario.kind === 'exception') {
        const { runStopRejection } = await import('./lib/conformance-stop.mjs')
        runs.push(await runStopRejection(options))
      } else {
        const { runPretoolControl } = await import('./lib/conformance-pretool.mjs')
        const nativeBinary = scenario.dialect === 'codex' ? binary(parsed.values['codex-binary'] ?? process.env.CODEX_BINARY ?? 'codex') : binary(parsed.values['claude-binary'] ?? process.env.CLAUDE_BINARY ?? 'claude')
        runs.push(await runPretoolControl({ ...options, nativeBinary }))
      }
    }
    const report = coverageReport(catalog, await readInventory(catalog, root), runs)
    process.stdout.write(JSON.stringify({ ...report, requestedHost: host, platform: process.platform, architecture: process.arch }, null, 2) + '\n')
    process.exitCode = conformanceExitStatus(report, host, parsed.values['require-complete'])
  }
} catch (error) {
  process.stderr.write((error instanceof ConformanceError ? error.message : 'CONFORMANCE_RUN_FAILED') + '\n')
  process.exitCode = error instanceof ConformanceError ? error.status : 1
}
