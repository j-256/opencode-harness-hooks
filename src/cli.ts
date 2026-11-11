#!/usr/bin/env node
import { constants } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { CONTRACT_VERSIONS, HOST_VERSIONS } from './contracts.js'
import type { HostVersion } from './contracts.js'
import { HostHookError } from './host-errors.js'

const MAX_CONFIG_BYTES = 1024 * 1024
const READ_CHUNK_BYTES = 64 * 1024
const HELP = `Usage: opencode-harness-hooks inspect -H v1|v2 [-d DIR] [--require-equivalent] OPTIONS.json

Read native source configuration and report compatibility metadata as JSON.
No hooks are executed and no files or live configuration are changed.

Options:
  -H, --host VERSION  Required host contract: v1 (${HOST_VERSIONS.v1}) or v2 (${HOST_VERSIONS.v2})
  -d, --directory DIR Project directory for relative source paths (default: cwd)
      --require-equivalent Return 4 unless required equivalence is established
  -h, --help          Show help without requiring files or an OpenCode executable

OPTIONS.json is a UTF-8 JSON object with the plugin options schema:
  {"sources":[{"id":"native","dialect":"claude-code","path":"hooks.json"}],
   "reviewedDigests":{},"permissionMode":"default"}
sources must be nonempty; each source has an id, dialect (claude-code or codex)
and path. Optional projectRoot, pluginRoot, selection and the Codex codexConfig
context follow docs/runtime.md.
reviewedDigests may be omitted for inspection and maps source IDs to reviewed
SHA-256 configuration digests. permissionMode is an optional native projection.
Source paths resolve against DIR; OPTIONS.json resolves against cwd. Use --
before a positional filename beginning with a dash. Options may be interleaved.

Requires Node.js 22+ and the package dependencies. No host or model account,
environment variables, persistent state or global source discovery is needed.
Input options are limited to 1 MiB; native sources use the loader's limits.
Results omit commands, matchers, paths, native payloads and unrelated settings.
The report names pinned contracts; it does not verify an installed host, native
trust, full protocol conformance or migration equivalence.

Exit status: 0 inspection succeeded; 1 read/runtime failure; 2 usage/schema;
3 missing package dependencies; 4 required equivalence unproven.
Successful inspection and status 4 write JSON to stdout; errors use stderr.
`

class InspectError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code) }
}

async function readOptions(path: string): Promise<unknown> {
  let file
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK)
    const info = await file.stat()
    if (!info.isFile()) throw new InspectError('INSPECT_CONFIG_READ', 1)
    if (info.size > MAX_CONFIG_BYTES) throw new InspectError('INSPECT_CONFIG_SIZE', 2)
    const chunk = Buffer.alloc(READ_CHUNK_BYTES)
    const chunks: Buffer[] = []
    let bytes = 0
    while (true) {
      const { bytesRead } = await file.read(chunk, 0, Math.min(chunk.length, MAX_CONFIG_BYTES + 1 - bytes), null)
      if (!bytesRead) break
      bytes += bytesRead
      if (bytes > MAX_CONFIG_BYTES) throw new InspectError('INSPECT_CONFIG_SIZE', 2)
      chunks.push(Buffer.from(chunk.subarray(0, bytesRead)))
    }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) as unknown } catch { throw new InspectError('INSPECT_CONFIG_PARSE', 2) }
  } catch (error) {
    if (error instanceof InspectError) throw error
    throw new InspectError('INSPECT_CONFIG_READ', 1)
  } finally { await file?.close() }
}

async function main(): Promise<void> {
  let parsed
  try { parsed = parseArgs({ options: { host: { type: 'string', short: 'H' }, directory: { type: 'string', short: 'd' }, 'require-equivalent': { type: 'boolean' }, help: { type: 'boolean', short: 'h' } }, strict: true, allowPositionals: true }) } catch { throw new InspectError('USAGE_INVALID: use --help', 2) }
  if (parsed.values.help) { process.stdout.write(HELP); return }
  const [command, path] = parsed.positionals
  if (command !== 'inspect' || !path || parsed.positionals.length !== 2) throw new InspectError('USAGE_INSPECT: expected inspect OPTIONS.json', 2)
  const host = parsed.values.host
  if (!host || !Object.hasOwn(HOST_VERSIONS, host)) throw new InspectError('USAGE_HOST: expected v1 or v2', 2)
  if (parsed.values.directory !== undefined && !parsed.values.directory.trim()) throw new InspectError('USAGE_DIRECTORY: expected a directory', 2)
  const directory = resolve(parsed.values.directory ?? process.cwd())
  try { if (!(await stat(directory)).isDirectory()) throw new Error() } catch { throw new InspectError('USAGE_DIRECTORY: unavailable directory', 2) }
  const input = await readOptions(resolve(path))
  const options = input && typeof input === 'object' && !Array.isArray(input) && !('reviewedDigests' in input) ? { ...input, reviewedDigests: {} } : input
  const [{ inspectSources }, { SourceError }] = await Promise.all([import('./inspection.js'), import('./config.js')]).catch((error: unknown) => {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ERR_MODULE_NOT_FOUND') throw new InspectError('DEPENDENCY_UNAVAILABLE: package dependencies', 3)
    throw error
  })
  const { report } = await inspectSources(host as HostVersion, directory, options).catch((error: unknown) => {
    if (error instanceof SourceError) throw new InspectError(error.message, error.code === 'SOURCE_READ' ? 1 : 2)
    if (error instanceof HostHookError) throw new InspectError(error.code, 2)
    throw error
  })
  process.stdout.write(JSON.stringify({ ...report, nativeContractVersions: { 'claude-code': CONTRACT_VERSIONS['claude-code'], codex: CONTRACT_VERSIONS.codex }, installedHostVerified: false }) + '\n')
  if (parsed.values['require-equivalent'] && !report.equivalent) process.exitCode = 4
}

try { await main() } catch (error) {
  if (error instanceof InspectError) { process.stderr.write(error.code + '\n'); process.exitCode = error.status }
  else { process.stderr.write('INSPECT_FAILED\n'); process.exitCode = 1 }
}
