# OpenCode Harness Hooks

Compatibility adapters for running native Claude Code and Codex hook configurations in OpenCode.

Each source retains its native protocol and registration identity. Multiple sources may be selected together; registrations are never deduplicated.

The package has a shared runtime and separate V1/V2 entrypoints. Tool enforcement and [prompt submission](docs/prompts.md) have controlled runtime evidence on both pinned hosts. The default entrypoints reject selected Stop registrations; the explicit core [Stop mechanisms](docs/stop.md) do not establish default-host support. Complete V2 Stop parity and default host [startup integration](docs/lifecycle.md) remain required. Complete native artifacts, trust, remaining events, complete effects and migration parity remain acceptance gates. The package is not ready to replace an existing hook integration. See [compatibility](docs/compatibility.md) and [runtime configuration](docs/runtime.md).

V1 prompt context is incompatible with providers with custom authentication fetch loaders; tool-only use avoids that transport limitation. The [stock-host guide](docs/stock-hosts.md) defines the supported command/prompt/tool subset, explicit source selection, incompatible configurations and executable checks.

The [architecture guide](docs/architecture.md) describes the host-neutral engine, separate V1/V2 bindings, public entrypoints, independent builds, and extraction checks. Binding-specific factories and permission helpers are exported from `/opencode`; `/engine` and `/core` expose the shared engine.

Use the [read-only inspector](docs/inspection.md) to review native source digests, selected registrations, exclusions and compatibility gaps before activation.

Configurations containing selected enabled `Stop` registrations are incompatible with both default host entrypoints. Loading fails with `HOST_STOP_UNSUPPORTED`, naming the offending configurations, event and missing awaited completion-decision capability. V1 rejection is an accepted limitation. V2 rejection is a supported-subset boundary while its completion adapter remains unintegrated; full V2 Stop parity remains required. See [the compatibility exception](docs/compatibility.md#v1-stop-exception).

Licensed under AGPL-3.0-only.
