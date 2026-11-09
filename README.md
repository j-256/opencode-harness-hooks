# OpenCode Harness Hooks

Compatibility adapters for running native Claude Code and Codex hook configurations in OpenCode.

Each source retains its native protocol and registration identity. Multiple sources may be selected together; registrations are never deduplicated.

The package has a shared runtime and separate V1/V2 entrypoints. It is under development: tool enforcement has controlled runtime evidence on both pinned hosts, while native artifacts, trust, non-tool events, complete effects and migration parity remain acceptance gates. It is not ready to replace an existing hook integration. See [compatibility](docs/compatibility.md) and [runtime configuration](docs/runtime.md).

Use the [read-only inspector](docs/inspection.md) to review native source digests, selected registrations, exclusions and compatibility gaps before activation.

Licensed under AGPL-3.0-only.
