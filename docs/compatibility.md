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
- [Codex matcher implementation at the pinned release](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/hooks/src/engine/matcher.rs)

## Source loading and matching

Sources are selected explicitly by dialect and path. JSON and Codex inline TOML are read with bounded input and snapshotted without modifying the source files. Loading extracts hook definitions and relevant disablement settings; it does not retain unrelated provider or authentication configuration. Native per-handler Codex disablement and explicit migration selections produce metadata-only exclusion reports. Each registration retains its own source and position; repeated registrations remain separate.

Claude's simple exact names and comma-separated lists differ from Codex's narrower exact-name optimization. Regex matching uses JavaScript for Claude and the Rust regex engine through the pinned `rregex` WebAssembly package for Codex. Unknown tool names and MCP identities remain unchanged; only explicit host tool aliases are translated. Group matching and handler execution are distinct stages: matching alone does not evaluate handler conditions, native trust, or host capabilities.

## Host boundaries under investigation

The pinned host calls plugin event handlers without awaiting their promises. An asynchronous completion observer therefore does not itself provide an awaited final-turn veto. Completion control requires separate execution evidence and must not be inferred from an event name.

Source-native handler families include command, HTTP, MCP tool, prompt, and agent hooks. Their availability and intentional skip behavior differ by dialect and event. Recognition, execution, and equivalent native effects are separate checks.

V2 exposes an awaited `experimental.idle` session hook. Its continuation behavior requires independent execution evidence and does not repair V1's missing awaited completion hook. Windows is not covered by macOS execution evidence.

