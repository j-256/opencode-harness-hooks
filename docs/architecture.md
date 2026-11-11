# Engine and OpenCode bindings

One compatibility engine serves the external OpenCode V1 and V2 plugins. It owns native Claude Code/Codex configuration, matching, protocol interpretation, dispatch, effect resolution, artifact construction, and session controllers. OpenCode bindings own public API registration, permission application, provider transport, activation guards, and cleanup.

## Package entrypoints

| Import | Purpose |
| --- | --- |
| `opencode-harness-hooks` | Default plugin with automatic V1/V2 selection |
| `opencode-harness-hooks/engine` | Host-neutral engine and injected service interfaces |
| `opencode-harness-hooks/core` | Alias of the engine API |
| `opencode-harness-hooks/opencode` | Binding factories, host context types, and permission helpers |
| `opencode-harness-hooks/v1` | Explicit V1 default plugin |
| `opencode-harness-hooks/v2` | Explicit V2 default plugin |

The default plugin retains V1's passive experimental catalog setup and the fatal admission guards used when a host disables a failed plugin. All entrypoints use the same engine implementation and shared `HostHookError` identity. The explicit V1 plugin rejects V2 setup contexts; the explicit V2 plugin rejects V1 setup contexts.

The engine API exports `createRuntime`, `RuntimeServices`, and `HostServices` for integrations that provide their own host services. Shared tool events, service interfaces, and errors live outside binding implementations. Engine modules and declarations do not depend on plugin registration, OpenCode SDK/server modules, or version-specific adapters. Host-version vocabulary in capability contracts and native artifact projections does not grant those host capabilities.

The unreleased API moves `createHarnessHooks`, `setupHarnessHooks`, `V2Context`, `CallApprovals`, `PermissionEvaluation`, and `PermissionReply` from `/core` to `/opencode`. Consumers that need these binding-specific APIs must update that import. Engine imports can use either `/engine` or `/core`.

## Independent builds and extraction checks

`npm run build` produces the complete distributable package in `dist`. Targeted builds compile only the selected dependency graph into separate output directories:

```sh
npm ci
npm run build:engine
npm run build:v1
npm run build:v2
node --import tsx --test test/separation.test.ts
```

The outputs are `build/engine/core.js`, `build/v1/v1.js`, and `build/v2/v2.js`, with matching declarations. These are compilation artifacts inside the source checkout, rather than independently published packages. A standalone distribution must also supply an ESM package context and the declared runtime dependencies. The extraction tests use fresh output directories: they build and execute a mixed native-source engine consumer with all binding modules absent, and import each version artifact without the other version or the compatibility barrel. Compilation also traverses the declaration dependency graph, so type-only binding leaks fail the boundary checks.

The package verification probe installs the packed artifact in an isolated consumer and checks its public exports and shared error identity. The [stock-host probes](stock-hosts.md#reproduce-the-default-package-subset) execute the external package on unmodified hosts without built-in native hook support. These checks establish the useful external-plugin boundary independently of any future native feature.

The default test command bounds concurrent test files because extraction checks invoke the compiler alongside subprocess-lifetime fixtures. `npm run verify` reuses that command after typecheck and build.

## Native V2 integration boundary

A native V2 feature can consume the engine through its host-service interfaces and invoke it at authoritative internal lifecycle points. Native integration code owns its OpenCode-internal dependencies and applies decisions through native host services. The engine and external plugins remain buildable without that integration.

Native V2 integration is a separate delivery track. The external plugin supports only its [documented stock-host subset](stock-hosts.md), including explicit rejection of selected enabled Stop. Extracting the plugin does not preserve native-only capabilities that its public host API cannot provide. The shared implementation remains AGPL-3.0-only; upstream contribution and distribution licensing require their own reviewed decision.
