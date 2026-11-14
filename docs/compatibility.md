# Compatibility contract

The native reference versions are Claude Code 2.1.318 and Codex CLI 0.167.0. The required host targets are OpenCode V1 1.19.5 and V2 2.2.5. The source event catalogs are represented by `HOOK_EVENTS`; recognizing a configuration event does not establish that OpenCode can reproduce it.

## Dual host architecture

The package contract uses one default definition with `id`, V1's `server()` entrypoint, and V2's `setup()` entrypoint. The host adapters register hooks through their respective APIs and share source loading, matching, execution, and protocol translation. Supporting both package loaders does not establish equivalent host capabilities; each host needs separate effect and lifecycle evidence.

OpenCode V1 also invokes `setup()` through its earlier experimental Promise API. The root recognizes that API's complete registration-domain context and leaves it passive while `server()` owns hook execution. The pinned V1 context has catalog and registration domains without the session/tool interfaces required by this package's V2 adapter. Partial, mixed or unrecognized setup contexts fail with `HOST_CONTEXT_UNSUPPORTED`. V2's location, session and tool capabilities select the active setup path. The distinction follows the [pinned V1 Promise context](https://github.com/anomalyco/opencode/blob/v1.19.5/packages/plugin/src/v2/promise/context.ts) and is exercised with the actual hosts as well as the default-entrypoint tests.

The default definition connects both tool backends through a shared runtime and session coordinator. A portable package probe exercises actual native options, turn/model metadata capture, denied side effects and executed input replacement on both pinned hosts. [Runtime configuration](runtime.md) documents snapshot review, explicit metadata projections, connected events, service boundaries and remaining gaps. The package report retains a negative equivalence result until the complete conformance and migration gates pass.

The root also supplies a bounded [Claude transcript projection](transcripts.md) for its verified text/tool history subset. Native reader acceptance and actual host hook consumption have separate controlled evidence. Unsupported content and missing original inputs remain errors; full transcript, environment persistence and lifecycle equivalence remain required gates.

The default V1 adapter also supplies a [Codex tool-hook transcript projection](codex-transcripts.md). Hook payloads and native-format journal records share projected session/turn identities while internal ownership retains host identities. The independent Codex control checks actual hook-side contents and native-reader prompt recovery. The legacy journal projection covers selected records; full native artifact and V2 projection parity remain separate requirements.

## Evidence and completion

Each required capability is classified as verified, unsupported, or unresolved, with supporting evidence. A required unsupported or unresolved capability prevents a full equivalence claim. Missing evidence also prevents that claim. Tests proving an unsupported diagnostic are diagnostic coverage, not successful protocol equivalence. Bounded V1 delivery uses the [documented profile and gap register](v1-compatibility.md): verify the supported surface, reject incompatible configurations clearly, and record remaining limitations, missing bindings and unverified behavior. Complete native equivalence and V2 integration are separate targets rather than prerequisites for that delivery.

The [native input-rewrite comparisons](../conformance/README.md#input-replacement) exercise original pre-tool input, executed shell replacement, effective post-tool input, and owned model-visible output through unchanged hooks and an unchanged-command control. Passing those cases verifies their narrow requirements for V1; broad input, permission, post-tool, and V2 obligations remain separate.

The [post-tool comparisons](posttool-conformance.md) measure Claude context/feedback, Codex string result replacement, and isolation between sequential calls. The selected controls agree with V1's default text-result delivery. Unsupported replacement shapes and conflicts retain explicit diagnostics. These cases do not certify full post-tool output or lifecycle equivalence.

## V1 Stop exception

OpenCode V1 cannot load configurations containing enabled `Stop` registrations. This is an accepted exception to identical behavior: the expected V1 result is a prominent fatal load error, not Stop execution parity. `HOST_STOP_UNSUPPORTED` identifies every offending source configuration, the `Stop` event and the unavailable `awaited-completion-decision` host capability. The bridge does not skip Stop registrations or approximate them with an idle observer. Native disablement or explicit selection can exclude registrations, and those exclusions remain reported.

The V1 acceptance case tests rejection before any hook or model execution through the actual default entrypoint. A passing rejection test does not make those configurations compatible with V1. V2 Stop parity, all other native behavior and the remaining migration acceptance requirements are unchanged. See [runtime configuration and reproduction](runtime.md) for the diagnostic contract and executable fixture.

The independent [native Stop reference](stop.md) characterizes continuation payloads, feedback, artifacts and ordering for both source dialects. Its success does not enable the unfinished V2 Stop adapter or claim bridge parity.

## Default V2 Stop boundary

The stock V2 host does not expose a completion decision boundary that runs for every completed response: pending user input can bypass the awaited idle hook. The default package rejects selected enabled Stop configurations with `HOST_STOP_UNSUPPORTED`, identifying every offending config and missing `awaited-completion-decision` capability. It reports a load error and retains fatal admission/execution guards because a setup exception alone can leave the host running after disabling the plugin. Disabled and explicitly excluded registrations remain visible exclusions.

An advertised completion capability does not enable the unintegrated adapter; that case identifies `verified-completion-adapter` as unavailable. Core idle and continuation tests establish only their explicit mechanism. V2 rejection is not an accepted exception to the full project requirements. Complete V2 Stop parity and the private migration remain open gates.

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

Source extraction does not reproduce native policy layering. Codex managed feature requirements can keep hooks enabled when a user feature setting requests disablement. Native trust, managed requirements and effective feature-policy parity require separate evidence; an isolated HOME alone does not isolate machine-managed policy.

The bridge's required no-deduplication behavior is an explicit difference from the pinned Claude runtime. A controlled native prompt fixture with byte-identical command registrations in one hook group observes one execution of that command; the bridge executes each selected registration. Distinct native commands returning identical context preserve both outputs. The [native transcript verifier](transcripts.md#native-oracle-and-reader-verification) records both cases using executable side effects. This observation does not establish the complete native identity algorithm across plugins, settings layers or events. `native-handler-deduplication` remains an unresolved source-equivalence gate; the bridge does not hide that difference or deduplicate registrations to make a comparison pass.

Claude's simple exact names and comma-separated lists differ from Codex's narrower exact-name optimization. Regex matching uses JavaScript for Claude and the Rust regex engine through the pinned `rregex` WebAssembly package for Codex. Unknown tool names and MCP identities remain unchanged; only explicit host tool aliases are translated. Group matching and handler execution are distinct stages: matching alone does not evaluate handler conditions, native trust, or host capabilities.

## Payload and output interpretation

Payload construction selects event-specific fields and keeps dialect-specific artifacts separate. It does not expose unrelated host metadata. Known built-in tool argument names are translated; arbitrary custom-tool and MCP argument keys remain intact. Missing required native metadata is an explicit error, including an unavailable Claude transcript path. Constructing a payload does not establish that a transcript has a compatible format or that the host can supply every event.

Output interpretation retains permission requests, input replacement, result replacement, feedback, continuation, and session stopping as distinct actions. Claude's `ask` and `defer` decisions are preserved. Codex's parsed-but-unsupported controls remain native hook failures rather than becoming approvals or denials. Claude Stop feedback and Codex Stop continuation also retain different prompt semantics. Post-tool feedback cannot undo a completed effect.

Foreground Claude context retains its source channel: command stdout and JSON `additionalContext` are distinct. An installed native `UserPromptSubmit` fixture observes different reminder labels and attachment records for these channels, with model context delivered as user content before the original prompt. `systemMessage` remains a warning. A blocking prompt hook prevents model invocation. These observations inform event delivery; preserving the channel in the interpreter does not establish complete host prompt or artifact equivalence. An independent installed Codex fixture observes prompt context as developer content after the user prompt; it must not reuse the Claude role, ordering or reminder rendering.

Native extensions such as permission updates, watcher changes, display replacement, and terminal notifications remain explicit action requests. Recognizing one does not establish host support; the host adapter must implement or report the requested capability. Output interpretation is separate from handler execution, native effect enforcement, artifact projection, lifecycle ordering, and migration parity.

The seeded Codex output fixture is generated from the pinned upstream wire types and output parser with the upstream `serde` and `serde_json` versions. It covers PreToolUse wire parsing with valid Bash replacement shapes, including valid controls, invalid shapes, Unicode, number range, and nesting boundaries. It does not prove command execution or host effects. The [native parser source](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/hooks/src/engine/output_parser.rs) is authoritative for permissive behavior absent from the guide, including acceptance of another known event tag in the PreToolUse wire shape.

## Command execution

Foreground command handlers use an explicit session environment snapshot and source context. Claude exec form preserves literal argument boundaries and substitutes native path and plugin-option placeholders; shell form delegates expansion to the selected shell and rejects plugin-option interpolation. Codex uses its login-shell invocation and restricted environment-variable filtering. Native timeout defaults and shutdown clamps remain dialect-specific. Claude's missing-directory fallback changes the process directory without rewriting the event's original `cwd` or initial project root.

Handler results distinguish native skips from unavailable host capabilities. Intentionally skipped prompt, agent, HTTP, or MCP registrations do not call an unavailable service. A required condition evaluator, PowerShell launcher, or background scheduler that is absent produces an explicit unsupported result. These command tests do not establish full condition, administrator environment policy, background, other handler-family, or host integration conformance.

## HTTP and model handlers

HTTP handlers POST the native JSON payload and interpolate only explicitly allowed header environment variables. Direct responses distinguish empty success, JSON object output, invalid bodies, transport errors, and non-success status codes. Response streaming stays inside the execution deadline and byte budget; partial output is discarded on cancellation or limits. The pinned native CLI probes do not follow relative or absolute HTTP redirects; redirects follow the non-success response policy. The native redirect observations are retained in an independent fixture.

Prompt and agent handlers call explicit host evaluation services. They preserve requested model selectors, prompt input, structured response validation, event-specific blocking and continuation, and the agent turn limit. Service deadlines cancel the supplied signal and discard late results. Native model selection, exact prompt rendering, agent tool access and lifecycle still require separate host and native conformance evidence. Task completion decisions retain an explicit extension request for trigger-specific host adjudication.

## MCP handlers

MCP execution requires an explicit host service that owns connection readiness, native policy, and server deadlines. Requests preserve the dialect's connection policy. Codex requests no tool approval or recursive hooks and carries the native session ID as per-call `metadata.threadId`. The pinned Codex executor enforces an outer wall deadline around the MCP call, even if the transport has its own timeout accounting; the engine preserves that deadline and the remaining caller budget. The service's `timeoutAccounting` declaration does not remove this outer limit. See the [pinned executor](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/core/src/hook_mcp_executor.rs). Missing servers, tool failures and service errors retain native nonblocking behavior where the event permits it.

Argument expansion differs by dialect. Codex preserves JSON types for whole-value placeholders and fails on missing paths. Claude renders placeholders as strings, including empty strings for missing or null values; its native lookup also supports array paths. The Claude fixture captures real native CLI calls against a local stdio MCP server. A fixed JSON transformation in a separate JavaScript realm preserves the observed lookup behavior without inheriting host prototype mutations. Template expansion and RPC inputs have explicit resource limits. Namespace attribution remains an explicit host extension request.

These fixtures establish the observed transport and template behavior, not full connection, elicitation, native trust or OpenCode MCP integration equivalence. Portable fixture regeneration remains a delivery gate.

## Background execution

Background commands retain independent invocation and completion order. Codex queues excess work at its native per-session concurrency limit; the execution deadline starts when a queued command runs. Its SessionEnd commands remain synchronous. Claude command hooks with `async` have no execution deadline, while `asyncRewake` retains its deadline and takes precedence when both flags are set.

Background output uses a separate interpretation path. Codex validates native wire fields while ignoring control decisions. Claude accepts a standalone JSON object or the first JSON object on a log line, keeps valid informational fields when other fields have invalid types, and retains informational output even when the process exits nonzero. Its background `systemMessage` reaches the model instead of becoming a UI warning. Native CLI captures establish delivery before a later model request in the same active user turn; an ordinary completion does not start a turn while idle.

Claude `asyncRewake` has a distinct contract: exit code 2 requests an immediate reminder using stderr, with stdout as fallback. Other exits do not deliver its JSON informational fields. An explicit host wake service is required; lacking that capability produces unsupported status before execution. The native background and wake fixtures cover the observed parser and scheduling behavior, while actual OpenCode wake integration remains a separate gate.

The background manager snapshots command input, source identity and environment. It separates session lifetime from turn cancellation, cancels running children and queued work on disposal, and discards undelivered output. Host delivery is acknowledged only after the delivery callback succeeds; concurrent claims are serialized and failed delivery remains retryable. Session reactivation is explicit. Deliveries retain immutable raw completion evidence and the actual command process identity for native artifact admission, including completed Claude output with no model action. The pending byte budget includes raw evidence and delivery metadata. Native artifact admission remains a separate responsibility of the host binding. Metadata inspection and telemetry exclude commands and output, and queue, deferred-output and history retention limits are plugin limits rather than native limits.

The [background artifact codec](../src/background-artifacts.ts) preserves recognized native Claude response fields, raw execution streams, the actual process identity, and rendered reminders. It retains non-rendering ignored controls, discards empty or unknown-only objects, and ignores completed responses containing a dynamic `async` declaration. Known specific metadata keeps the permissive native background types; foreground validation does not replace that contract. The [captured native cases](../test/fixtures/claude-background-artifacts-oracle.json) cover sanitation and rendering. Default model/transcript delivery, safe-point ordering, persistence, and idle rewake remain separate host-integration work.

The [owned background record service](../src/background-records.ts) validates current registration signatures for new admission, copies completion evidence, and retains duplicate-delivery receipts. Binding reservations separate accepted completion from a verified model carrier; rollback preserves later completions. Strict snapshots retain accepted historical output across configuration selection changes without executing earlier commands. Codex UI warnings have a separate persisted acknowledgement, and acknowledged UI-only payloads can be released while their receipts remain. Record, receipt, source-metadata, and snapshot budgets are bounded across the service. The default host binding remains separate work.

The [V1 background transport projection](../src/hosts/background-projection-v1.ts) binds requests to captured session, turn, provider, message, and tool identities. Text-only OpenAI Chat Completions, Responses, and Claude-compatible Anthropic envelopes have focused controls for carrier validation, repeated prompts, cold history, completion order, retries, and cancellation. Codex developer context requires an OpenAI envelope. The projection retains signatures rather than raw host history, bounds request readers and retained metadata, and strips its private correlation header. It runs after ordinary prompt-context projection through an explicit persistence barrier. Default scheduler wiring, native transcript/rollout integration, and installed-host comparison remain separate integration gates; these transport controls alone do not establish native conformance.

Native repeated SessionStart delivery suppression, conversation resets, source reloads and installed-host context projection remain lifecycle conformance gates. Every matching registration still executes independently; source-level delivery rules must not become deduplication between registrations or dialects.

## Concurrent dispatch

The shared dispatcher snapshots sources, native event data and host context before starting work. Matching registrations execute independently, including repeated commands and registrations from both dialects. Claude prompt and agent hooks share their native concurrency limit for that event; waiting hooks begin handler execution and its deadline only after receiving a slot. Other foreground handlers start independently of that queue. Lifecycle matchers use the corresponding dialect's metadata.

Results retain configuration order for reporting and a separate completion order for native adjudication. Every action carries the source revision, registration and both orders; background output retains the same revision after the foreground dispatch returns. Permission selection preserves `deny` above `defer`, `ask` and `allow`, with stable configuration order for ties. This is also the bridge's combination rule across independently configured dialects. It does not deduplicate registrations or discard the original decisions.

Cancellation drains handlers and suppresses foreground action delivery. Diagnostics identify the dispatch, source revision, registration, outcome and duration without commands, source paths or output. Missing services remain unsupported, intentionally skipped native handlers remain skipped, and invalid matchers produce registration-specific failures while other registrations continue.

The effect resolver selects the last-completed whole input replacement, preserving its source attribution. It does not merge the replacement with the original input. Native Claude MCP executions establish completion ordering, whole-object replacement and suppression by denial; Codex's pinned PreToolUse implementation selects by completion order too. The same rule combines rewrites across dialects. Superseded actions remain in the dispatch trace with metadata-only suppression records.

Approval requests preserve rewritten input for review and do not authorize direct execution. Deferred calls preserve a distinct `defer` control, suppress input application and require a host implementation that can resume the call later. Session stopping suppresses continuation actions while retaining their original dispatch trace. Claude feedback continuations and Codex user-prompt continuations remain separate.

At Stop, Claude continuations follow completion order and Codex continuations follow configuration order. The [Stop combination rules](stop.md) define their ordering and reason selection when sources are mixed, and distinguish suppressed model delivery from native feedback artifacts which must still be retained.

Competing post-tool result replacements remain an explicit unresolved conflict; the resolver retains every request instead of selecting an unverified outcome. Shared SessionEnd budgets and installed-host application of resolved effects remain integration gates. Native oracle regeneration remains a delivery gate.

## Host boundaries under investigation

The tool adapters use separate V1 and V2 registration APIs around a shared tool bridge. V1 input replacement mutates the argument object retained by the host; V2 replaces its mutable input field. The bridge retains original and effective argument snapshots separately. Host-scoped tool schemas map V1's `bash` and `filePath` fields and V2's `shell`, `patch` and `path` fields. Arbitrary tool names and argument keys remain unchanged; ambiguous field collisions and non-JSON numeric values fail explicitly.

The adapters accept an explicit dispatcher and host effect services. Before-tool denials throw through the native hook and prevent execution. Approval, preapproval, deferred resumption, turn stopping and other native effects require their corresponding services; absence is unsupported rather than approval or a substituted native denial. Approval services receive the rewritten input before argument mutation is committed. Post-tool failures and unsupported effects produce metadata diagnostics instead of retroactively rejecting an executed tool. Unknown V1 output shapes are not classified as native success.

Independent pinned-binary fixtures exercise the tool adapters with a synthetic Codex source and the old policy plugin absent. Both hosts prevent a denied file write, execute the replacement command, retain original arguments, expose effective post-tool arguments and deliver post-tool context through a supplied request-context service. These fixtures establish the exercised host mechanisms. Built-in session metadata, native artifacts, complete permission/defer services, context role and persistence equivalence, lifecycle behavior and private migration parity remain separate integration gates. Portable regeneration of these tool fixtures remains a delivery gate.

The pinned V1 host calls plugin event handlers without awaiting their promises. An asynchronous completion observer therefore does not itself provide an awaited final-turn veto. Completion control requires separate execution evidence and must not be inferred from an event name.

Source-native handler families include command, HTTP, MCP tool, prompt, and agent hooks. Their availability and intentional skip behavior differ by dialect and event. Recognition, execution, and equivalent native effects are separate checks.

V2 exposes an awaited `experimental.idle` session hook. An isolated probe of the pinned V2 binary with a deterministic local provider verifies that the hook can admit synthetic input with `resume: false`, continue the same execution and return the continued answer only after the final idle hook completes. This establishes the host mechanism; the plugin's Stop translation, lifecycle limits and migration behavior still require integration evidence. V1's missing awaited completion hook follows the explicit Stop rejection exception above. Windows is not covered by macOS execution evidence.

From a source checkout, run that host probe with `npm run test:host:v2 -- --binary /path/to/opencode`, or set `OPENCODE_V2_BINARY`. It requires the pinned V2 binary and Git; it does not install or upgrade OpenCode. The probe uses temporary configuration, a synthetic plugin and a loopback fake provider, then cleans up its server and temporary state. It closes the non-interactive CLI's stdin explicitly. The JSON result contains capability observations rather than credentials or model traffic. The probe verifies the host mechanism independently of the unfinished harness-hook adapter.

