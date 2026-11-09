# OpenCode Harness Hooks

Compatibility adapters for running native Claude Code and Codex hook configurations in OpenCode.

Each source retains its native protocol and registration identity. Multiple sources may be selected together; registrations are never deduplicated.

The package has a shared runtime and separate V1/V2 entrypoints. Tool enforcement and [prompt submission](docs/prompts.md) have controlled runtime evidence on both pinned hosts. The default V2 entrypoint also has a verified foreground Claude command [Stop continuation](docs/stop.md); complete Stop parity and default host [startup integration](docs/lifecycle.md) remain required. Complete native artifacts, trust, remaining events, complete effects and migration parity remain acceptance gates. The package is not ready to replace an existing hook integration. See [compatibility](docs/compatibility.md) and [runtime configuration](docs/runtime.md).

Use the [read-only inspector](docs/inspection.md) to review native source digests, selected registrations, exclusions and compatibility gaps before activation.

Configurations containing enabled `Stop` registrations are incompatible with OpenCode V1. Loading fails with `HOST_STOP_UNSUPPORTED`, naming the offending configurations, event and missing awaited completion-decision capability. This is an accepted V1 limitation; V2 Stop parity remains required. See [the compatibility exception](docs/compatibility.md#v1-stop-exception).

Licensed under AGPL-3.0-only.
