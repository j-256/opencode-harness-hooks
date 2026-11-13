import { createHash } from 'node:crypto'
import { readFile, lstat, realpath } from 'node:fs/promises'
import { isAbsolute, join, sep } from 'node:path'

const DIALECTS = Object.freeze(['claude-code', 'codex'])
const HOSTS = Object.freeze(['v1', 'v2'])
const EVIDENCE_LEVELS = new Set(['source-oracle', 'recorded-oracle', 'native-reference', 'native-reader', 'host-probe', 'unit-test'])
const EVENT_FACETS = Object.freeze(['trigger', 'payload', 'outputs'])
const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = value => typeof value === 'string' && value.trim().length > 0
const array = value => Array.isArray(value) && value.every(text)
const unique = values => new Set(values).size === values.length
export class ConformanceError extends Error { constructor(code, status = 1) { super(code); this.status = status } }
function valid(condition) { if (!condition) throw new ConformanceError('CONFORMANCE_CATALOG_INVALID', 2) }
function safePath(path) { return text(path) && !isAbsolute(path) && !path.includes('\\') && !path.includes('\0') && path.split('/').every(part => part && part !== '.' && part !== '..') }

export function requirements(catalog) {
  return [...DIALECTS.flatMap(dialect => catalog.events[dialect].flatMap(event => EVENT_FACETS.map(facet => ({ id: `${dialect}.event.${event}.${facet}`, dialect, event, area: 'event', summary: catalog.eventFacets[facet] })))), ...catalog.requirements]
}

export function validateCatalog(catalog) {
  valid(record(catalog) && catalog.schemaVersion === 1 && record(catalog.versions) && record(catalog.versions.native) && record(catalog.versions.hosts) && record(catalog.events) && record(catalog.eventFacets) && record(catalog.references))
  for (const dialect of DIALECTS) {
    valid(text(catalog.versions.native[dialect]) && array(catalog.events[dialect]) && catalog.events[dialect].length > 0 && unique(catalog.events[dialect]))
    valid(typeof catalog.references[dialect] === 'string' && catalog.references[dialect].startsWith('https://'))
  }
  for (const host of HOSTS) valid(text(catalog.versions.hosts[host]))
  for (const facet of EVENT_FACETS) valid(text(catalog.eventFacets[facet]))
  valid(Array.isArray(catalog.requirements) && Array.isArray(catalog.evidence) && Array.isArray(catalog.cases) && Array.isArray(catalog.exceptions))
  for (const row of catalog.requirements) valid(record(row) && text(row.id) && DIALECTS.includes(row.dialect) && text(row.area) && text(row.summary) && (!row.event || catalog.events[row.dialect].includes(row.event)))
  const rows = requirements(catalog), ids = rows.map(row => row.id)
  valid(unique(ids))
  for (const row of catalog.evidence) {
    valid(record(row) && text(row.id) && EVIDENCE_LEVELS.has(row.level) && array(row.artifacts) && row.artifacts.length > 0 && row.artifacts.every(safePath) && array(row.dialects) && row.dialects.every(value => DIALECTS.includes(value)) && array(row.events) && array(row.areas) && text(row.scope) && row.status === undefined)
  }
  valid(unique(catalog.evidence.map(row => row.id)))
  for (const row of catalog.cases) {
    valid(record(row) && text(row.id) && DIALECTS.includes(row.dialect) && array(row.hosts) && row.hosts.length > 0 && row.hosts.every(value => HOSTS.includes(value)) && array(row.requirements) && unique(row.requirements) && text(row.description) && array(row.observables))
    if (row.kind === 'exception') valid(row.requirements.length === 0 && text(row.exception))
    else valid((row.kind === undefined || row.kind === 'comparison') && row.exception === undefined && row.requirements.length > 0 && row.requirements.every(id => ids.includes(id) && rows.find(row => row.id === id).dialect === row.dialect))
  }
  valid(unique(catalog.cases.map(row => row.id)))
  for (const row of catalog.exceptions) {
    valid(record(row) && row.id === 'v1-stop-load-rejection' && row.host === 'v1' && row.event === 'Stop' && array(row.dialects) && row.dialects.length > 0 && unique(row.dialects) && row.dialects.every(value => DIALECTS.includes(value)) && record(row.evidenceCases) && Object.keys(row.evidenceCases).length === row.dialects.length && text(row.reason))
    for (const dialect of row.dialects) {
      const scenario = catalog.cases.find(item => item.id === row.evidenceCases[dialect])
      valid(scenario?.kind === 'exception' && scenario.exception === row.id && scenario.dialect === dialect && scenario.hosts.length === 1 && scenario.hosts[0] === row.host)
    }
  }
  valid(unique(catalog.exceptions.map(row => row.id)))
  for (const row of catalog.cases.filter(item => item.kind === 'exception')) valid(catalog.exceptions.some(item => item.id === row.exception && item.evidenceCases[row.dialect] === row.id))
  return catalog
}

export async function readInventory(catalog, root) {
  validateCatalog(catalog)
  const canonicalRoot = await realpath(root)
  return Promise.all(catalog.evidence.map(async evidence => {
    const artifacts = await Promise.all(evidence.artifacts.map(async path => {
      try {
        const actual = await realpath(join(root, path))
        if (!actual.startsWith(canonicalRoot + sep)) return { path, available: false, reason: 'outside-root' }
        const stat = await lstat(join(root, path))
        if (!stat.isFile() || stat.size > MAX_ARTIFACT_BYTES) return { path, available: false }
        const bytes = await readFile(actual)
        if (bytes.length > MAX_ARTIFACT_BYTES) return { path, available: false }
        return { path, available: true, sha256: createHash('sha256').update(bytes).digest('hex') }
      } catch (error) {
        if (['ENOENT', 'ENOTDIR'].includes(error.code)) return { path, available: false }
        throw new ConformanceError('CONFORMANCE_EVIDENCE_READ_FAILED')
      }
    }))
    return { ...evidence, artifacts, available: artifacts.every(row => row.available), verification: 'not-run' }
  }))
}

export function coverageReport(catalog, inventory, runs = []) {
  validateCatalog(catalog)
  const runKeys = new Set()
  for (const run of runs) {
    const scenario = catalog.cases.find(row => row.id === run.caseID)
    const id = JSON.stringify([run.caseID, run.host])
    if (!scenario || !scenario.hosts.includes(run.host) || run.nativeVersion !== catalog.versions.native[scenario.dialect] || run.hostVersion !== catalog.versions.hosts[run.host] || !['passed', 'failed'].includes(run.status) || runKeys.has(id)) throw new ConformanceError('CONFORMANCE_RUN_INVALID', 2)
    runKeys.add(id)
  }
  const rows = requirements(catalog).map(row => ({
    ...row,
    evidenceAvailable: inventory.filter(evidence => evidence.available && evidence.dialects.includes(row.dialect) && (evidence.events.includes(row.event) || evidence.areas.includes(row.area))).map(evidence => evidence.id),
    targets: Object.fromEntries(HOSTS.map(host => {
      const exception = catalog.exceptions.find(item => item.host === host && item.event === row.event && item.dialects.includes(row.dialect))
      const relevant = runs.filter(run => run.host === host && (exception ? run.caseID === exception.evidenceCases[row.dialect] : catalog.cases.find(item => item.id === run.caseID).requirements.includes(row.id)))
      const outcome = relevant.some(run => run.status === 'failed') ? 'failed' : relevant.some(run => run.status === 'passed') ? 'verified' : 'unverified'
      const status = exception ? 'exception-' + outcome : outcome
      return [host, { status, runs: relevant.map(run => run.caseID), ...(exception ? { exception: exception.id } : {}) }]
    })),
  }))
  const profiles = Object.fromEntries(HOSTS.map(host => {
    const blockers = rows.filter(row => !['verified', 'exception-verified'].includes(row.targets[host].status)).map(row => row.id)
    const missingExceptionEvidence = catalog.exceptions.filter(row => row.host === host && !row.dialects.every(dialect => runs.some(run => run.host === host && run.caseID === row.evidenceCases[dialect] && run.status === 'passed'))).map(row => row.id)
    return [host, { version: catalog.versions.hosts[host], complete: blockers.length === 0 && missingExceptionEvidence.length === 0, blockers, missingExceptionEvidence }]
  }))
  return { schemaVersion: catalog.schemaVersion, versions: catalog.versions, scope: 'Pinned requirements and specified observables; evidence availability is not runtime verification', nativeConformant: HOSTS.every(host => profiles[host].complete) && catalog.exceptions.length === 0, profiles, requirements: rows, evidence: inventory, runs }
}

const DIGEST_PATTERN = /^[a-f0-9]{64}$/
const CONTROL_FIELDS = Object.freeze(['hookInvocations', 'event', 'tool', 'cwdMatches', 'commandMatches', 'identityValid', 'transcriptExists', 'resultOwned', 'reasonDelivered', 'sideEffect', 'primaryModelCalls'])
const CODEX_TRANSCRIPT_FIELDS = Object.freeze(['transcriptContentValid', 'nativeReaderAccepted'])
export function compareControlObservations(native, host, options = {}) {
  const fields = [...CONTROL_FIELDS, ...(options.codexTranscript ? CODEX_TRANSCRIPT_FIELDS : []), ...(options.http ? ['httpTransportValid'] : []), ...(options.nonblockingHttpFailure ? ['httpFailureBodyAbsent'] : [])]
  for (const [backend, trace] of [['native', native], ['host', host]]) {
    if (!record(trace) || !DIGEST_PATTERN.test(trace.sourceDigest ?? '') || !DIGEST_PATTERN.test(trace.hookDigest ?? '') || !Array.isArray(trace.controls) || trace.controls.length !== 2) throw new ConformanceError('CONFORMANCE_OBSERVATION_INVALID')
    for (const [index, control] of trace.controls.entries()) {
      const expected = { id: index === 0 ? 'deny' : 'allow', hookInvocations: 1, event: 'PreToolUse', tool: 'Bash', cwdMatches: true, commandMatches: true, identityValid: true, transcriptExists: true, resultOwned: true, reasonDelivered: options.nonblockingHttpFailure ? false : index === 0, sideEffect: options.nonblockingHttpFailure ? true : index === 1, primaryModelCalls: 2, ...(options.codexTranscript ? { transcriptContentValid: true, nativeReaderAccepted: true } : {}), ...(options.http ? { httpTransportValid: true } : {}) }
      if (!record(control)) throw new ConformanceError('CONFORMANCE_OBSERVATION_INVALID')
      if (options.nonblockingHttpFailure) expected.httpFailureBodyAbsent = true
      const mismatch = Object.entries(expected).find(([field, value]) => control[field] !== value)
      if (mismatch) throw new ConformanceError(`CONFORMANCE_CONTROL_FAILED: ${backend}.${expected.id}.${mismatch[0]}`)
    }
  }
  if (native.sourceDigest !== host.sourceDigest || native.hookDigest !== host.hookDigest) throw new ConformanceError('CONFORMANCE_SOURCE_MISMATCH')
  const controls = native.controls.map((control, index) => {
    if (fields.some(field => control[field] !== host.controls[index][field])) throw new ConformanceError('CONFORMANCE_DIFFERENTIAL_FAILED')
    return Object.fromEntries(['id', ...fields].map(field => [field, control[field]]))
  })
  return { match: true, compared: fields, sourceDigest: native.sourceDigest, hookDigest: native.hookDigest, controls }
}

export function evaluateControlObservations(native, host, options = {}) {
  try { return { status: 'passed', comparison: compareControlObservations(native, host, options) } }
  catch (error) {
    if (!(error instanceof ConformanceError) || !(error.message.startsWith('CONFORMANCE_CONTROL_FAILED:') || error.message === 'CONFORMANCE_DIFFERENTIAL_FAILED')) throw error
    const observe = trace => trace.controls.map(control => ({
      id: ['deny', 'allow'].includes(control.id) ? control.id : 'unexpected',
      event: control.event === 'PreToolUse' ? 'PreToolUse' : 'unexpected',
      tool: control.tool === 'Bash' ? 'Bash' : 'unexpected',
      ...Object.fromEntries(['hookInvocations', 'primaryModelCalls'].map(key => [key, Number.isSafeInteger(control[key]) && control[key] >= 0 ? control[key] : null])),
      ...Object.fromEntries(['cwdMatches', 'commandMatches', 'identityValid', 'transcriptExists', 'resultOwned', 'reasonDelivered', 'sideEffect', ...(options.codexTranscript ? CODEX_TRANSCRIPT_FIELDS : []), ...(options.http ? ['httpTransportValid'] : []), ...(options.nonblockingHttpFailure ? ['httpFailureBodyAbsent'] : [])].map(key => [key, typeof control[key] === 'boolean' ? control[key] : null])),
    }))
    return { status: 'failed', comparison: { match: false, sourceDigest: native.sourceDigest, hookDigest: native.hookDigest, failure: error.message, observations: { native: observe(native), host: observe(host) } } }
  }
}

export function conformanceExitStatus(report, host, requireComplete) {
  return report.runs.some(run => run.status === 'failed') ? 1 : requireComplete && !report.profiles[host].complete ? 4 : 0
}
