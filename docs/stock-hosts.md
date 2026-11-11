# Supported subset on stock OpenCode

The default package targets OpenCode V1 1.19.5 and V2 2.2.5 without host patches. The supported subset uses foreground command handlers on the prompt and tool paths below. It does not establish full Claude Code or Codex compatibility, a complete configuration migration, or native trust and lifecycle parity. The package's full-equivalence verdict remains false.

## Behavior and boundaries

| Area | Supported subset | Boundary |
| --- | --- | --- |
| Sources | Explicit Claude settings/hooks JSON and Codex hooks JSON or inline TOML; sources may be mixed | No automatic global discovery or native configuration-policy/trust replication |
| Registrations | Each selected registration executes independently | No deduplication; equivalent policies from both sources can run twice |
| `UserPromptSubmit` | Command-based blocking and dialect-specific context delivery across accepted text prompts | Full attachment, provider, resume and lifecycle coverage remains required |
| `PreToolUse` | Command-based denial, whole input replacement and selected Claude preapproval | Forced approval, deferred execution, complete permission precedence and arbitrary cross-tool translations remain unverified |
| `PostToolUse` | Foreground command observation of the executed effective arguments | Default model-context delivery and other post-tool output effects remain unsupported; completed tool effects cannot be undone |
| Stop | Prominent incompatible-configuration error and fatal admission/execution guards | Enabled selected Stop is incompatible with both default entrypoints; V1 rejection is the sole accepted full-project exception |
| Other events and services | Explicit unsupported diagnostics for unavailable events/services | Startup, native environment persistence, complete model/agent/MCP/background delivery and native extensions remain integration gates |

The actual-host fixtures use controlled shell commands and a declared permission mode. Their results do not certify arbitrary source scripts or all host tools. File-operation translation between patch and Edit/Write algorithms requires its own evidence. POSIX/macOS execution does not establish Windows support.

V1 internal model requests are isolated from primary prompt projection by comparing the executing agent with the originating message's agent. The prompt probe verifies automatic title completion and absent private correlation headers on provider requests. Matching identities remain primary even when the selected agent is named `title`; missing identity does not bypass primary validation.

Post-tool context differs from prompt-submission context. The default package delivers the exercised prompt-submission context; post-tool context requires an explicit core effect service and is not part of this default-package subset. Unsupported post-tool effects produce diagnostics after execution rather than retroactively denying the tool.

## Select native sources explicitly

Create an options JSON file using the native configuration paths you intend to review. This example selects prompt/tool events and explicitly excludes Stop and lifecycle events from both sources:

```json
{
  "sources": [
    {
      "id": "claude",
      "dialect": "claude-code",
      "path": "/path/to/claude/settings.json",
      "selection": {
        "events": ["UserPromptSubmit", "PreToolUse", "PostToolUse"]
      }
    },
    {
      "id": "codex",
      "dialect": "codex",
      "path": "/path/to/codex/config.toml",
      "selection": {
        "events": ["UserPromptSubmit", "PreToolUse", "PostToolUse"]
      }
    }
  ],
  "reviewedDigests": {},
  "permissionMode": "default"
}
```

Keep only one source when testing a standalone profile. Source paths resolve independently; selecting multiple files does not merge their native settings layers. Codex managed settings, effective feature requirements and hook state need the explicit [configuration context](runtime.md#codex-configuration-context) and retain their authentication/trust limitations.

Run the [read-only inspector](inspection.md), review the selected registrations, exclusion reasons and unresolved capabilities, and copy each reviewed source's reported digest into `reviewedDigests` under its source ID:

```sh
npm ci
npm run build
node dist/cli.js inspect --host v1 --directory /path/to/project options.json
node dist/cli.js inspect --host v2 --directory /path/to/project options.json
```

An empty or stale review map cannot activate hooks. Configuration edits require another review. The digest covers configuration and declared context; it does not authenticate referenced executables. `permissionMode` declares a native-vocabulary projection and does not change OpenCode permissions or prove mode equivalence.

Use the reviewed options object as V1's plugin tuple options or V2's plugin entry `options`, following [runtime configuration](runtime.md#options-and-snapshot-review). For a source checkout, V1 can load the absolute file URL of `dist/index.js`; V2 can load the absolute package directory. The native configurations are read without modification.

## Incompatible configurations

The default package reports known source-review, source-loading and event/capability activation failures and retains only fatal guards. This is necessary because a host can disable a plugin after a setup exception and continue without its hooks. Rejected configurations cannot execute selected hooks or admit model requests through those guarded paths. Unexpected host registration failures retain their original error and cleanup behavior.

Selected enabled Stop registrations fail with `HOST_STOP_UNSUPPORTED`. The message identifies every offending source/config, Stop and the unavailable `awaited-completion-decision` capability. Even a host advertising `session.response.completed` fails with `verified-completion-adapter` until the consumer is integrated and verified. The plugin does not approximate Stop with idle or silently exclude it. Explicit source selection and native disablement remain visible in the inspection report.

The explicit core idle prototype and isolated host-patch experiments are separate from this stock-host contract. Full V2 Stop parity remains required for the original complete compatibility objective.

## Reproduce the default-package subset

From a source checkout, the package probe uses isolated HOME/config/state, temporary Git repositories and a loopback provider. It installs no host and changes no live settings. Build first and supply the pinned stock binaries:

```sh
npm run test:host:plugin -- --host v1 --dialect mixed --prompts --preapproval --binary /path/to/v1/opencode
npm run test:host:plugin -- --host v2 --dialect mixed --prompts --preapproval --binary /path/to/v2/opencode
npm run test:host:plugin -- --host v1 --dialect mixed --stop-rejection --binary /path/to/v1/opencode
npm run test:host:plugin -- --host v2 --dialect mixed --stop-rejection --binary /path/to/v2/opencode
npm run test:host:plugin -- --host v1 --dialect mixed --review-rejection --binary /path/to/v1/opencode
npm run test:host:plugin -- --host v2 --dialect mixed --review-rejection --binary /path/to/v2/opencode
```

Use `--dialect claude-code` or `--dialect codex` to exercise each source separately. Omit `--preapproval` for Codex: its allow-with-replacement contract does not request Claude-style preapproval. Prompt mode checks blocked admission before provider calls, every selected dispatch, native context roles, observed Claude completion order, Codex configuration order, retained context and private-header removal. A timed-out child may expire before recording startup; timeout outcomes and native artifacts remain checked. Rejection modes check actionable diagnostics and absent model/hook execution. Successful JSON reports retain `equivalent: false` because these checks cover only the documented subset. Package privacy and isolated-consumer checks are available through `npm run test:package`.
