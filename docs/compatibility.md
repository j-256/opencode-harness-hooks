# Compatibility contract

The native reference versions are Claude Code 2.1.318 and Codex CLI 0.167.0. The required host targets are OpenCode V1 1.19.5 and V2 2.2.5. The source event catalogs are represented by `HOOK_EVENTS`; recognizing a configuration event does not establish that OpenCode can reproduce it.

## Dual host architecture

One package exposes a default definition with `id`, V1's `server()` entrypoint, and V2's `setup()` entrypoint. The host adapters register hooks through their respective APIs and share source loading, matching, execution, and protocol translation. Supporting both package loaders does not establish equivalent host capabilities; each host needs separate effect and lifecycle evidence.

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
- [Codex matcher implementation at the pinned release](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/hooks/src/engine/matcher.rs)

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

## Host boundaries under investigation

The pinned V1 host calls plugin event handlers without awaiting their promises. An asynchronous completion observer therefore does not itself provide an awaited final-turn veto. Completion control requires separate execution evidence and must not be inferred from an event name.

Source-native handler families include command, HTTP, MCP tool, prompt, and agent hooks. Their availability and intentional skip behavior differ by dialect and event. Recognition, execution, and equivalent native effects are separate checks.

V2 exposes an awaited `experimental.idle` session hook. Its continuation behavior requires independent execution evidence and does not repair V1's missing awaited completion hook. Windows is not covered by macOS execution evidence.

