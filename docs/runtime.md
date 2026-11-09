# Runtime configuration

The package root exports one default definition: `id`, `server()` for OpenCode V1 and `setup()` for V2. Both entrypoints use the same source loader, session coordinator and dispatcher. Library helpers and service interfaces are exported separately from `opencode-harness-hooks/core`, so V1 does not interpret helper exports as additional plugins.

The host contract pins are V1 1.19.5 and V2 2.2.5. The runtime report names the selected contract version; it does not detect or certify an arbitrary installed host version. The executable probes check the actual version before running.

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

`reviewedDigests` pins the exact configuration bytes that the caller reviewed. An absent or different digest prevents activation. The runtime emits a metadata-only source report before execution, including the digest, enabled state, selected events, exclusions and unwired events. This review layer is a bridge extension. It does not implement or certify native Codex hook trust, managed configuration rules, plugin content fingerprints, or Claude project trust. Native trust remains an acceptance gate.

The runtime retains its immutable source snapshot for the lifetime of that plugin activation, including subsequent sessions. Editing a configuration file does not replace that snapshot or execute its new registrations. Reactivation reads the source again and requires a matching reviewed digest. The digest covers configuration bytes, not the contents of referenced executables or scripts. No source file is modified.

`permissionMode` is an explicit native-vocabulary projection selected by the caller. It does not change OpenCode permissions, obtain approval, or prove that a native permission mode has equivalent host behavior. Without it or an explicit metadata service, hooks requiring that field fail before execution. A production projection needs separate evidence; the controlled host fixtures declare their mode alongside synthetic host permissions.

## Connected behavior and gaps

The root connects `PreToolUse`, `PostToolUse` and the host's available post-tool failure path. Selecting another event prevents activation with `HOST_EVENT_UNAVAILABLE`; it is not silently ignored. Full event wiring and source-native failure classification remain unfinished. A matching Codex post-tool registration on a host failure produces `HOST_POST_FAILURE_UNVERIFIED` rather than inventing a native failure event.

V1 captures user turn and model IDs from `chat.message` and `chat.params`. V2 captures them from the `prompt` and `context` session hooks. Missing required fields produce `HOST_NATIVE_METADATA_UNAVAILABLE` with the registration and missing field, before any selected executable hook runs. Claude hooks use the [documented transcript projection](transcripts.md) when their host history is supported; unsupported history fails explicitly. Codex permits a null transcript field. Raw host tool-result projection and native model/turn identity equivalence remain separate conformance gates.

The `core` entrypoint exposes `createHarnessHooks`, `setupHarnessHooks`, `createRuntime` and `RuntimeServices` for explicit native metadata, artifact, model, MCP, background and tool-effect services. Providing a callback establishes a service boundary, not evidence that its native semantics are equivalent. The default root provides the supported Claude transcript subset, but not native environment persistence, Codex rollout artifacts, model/agent/MCP hook services, context delivery, preapproval, deferred execution, turn stopping or native extension effects. Missing required services remain unsupported. Native nonblocking command failures retain their native outcome and produce structured dispatch diagnostics.

Session metadata is isolated by session ID. New prompt IDs cancel old foreground work while preserving the session lifetime used by background services. Model updates carrying an older turn ID are rejected. Closed session IDs remain closed for that activation, so delayed events cannot reopen them. The coordinator retains a bounded number of session identities, including closed identities, and rejects excess sessions instead of evicting active state. `Sessions.inspect()` reports the limit and retention. Cold resume, subagent identity, synthetic prompts, host interruptions and source-native lifecycle delivery remain acceptance gates.

The V2 cleanup function cancels runtime work and removes tool and metadata registrations, including partial setup. Explicit V1 helper disposal also cancels work. Automatic awaited V1 teardown remains unverified. Diagnostics contain source/registration IDs, revisions, outcomes and timings, excluding commands, paths, payloads and output. Diagnostic observer failures do not alter a hook decision; `createRuntime().inspect()` exposes their count.

## Reproduce package loading and tool enforcement

Build first, then run the same probe against each installed pinned executable:

```sh
npm run build
npm run test:host:plugin -- --host v1 --binary /path/to/v1/opencode
npm run test:host:plugin -- --host v2 --binary /path/to/v2/opencode
```

The probe supports `-h`, `--help`, `-b`, `--binary`, `--dialect`, `OPENCODE_V1_BINARY` and `OPENCODE_V2_BINARY`. It uses the actual built default entrypoint and native plugin-options format. It isolates HOME, configuration, state, temporary files and project files; supplies a synthetic native source and loopback provider; checks that denial prevents a file write and that a rewritten command executes; verifies native payload metadata and the final answer; then stops its own host and removes its own temporary files. The default dialect is `codex`. Selecting `claude-code` additionally verifies that the hook reads its generated transcript. Selecting `mixed` checks independent invocations from both dialects using the same synthetic file and command. Generated hooks are syntax-checked before host startup. It installs no binary and changes no live configuration.

The successful JSON report deliberately retains `equivalent: false`. This probe establishes the exercised package and tool mechanisms, not complete native compatibility or permission-mode equivalence. The independent V2 idle probe remains available as `npm run test:host:v2`.
