# Native conformance

The [catalog](catalog.json) inventories the pinned Claude Code and Codex event contracts, cross-cutting mechanics, existing evidence, and executable cases. Each event has separate trigger, payload, and output obligations. These are coverage obligations to refine into event-specific branches, not a claim that every behavior already has a fixture. The [compatibility contract](../docs/compatibility.md) owns the target versions and accepted V1 Stop exception; tests detect drift between those pins and this independent inventory. The catalog and this guide accompany the package; executing the development runner requires a repository checkout, including its scripts and test fixtures.

## Inventory and completeness

Run the inventory without native executables, a package build, or a model account:

```bash
node scripts/verify-conformance.mjs
node scripts/verify-conformance.mjs --require-complete --host v1
```

The second command writes its JSON report and exits with status 4 when the selected host profile is incomplete. A passing selected case does not clear other obligations, its whole event, or the other host. The report distinguishes requirements from evidence availability. Source-derived oracles, recorded fixtures, native references, native readers, host probes, and unit tests are indexed with their scope and artifact hashes. Their presence never becomes an automatic runtime pass.

V1 Stop rows carry the accepted exception and remain `exception-unverified` until the corresponding dialect's expected rejection case passes. A successful rejection becomes `exception-verified`, and a failed rejection becomes `exception-failed`. Both dialects must pass before `missingExceptionEvidence` clears; one dialect cannot clear the other. This satisfies the accepted V1 profile boundary, never native Stop parity. V2 Stop remains a required native behavior. Testing an unsupported diagnostic for any other required capability does not establish native equivalence.

Statuses are reported per requirement and host. A fresh registered comparison can verify only its declared requirements at matching native and host versions. Exception cases declare no native requirements and verify only their own accepted rejection boundary. Runtime and comparison failures exit nonzero; they are not converted to successful diagnostic coverage. The report's `nativeConformant` field remains false while either target has missing proof or the full comparison retains a native exception.

## Independent native and host comparison

Build, then run the registered Claude PreToolUse control case:

```bash
npm ci
npm run build
node scripts/verify-conformance.mjs --case claude.pretooluse.control --claude-binary /path/to/claude --opencode-binary /path/to/opencode
```

Executable defaults are `CLAUDE_BINARY` or `claude`, `CODEX_BINARY` or `codex`, and `OPENCODE_V1_BINARY` or `opencode`. Select `codex.pretooluse.control` with `--codex-binary /path/to/codex` for the Codex comparison. Each case requires its pinned native executable, V1, and POSIX process groups. It uses one unchanged synthetic hook script and source configuration in both runtimes, disposable HOME/config/project state, and deterministic loopback providers with synthetic credentials. It needs no real model account. V2 execution is not part of these cases.

Native references execute through the actual Claude or Codex CLI. Host references load the default package in the actual OpenCode server. Neither expected outcomes nor hook payloads come from the adapter's protocol interpreter or payload builder. The probe records source and hook digests and fingerprints the compiled adapter and package metadata, checking them again after execution. Codex uses the Responses transport and its `exec_command` model tool; the hook must independently observe `Bash` with the original command, a valid turn identity, and the selected fixture model. Other native tool families remain separate obligations.

The denied operation must invoke the owned hook once, prevent its marker-file write, and deliver the literal configured reason in a tool result on the next model request. That request must have exactly one result for the emitted tool call; only its output/content text can establish reason delivery. A reason in another call's result or in metadata cannot pass. An allowed control must invoke the same hook once, execute its marker-file write, and deliver no denial reason. Both must expose the expected event, native tool identity, cwd, and original command, a valid owned tool-call identity, the declared permission mode, and an existing transcript. A blocked operation with no hook invocation, two identically wrong observations, or a control that never executes cannot pass.

The allow control tests absence of a veto. It does not test an explicit native `permissionDecision: "allow"` overriding host permission policy. Native permission bypass and host permission allowance are fixture settings, not trust or approval conformance evidence. Codex hook trust is bypassed explicitly for the fixture. Machine-managed native settings can remain active. Observed Claude `/api/hello` requests receive 404 and are counted separately from model requests; unexpected routes fail the probe.

The comparison publishes the exact set of selected observables. It does not normalize arbitrary payloads into equality. A completed mismatch produces a failed receipt with safe native/host observations and a diagnostic naming the backend, control, and field. Other selected cases still execute, and the combined report exits 1 rather than the incomplete-profile status 4. Runtime and precondition failures stop execution with a safe stderr diagnostic. Full input schemas, extra fields, reminder wrapping, transcript contents, model roles, warnings, and rendering remain separate unverified obligations. Native session and call identifiers are checked against their own invocation rather than forced to match identifiers generated by another harness. Provider traffic, raw hook payloads, native output, and temporary filesystem paths are not printed. Temporary fixture state and child process groups are cleaned up on success or failure.

Use the complete-profile gate with the same case to retain a passing narrow result while still rejecting incomplete conformance:

```bash
node scripts/verify-conformance.mjs --case claude.pretooluse.control --require-complete
```

## V1 Stop rejection and combined reports

Run fresh Stop rejection evidence for both dialects, optionally alongside their native control comparisons:

```bash
node scripts/verify-conformance.mjs --case claude-code.v1.stop-load-rejection --case codex.v1.stop-load-rejection
node scripts/verify-conformance.mjs --case claude.pretooluse.control --case codex.pretooluse.control --case claude-code.v1.stop-load-rejection --case codex.v1.stop-load-rejection --require-complete
```

Stop cases invoke the existing installed-package probe with `--stop-rejection` and validate its returned observations before issuing exception evidence. They require the pinned V1 executable, the package build, and Git. They require no native executable and perform no native Stop run; the receipt's native version identifies the pinned source contract. The default host must reject activation with the incompatible configuration and source identity, Stop event, missing awaited completion capability, and prominent error notice before any model request or hook execution. The adapter and probe fingerprints are checked before and after execution, and only whitelisted observation metadata reaches the report.

Repeat `--case` to assemble independent fresh results in one report; duplicate selections or unsupported host targets are usage errors. No saved external receipt can promote coverage. Each run keeps its own fixture and source digests, and case execution is sequential. The complete-profile gate still exits 4 after successful selected cases when other obligations remain.

The Codex control checks more than file existence: the hook must read journal records for its actual prompt and original owned call, with matching native session/turn identities and no current function-call output. The pinned native Codex reader must also recover that prompt without modifying the journal. The default V1 adapter's [Codex transcript projection](../docs/codex-transcripts.md) supplies this bounded record subset. A missing or malformed transcript remains a failed comparison. Passing the selected content checks does not verify every native transcript field or lifecycle.

## Input replacement

Run the independent shell input-rewrite comparisons for both dialects:

```sh
node scripts/verify-conformance.mjs --case claude.pretooluse.input-rewrite --case codex.pretooluse.input-rewrite --require-complete
```

Each case runs a replacement and an unchanged-command control through the pinned native harness and default V1. The same script observes `PreToolUse` and `PostToolUse` and returns `permissionDecision: "allow"` with `updatedInput` only for the owned replacement command. The pre-tool observation must contain the original command; the post-tool observation must contain the effective command under the same session and call identities. Invocation order, expected metadata and transcript existence are checked independently from the adapter's payload builder.

Distinct marker files prove that the replacement executes and the original does not. The unchanged control must execute its own command. The next model request must contain exactly one tool result, owned by the emitted call, with the expected stdout token and without the other commands' output tokens. An additional result for a different call, or a token in metadata, cannot pass. Both native and host observations must satisfy literal expectations; matching but incorrect effects remain a failed comparison. Failed receipts contain only whitelisted boolean/count metadata and preserve the incomplete-profile distinction.

These cases verify only their narrow input-replacement and effective post-tool input requirements. They do not certify whole-object replacement, competing rewrites, denial precedence, other tool families, full post-tool payload/output behavior, trust or permission-policy override, exact output wrapping, transcript contents, parallel scheduling, or V2. The fixture's native permission bypass and host allowance do not establish that an explicit allow can override an interactive permission policy. Existing deny/allow and transcript-content comparisons retain their own requirements.

## Post-tool effects

Run the post-tool comparison cases with sequential calls and no-op controls:

```sh
node scripts/verify-conformance.mjs --case claude.posttooluse.effects --case codex.posttooluse.effects --require-complete
```

The [post-tool conformance guide](../docs/posttool-conformance.md) defines selected result preservation/replacement, model-visible role/placement, completed side effects, and call-isolation observations. Native Claude and V1 agree on the selected context/feedback behavior; native Codex and V1 agree on the exercised string result replacement. A regression retains failed native/host observations and the runner continues other selected cases before exiting 1. Passing diagnostic rejection is not native equivalence. Exact formatting, broad post-tool behavior and V2 remain unverified. Those broader proof gaps remain visible without blocking the [bounded V1 delivery profile](../docs/v1-compatibility.md).

## Nonzero shell results

```sh
node scripts/verify-conformance.mjs --case claude.tool-failures --case codex.tool-failures --require-complete
```

The [failed-shell comparison](../docs/posttool-conformance.md#completed-nonzero-shell-calls) checks native event routing, selected error/output fields, owned post-tool effects, completed side effects and a later successful call. It uses the same pinned binaries, isolation and safe-receipt rules as the successful post-tool cases. Default V1 supports this measured path; other tool failures, exact rendering and V2 remain unverified. Passing the selected cases leaves the broader completeness gate unsatisfied.

## Extending the suite

Add a stable requirement for each independently testable native behavior and register a case with explicit source dialect, supported host targets, and observables. Broad event obligations need native branch coverage before they can be declared verified; a single example is insufficient. Reconcile version-sensitive behavior with the pinned native release, using public documentation as a starting reference rather than runtime proof.

Native and host observers must collect actual effects independently. Preserve dialect differences such as Claude feedback versus Codex result replacement. Use literal positive and negative controls, then generate malformed inputs and state sequences around the established contract. Validate only incidental identity differences, preserving required relationships, exact owned text, role, ordering, invocation counts, and side effects. Do not use the production translator to manufacture expected values.

Add a regression that fails when a real observable is lost or changed, including controls against vacuous passes. Record native/host versions, platform, fixture identity, source integrity, and supported scope. Map older probes as evidence available until their results have an explicit validated comparison path. Keep private installation policies as a separate migration acceptance suite.

## CLI contract

Help is available with `-h` and `--help`. Options support short and long forms, attached values, `--name=value`, short bundles, and `--` as the end of options; positional arguments are not accepted. `--case`/`-c` is repeatable, and `--codex-binary`/`-X` selects Codex. Executable paths containing a path separator resolve from the caller's working directory. Inventory performs no hook or host execution. The case runner checks conditional dependencies and exact versions before fixture execution. The inventory reads repository-contained regular evidence files and does not follow evidence outside the checkout.

Results are JSON on stdout. Diagnostics are on stderr without provider traffic or local paths. Exit status 0 means inventory or selected-case success, 1 means runtime/comparison failure, 2 means usage/version/platform preconditions, 3 means missing executables or build, and 4 means the requested completeness gate is not satisfied while its report is preserved.
