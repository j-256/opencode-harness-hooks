# Runtime configuration

The package root exports one default definition: `id`, `server()` for OpenCode V1 and `setup()` for V2. Both entrypoints use the same source loader, session coordinator and dispatcher. Library helpers and service interfaces are exported separately from `opencode-harness-hooks/core`, so V1 does not interpret helper exports as additional plugins.

The host contract pins are V1 1.19.5 and V2 2.2.5. The runtime report names the selected contract version; it does not detect or certify an arbitrary installed host version. The executable probes check the actual version before running.

The core `Sessions.interrupt(owner)` operation aborts only the captured current turn, preserving its session for another real prompt. It compares session and turn IDs and both lifetime signals before aborting. It returns `true` only when that call interrupts the matching live turn; stale, foreign, already cancelled, closed or disposed owners return `false` without creating a session or affecting a replacement prompt. Native event classification and interruption artifact admission remain separate operations.

## Options and snapshot review

Both hosts accept the same plugin options object. V1 passes it as the second element of a plugin tuple; V2 uses the plugin entry's `options` property. Paths below are examples, not automatic source discovery.

```json
{
  "sources": [
    {
      "id": "native",
      "dialect": "codex",
      "path": "hooks.json"
    }
  ],
  "reviewedDigests": {
    "native": "<sha256-of-the-reviewed-file-bytes>"
  },
  "permissionMode": "default"
}
```

Each source needs a unique ID, a dialect (`codex` or `claude-code`), and a native configuration path. Source selection, `projectRoot` and `pluginRoot` use the loader's existing `SourceSpec` contract. Relative paths resolve against the host's project directory. Sources retain their configured order and independent registrations.

The [read-only inspector](inspection.md) loads these options without executing hooks. It reports selected and excluded registrations, review matches and capability gaps using the same metadata report as activation.

`reviewedDigests` pins the exact configuration bytes that the caller reviewed. An absent or different digest prevents activation. The runtime emits a metadata-only source report before execution, including the digest, enabled state, selected events, exclusions and unwired events. This review layer is a bridge extension. It does not implement or certify native Codex hook trust, managed configuration rules, plugin content fingerprints, or Claude project trust. Native trust remains an acceptance gate.

The runtime retains its immutable source snapshot for the lifetime of that plugin activation, including subsequent sessions. Editing a configuration file does not replace that snapshot or execute its new registrations. Reactivation reads the source again and requires a matching reviewed digest. The digest covers configuration and declared context, while referenced executables and scripts require separate provenance. No source file is modified.

`permissionMode` is an explicit native-vocabulary projection selected by the caller. It does not change OpenCode permissions, obtain approval, or prove that a native permission mode has equivalent host behavior. Without it or an explicit metadata service, hooks requiring that field fail before execution. A production projection needs separate evidence; the controlled host fixtures declare their mode alongside synthetic host permissions.

## Codex configuration context

A Codex source can declare the native settings layers that affect its hooks. This example selects registrations from `hooks.json` and reads their user settings from `config.toml`:

```json
{
  "id": "native",
  "dialect": "codex",
  "path": "hooks.json",
  "codexConfig": {
    "sourceLayer": 0,
    "layers": [
      { "scope": "user", "path": "config.toml" }
    ]
  }
}
```

`layers` is ordered from low to high precedence. Each layer has `scope: "user"`, `"session"` or `"other"`, an optional `disabled` boolean, and exactly one of `path` or `settings`. File layers read explicit TOML paths. Session layers use `settings`, a normalized native layer table supplied by the caller or metadata service. A selected profile can also be supplied as a normalized user layer. Relative layer paths resolve against the host project directory. The native `config/read` response lists layers in the opposite order; a caller using that response must reverse it.

Only the selected source's `path` supplies registrations. Configuration layers supply settings and never import their hook definitions. A selected inline TOML source must appear as a file layer in its explicit stack. Without `codexConfig`, an inline TOML source retains its own user-style settings and a JSON source has no external settings projection. No global layers are discovered automatically.

User and session layers may supply per-hook state, including when a layer is disabled. Other origins, including project and managed layers, cannot write user hook state. Later eligible layers merge enablement and native trust-hash fields independently. Native key trimming and raw table order are preserved. Effective active configuration is validated separately: a later layer can repair a malformed lower field, while raw state extraction still skips that malformed lower entry. Parsed trust hashes do not grant native hook trust in the adapter.

Active layers supply ordinary feature flags. The canonical `hooks` flag takes precedence over its deprecated `codex_hooks` alias after merging. Optional `featureRequirements: { "hooks": true }` or `false` projects the native effective requirement and takes precedence over those flags. The caller supplies its native provenance. `sourceLayer`, when present, identifies the owning layer by index; disabling that layer excludes the source's registrations. Context authentication, native source discovery and full managed policy behavior remain required integration work, reported as `codex-config-context-authentication`. Declaring a context does not establish those capabilities.

An explicit context changes the review digest to a versioned aggregate of the primary source identity and bytes, ordered layer identities and content, owning-layer index and feature requirements. Inline settings retain JSON entry order because trimmed-key collisions can depend on it. Use the inspector's digest for `reviewedDigests`; hashing only the primary file is insufficient. Without a context, the primary-file SHA-256 remains unchanged. File and inline inputs share the source byte ceiling, with bounded immutable snapshots created before asynchronous reads. Accessors, unsupported JSON values, cycles and excessive nesting are rejected. Reports contain layer scope, digest and disablement metadata while omitting layer paths and unrelated settings.

## Connected behavior and gaps

The root connects `UserPromptSubmit`, `PreToolUse`, `PostToolUse` and the host's available post-tool failure path. The pinned V2 root also connects the supported foreground Claude command [Stop path](stop.md#default-v2-integration). Selecting another event prevents activation with `HOST_EVENT_UNAVAILABLE`; it is not silently ignored. Full event wiring and source-native failure classification remain unfinished. A matching Codex post-tool registration on a host failure produces `HOST_POST_FAILURE_UNVERIFIED` rather than inventing a native failure event.

V1 has a specific rejection for enabled `Stop` registrations: `HOST_STOP_UNSUPPORTED`. This fatal load error identifies every offending configuration by source ID, dialect and resolved path, names `Stop` and the unsupported `awaited-completion-decision` capability, and prevents activating the runtime or executing a model request. It takes precedence over generic event and review-digest gates after loading the source snapshot. Both native dialects, mixed sources and every selected handler family follow this rule, including handlers with matchers or conditions. The error excludes command bodies and other configuration contents. Native disablement and explicit source selection remain visible exclusions; the bridge never silently removes a selected Stop registration. This rejection is the expected [V1 compatibility exception](compatibility.md#v1-stop-exception), while V2 Stop integration remains required.

The pinned V1 loader catches both server initialization and configuration-hook errors and continues. The core activation helpers therefore throw, while the default root retains only rejection guards for the failed configuration. It emits an error diagnostic at load, requests an error toast through the host's TUI service when available, throws from its configuration callback, and rejects prompt, model-preparation and tool callbacks. No runtime or native hook dispatch is admitted. A failed notice cannot remove these guards. This handles V1's swallowed load errors without approximating Stop or modifying OpenCode.

Notice delivery has a bounded lifetime and runs independently of the configuration callback, because the host's notice request can wait for initialization to finish. Disposal cancels and drains that request. Load and notice diagnostics share a failure ID, with notice timings and separate accepted/failed outcomes. The host fixture verifies notice acceptance, configuration rejection and absent provider/hook execution; it does not claim rendered TUI inspection.

V1 captures user turn and model IDs from `chat.message` and `chat.params`. V2 captures them from the `prompt` and `context` session hooks. Missing required fields produce `HOST_NATIVE_METADATA_UNAVAILABLE` with the registration and missing field, before any selected executable hook runs. Claude hooks use the [documented transcript projection](transcripts.md) when their host history is supported; unsupported history fails explicitly. Codex permits a null transcript field. Raw host tool-result projection and native model/turn identity equivalence remain separate conformance gates.

Selected Claude sources also observe model preparation through V1 `chat.headers` and V2 primary `model.request`, including configurations with no prompt hooks. The transcript uses that observed local date rather than inventing historical runtime context. V2 validates the context's native user ID and retains its turn lifetime until the model callback; stale callbacks fail before recording metadata. Custom artifact services may implement the optional `observeModel` interface. See [observed model dates](transcripts.md#observed-model-dates) for ordering, cancellation and unsupported boundaries.

The `core` entrypoint exposes `createHarnessHooks`, `setupHarnessHooks`, `createRuntime` and `RuntimeServices` for explicit native metadata, artifact, model, MCP, background and effect services. Providing a callback establishes a service boundary, not evidence that its native semantics are equivalent. The default root provides the supported Claude transcript subset, [prompt admission and context delivery](prompts.md), foreground V2 Claude Stop continuation, and tool preapproval described below. Native environment persistence, Codex rollout artifacts, model/agent/MCP hook services, other event context delivery, forced approval requests, deferred execution, complete turn-stop behavior and native extension effects need further integration. Missing required services remain unsupported. Native nonblocking command failures retain their native outcome and produce structured dispatch diagnostics.

Session metadata is isolated by session ID. New prompt IDs cancel old foreground work while preserving the session lifetime used by background services. Model updates carrying an older turn ID are rejected. Closed session IDs remain closed for that activation, so delayed events cannot reopen them. The coordinator retains a bounded number of session identities, including closed identities, and rejects excess sessions instead of evicting active state. `Sessions.inspect()` reports the limit and retention. Cold resume, subagent identity, synthetic prompts, host interruptions and source-native lifecycle delivery remain acceptance gates.

The V2 cleanup function cancels runtime work and removes tool and metadata registrations, including partial setup. An enabled Stop adapter retains callback guards if SDK submission or runtime artifact drain fails; cleanup can be retried after actual settlement. Submission drain does not establish removal of accepted native inbox inputs, which remains a required Stop reconciliation gate. Explicit V1 helper disposal also cancels work. Automatic awaited V1 teardown remains unverified. Event diagnostics contain source/registration IDs, revisions, outcomes and timings, excluding commands, paths, payloads and output. Load-time incompatibility errors identify configuration paths as described above. Diagnostic observer failures do not alter a hook decision; `createRuntime().inspect()` exposes their count.

## Tool preapproval

A resolved native `PreToolUse` allow installs a temporary approval for that session and tool call. V1 observes `permission.asked` after the host has created its pending request and replies through the pinned SDK with `response: "once"`. V2 uses the awaited `permission.evaluate` hook to change an owned `ask` evaluation to `allow`. An explicit custom `preapprove` service takes precedence over these defaults. If the necessary native host service is missing, allow remains unsupported rather than silently relying on host defaults.

Approval is tied to the active turn, tool call and assistant message. V1's before-tool callback lacks the assistant message ID, so its first owned permission request binds that ID; subsequent requests must match. Finishing or cancelling the call, starting a new turn, closing the session, or disposing the runtime removes its approval. Concurrent calls and sessions retain separate approvals. The bridge does not add persistent permission rules or approve unrelated requests. V1 suppresses repeated delivery of the same permission request, bounds retained requests and pending replies, and reports reply failures without exception text or automatic retries. This delivery guard does not deduplicate native hook registrations or sources.

Host denials remain authoritative. The V2 evaluator preserves `deny`, and V1 only replies to requests the host actually exposes. Full configured-deny precedence, forced `ask`, `PermissionRequest` hook delivery and deferred resumption remain conformance gates. Preapproval establishes the exercised allow mechanism, not complete permission compatibility.

## Reproduce package loading and tool enforcement

Build first, then run the same probe against each installed pinned executable:

```sh
npm run build
npm run test:host:plugin -- --host v1 --binary /path/to/v1/opencode
npm run test:host:plugin -- --host v2 --binary /path/to/v2/opencode
npm run test:host:plugin -- --host v1 --dialect claude-code --preapproval --binary /path/to/v1/opencode
npm run test:host:plugin -- --host v2 --dialect mixed --preapproval --binary /path/to/v2/opencode
npm run test:host:plugin -- --host v1 --dialect mixed --stop-rejection --binary /path/to/v1/opencode
```

The probe supports `-h`, `--help`, `-b`, `--binary`, `--dialect`, `--preapproval`, `--prompts`, `-s`/`--stop-rejection`, `OPENCODE_V1_BINARY` and `OPENCODE_V2_BINARY`. It uses the actual built default entrypoint and native plugin-options format. It isolates HOME, configuration, state, temporary files and project files; supplies a synthetic native source and loopback provider; checks that denial prevents a file write and that a rewritten command executes; verifies native payload metadata and the final answer; then stops its own host and removes its own temporary files. The default dialect is `codex`. Selecting `claude-code` additionally verifies that the hook reads its generated transcript. Selecting `mixed` checks independent invocations from both dialects using the same synthetic file and command. Adding `--preapproval` sets host permissions to `ask`, declares native mode `default`, and emits an explicit Claude allow for the rewritten command. This flag requires `claude-code` or `mixed`: the pinned Codex allow-with-replacement contract requests replacement without native preapproval. Adding `--prompts` also checks blocked admission and native context roles across accepted turns, as described in [prompt submission](prompts.md). Generated hooks are syntax-checked before host startup. It installs no binary and changes no live configuration.

`--stop-rejection` instead verifies the expected V1 load failure. It adds an enabled Stop registration, asserts the host-visible error identifies the config, event and unavailable capability, and proves that no model or hook executes. It supports either dialect or `mixed`, requires `--host v1`, and cannot combine with `--preapproval` or `--prompts`. A passing result reports `expectedStopLoadRejection: true`; it does not claim native Stop execution parity or make a Stop configuration usable on V1.

The successful JSON report deliberately retains `equivalent: false`. This probe establishes the exercised package and tool mechanisms, not complete native compatibility or permission-mode equivalence. The independent V2 idle probe remains available as `npm run test:host:v2`.
