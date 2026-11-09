# OpenCode Harness Hooks

Compatibility adapters for running native Claude Code and Codex hook configurations in OpenCode.

Each source retains its native protocol and registration identity. Multiple sources may be selected together; registrations are never deduplicated.

The package has a shared runtime and separate V1/V2 entrypoints. Tool enforcement and [prompt submission](docs/prompts.md) have controlled runtime evidence on both pinned hosts. An independent [session-start and environment fixture](docs/lifecycle.md) supplies native reference behavior for lifecycle implementation. Complete native artifacts, trust, remaining events, complete effects and migration parity remain acceptance gates. The package is not ready to replace an existing hook integration. See [compatibility](docs/compatibility.md) and [runtime configuration](docs/runtime.md).

Use the [read-only inspector](docs/inspection.md) to review native source digests, selected registrations, exclusions and compatibility gaps before activation.

Licensed under AGPL-3.0-only.
