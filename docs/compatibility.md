# Compatibility contract

The native reference versions are Claude Code 2.1.318 and Codex CLI 0.167.0. The required host targets are OpenCode V1 1.19.5 and V2 2.2.5. The source event catalogs are represented by `HOOK_EVENTS`; recognizing a configuration event does not establish that OpenCode can reproduce it.

## Dual host architecture

The package contract uses one default definition with `id`, V1's `server()` entrypoint, and V2's `setup()` entrypoint. The host adapters register hooks through their respective APIs and share source loading, matching, execution, and protocol translation. Supporting both package loaders does not establish equivalent host capabilities; each host needs separate effect and lifecycle evidence.

## Evidence and completion

Each required capability is classified as verified, unsupported, or unresolved, with supporting evidence. A required unsupported or unresolved capability prevents an equivalence claim. Missing evidence also prevents that claim. Tests proving an unsupported diagnostic are diagnostic coverage, not successful protocol equivalence.

## Source references

- [Claude Code hook reference](https://code.claude.com/docs/en/hooks)
- [Codex hook reference](https://learn.chatgpt.com/docs/hooks)
- [OpenCode plugin API at the pinned release](https://github.com/anomalyco/opencode/blob/v1.19.5/packages/plugin/src/index.ts)
- [OpenCode event dispatch at the pinned release](https://github.com/anomalyco/opencode/blob/v1.19.5/packages/opencode/src/plugin/index.ts)
- [OpenCode dual-version package guidance](https://opencode.ai/docs/build/plugins/migrate-v1/#support-v1-and-v2-from-one-package)
- [OpenCode V2 session hooks](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/plugin/src/promise/session.ts)
- [Codex command execution at the pinned release](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/hooks/src/engine/command_runner.rs)
- [Codex timeout normalization at the pinned release](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/hooks/src/engine/discovery.rs)
- [Codex MCP executor contract at the pinned release](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/hooks/src/mcp.rs)
- [Codex MCP expansion at the pinned release](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/hooks/src/engine/mcp_runner.rs)
- [Codex matcher implementation at the pinned release](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/hooks/src/engine/matcher.rs)
- [Codex dispatch and completion ordering at the pinned release](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/hooks/src/engine/dispatcher.rs)

## Source loading and matching

Sources are selected explicitly by dialect and path. JSON and Codex inline TOML are read with bounded input and snapshotted without modifying the source files. Loading extracts hook definitions and relevant disablement settings; it does not retain unrelated provider or authentication configuration. Native per-handler Codex disablement and explicit migration selections produce metadata-only exclusion reports. Each registration retains its own source and position; repeated registrations remain separate.

Claude's simple exact names and comma-separated lists differ from Codex's narrower exact-name optimization. Regex matching uses JavaScript for Claude and the Rust regex engine through the pinned `rregex` WebAssembly package for Codex. Unknown tool names and MCP identities remain unchanged; only explicit host tool aliases are translated. Group matching and handler execution are distinct stages: matching alone does not evaluate handler conditions, native trust, or host capabilities.

## Payload and output interpretation

Payload construction selects event-specific fields and keeps dialect-specific artifacts separate. It does not expose unrelated host metadata. Known built-in tool argument names are translated; arbitrary custom-tool and MCP argument keys remain intact. Missing required native metadata is an explicit error, including an unavailable Claude transcript path. Constructing a payload does not establish that a transcript has a compatible format or that the host can supply every event.

Output interpretation retains permission requests, input replacement, result replacement, feedback, continuation, and session stopping as distinct actions. Claude's `ask` and `defer` decisions are preserved. Codex's parsed-but-unsupported controls remain native hook failures rather than becoming approvals or denials. Claude Stop feedback and Codex Stop continuation also retain different prompt semantics. Post-tool feedback cannot undo a completed effect.

Native extensions such as permission updates, watcher changes, display replacement, and terminal notifications remain explicit action requests. Recognizing one does not establish host support; the host adapter must implement or report the requested capability. Output interpretation is separate from handler execution, native effect enforcement, artifact projection, lifecycle ordering, and migration parity.

The seeded Codex output fixture is generated from the pinned upstream wire types and output parser with the upstream `serde` and `serde_json` versions. It covers PreToolUse wire parsing with valid Bash replacement shapes, including valid controls, invalid shapes, Unicode, number range, and nesting boundaries. It does not prove command execution or host effects. The [native parser source](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/hooks/src/engine/output_parser.rs) is authoritative for permissive behavior absent from the guide, including acceptance of another known event tag in the PreToolUse wire shape.

## Command execution

Foreground command handlers use an explicit session environment snapshot and source context. Claude exec form preserves literal argument boundaries and substitutes native path and plugin-option placeholders; shell form delegates expansion to the selected shell and rejects plugin-option interpolation. Codex uses its login-shell invocation and restricted environment-variable filtering. Native timeout defaults and shutdown clamps remain dialect-specific. Claude's missing-directory fallback changes the process directory without rewriting the event's original `cwd` or initial project root.

Handler results distinguish native skips from unavailable host capabilities. Intentionally skipped prompt, agent, HTTP, or MCP registrations do not call an unavailable service. A required condition evaluator, PowerShell launcher, or background scheduler that is absent produces an explicit unsupported result. These command tests do not establish full condition, administrator environment policy, background, other handler-family, or host integration conformance.

## HTTP and model handlers

HTTP handlers POST the native JSON payload and interpolate only explicitly allowed header environment variables. Direct responses distinguish empty success, JSON object output, invalid bodies, transport errors, and non-success status codes. Response streaming stays inside the execution deadline and byte budget; partial output is discarded on cancellation or limits. The pinned native CLI probes do not follow relative or absolute HTTP redirects; redirects follow the non-success response policy. The native redirect observations are retained in an independent fixture.

Prompt and agent handlers call explicit host evaluation services. They preserve requested model selectors, prompt input, structured response validation, event-specific blocking and continuation, and the agent turn limit. Service deadlines cancel the supplied signal and discard late results. Native model selection, exact prompt rendering, agent tool access and lifecycle still require separate host and native conformance evidence. Task completion decisions retain an explicit extension request for trigger-specific host adjudication.

## MCP handlers

MCP execution requires an explicit host service that owns connection readiness, native policy, server deadlines, and elicitation. Requests preserve the dialect's connection policy. Codex requires an existing connection, no tool approval or recursive hooks, and active timeout accounting that excludes elicitation waits. A service offering only wall-clock accounting is explicitly unsupported for Codex. Missing servers, tool failures and service errors retain native non-blocking behavior where the event permits it.

Argument expansion differs by dialect. Codex preserves JSON types for whole-value placeholders and fails on missing paths. Claude renders placeholders as strings, including empty strings for missing or null values; its native lookup also supports array paths. The Claude fixture captures real native CLI calls against a local stdio MCP server. A fixed JSON transformation in a separate JavaScript realm preserves the observed lookup behavior without inheriting host prototype mutations. Template expansion and RPC inputs have explicit resource limits. Namespace attribution remains an explicit host extension request.

These fixtures establish the observed transport and template behavior, not full connection, elicitation, native trust or OpenCode MCP integration equivalence. Portable fixture regeneration remains a delivery gate.

## Background execution

Background commands retain independent invocation and completion order. Codex queues excess work at its native per-session concurrency limit; the execution deadline starts when a queued command runs. Its SessionEnd commands remain synchronous. Claude command hooks with `async` have no execution deadline, while `asyncRewake` retains its deadline and takes precedence when both flags are set.

Background output uses a separate interpretation path. Codex validates native wire fields while ignoring control decisions. Claude accepts a standalone JSON object or the first JSON object on a log line, keeps valid informational fields when other fields have invalid types, and retains informational output even when the process exits nonzero. Its background `systemMessage` reaches the model instead of becoming a UI warning. Native CLI captures establish delivery before a later model request in the same active user turn; an ordinary completion does not start a turn while idle.

Claude `asyncRewake` has a distinct contract: exit code 2 requests an immediate reminder using stderr, with stdout as fallback. Other exits do not deliver its JSON informational fields. An explicit host wake service is required; lacking that capability produces unsupported status before execution. The native background and wake fixtures cover the observed parser and scheduling behavior, while actual OpenCode wake integration remains a separate gate.

The background manager snapshots command input, source identity and environment. It separates session lifetime from turn cancellation, cancels running children and queued work on disposal, and discards undelivered output. Host delivery is acknowledged only after the delivery callback succeeds; concurrent claims are serialized and failed delivery remains retryable. Session reactivation is explicit. Metadata inspection and telemetry exclude commands and output, and queue, deferred-output and history retention limits are plugin limits rather than native limits.

Native repeated SessionStart delivery suppression, conversation resets, source reloads and installed-host context projection remain lifecycle conformance gates. Every matching registration still executes independently; source-level delivery rules must not become deduplication between registrations or dialects.

## Concurrent dispatch

The shared dispatcher snapshots sources, native event data and host context before starting work. Matching registrations execute independently, including repeated commands and registrations from both dialects. Claude prompt and agent hooks share their native concurrency limit for that event; waiting hooks begin handler execution and its deadline only after receiving a slot. Other foreground handlers start independently of that queue. Lifecycle matchers use the corresponding dialect's metadata.

Results retain configuration order for reporting and a separate completion order for native adjudication. Every action carries the source revision, registration and both orders; background output retains the same revision after the foreground dispatch returns. Permission selection preserves `deny` above `defer`, `ask` and `allow`, with stable configuration order for ties. This is also the bridge's combination rule across independently configured dialects. It does not deduplicate registrations or discard the original decisions.

Cancellation drains handlers and suppresses foreground action delivery. Diagnostics identify the dispatch, source revision, registration, outcome and duration without commands, source paths or output. Missing services remain unsupported, intentionally skipped native handlers remain skipped, and invalid matchers produce registration-specific failures while other registrations continue.

Conflicting input rewrites, continuation precedence, shared SessionEnd budgets and installed-host effect application remain aggregation and integration gates. Preserving their input actions and completion order does not establish those effects.

## Host boundaries under investigation

The pinned V1 host calls plugin event handlers without awaiting their promises. An asynchronous completion observer therefore does not itself provide an awaited final-turn veto. Completion control requires separate execution evidence and must not be inferred from an event name.

Source-native handler families include command, HTTP, MCP tool, prompt, and agent hooks. Their availability and intentional skip behavior differ by dialect and event. Recognition, execution, and equivalent native effects are separate checks.

V2 exposes an awaited `experimental.idle` session hook. Its continuation behavior requires independent execution evidence and does not repair V1's missing awaited completion hook. Windows is not covered by macOS execution evidence.

