# OpenCode Harness Hooks

Compatibility adapters for running native Claude Code and Codex hook configurations in OpenCode.

Each source retains its native protocol and registration identity. Multiple sources may be selected together; registrations are never deduplicated.

Node requires version 22.13 or later. The default V1 binding keeps owned native inputs, records and prompt context in [private durable session storage](docs/session-state.md), using built-in SQLite on Node and Bun. Its cold-resume comparisons preserve historical original input after a tool rewrite; full lifecycle and compaction parity remain separate requirements.

The package has a shared runtime and separate V1/V2 entrypoints. The implementation target is every feasible behavior through stock host APIs, with demonstrated host limitations documented in the [V1 implementation status](docs/v1-compatibility.md). Verified subsets can be used while remaining services, mappings and conformance work proceeds. Tool enforcement and [prompt submission](docs/prompts.md) have controlled runtime evidence on both pinned hosts. V2 native integration and complete lifecycle/artifact/trust coverage remain separate work. Review the intended source configuration and supported boundaries before migrating an existing integration; see [compatibility](docs/compatibility.md) and [runtime configuration](docs/runtime.md).

V1 providers with custom authentication fetch loaders require [explicit provider composition](docs/v1-provider-composition.md) for prompt context; tool-only use avoids that transport limitation. The [stock-host guide](docs/stock-hosts.md) defines the supported command/prompt/tool subset, explicit source selection, incompatible configurations and executable checks.

The [architecture guide](docs/architecture.md) describes the host-neutral engine, separate V1/V2 bindings, public entrypoints, independent builds, and extraction checks. Binding-specific factories and permission helpers are exported from `/opencode`; `/engine` and `/core` expose the shared engine.

Use the [read-only inspector](docs/inspection.md) to review native source digests, selected registrations, exclusions and compatibility gaps before activation.

The [native conformance catalog and runner](conformance/README.md) track versioned requirements, existing evidence and gaps separately. Independent native-versus-V1 cases check tool denial, input rewriting, Claude post-tool context/feedback and Codex post-tool result replacement with unchanged hook configurations, including selected completed nonzero shell calls and [Claude HTTP tool/failure controls](docs/http-hooks.md). Per-dialect Stop rejection cases verify the accepted V1 incompatibility boundary. Passing selected cases does not establish full native conformance or private migration parity; broad negative equivalence reports do not negate the verified bounded profile.

Configurations containing selected enabled `Stop` registrations are incompatible with both default host entrypoints. Loading fails with `HOST_STOP_UNSUPPORTED`, naming the offending configurations, event and missing awaited completion-decision capability. V1 rejection is an accepted limitation. V2 rejection is a supported-subset boundary while its completion adapter remains unintegrated; full V2 Stop parity remains required. See [the compatibility exception](docs/compatibility.md#v1-stop-exception).

Licensed under AGPL-3.0-only.
