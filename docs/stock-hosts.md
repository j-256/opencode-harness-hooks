# Supported subset on stock OpenCode

The default package targets OpenCode V1 1.19.5 and V2 2.2.5 without host patches. The supported subset uses foreground command handlers and the documented [Claude HTTP subset](http-hooks.md) on the prompt and tool paths below. The [bounded V1 delivery profile and gap register](v1-compatibility.md) separate useful delivery from complete native equivalence and the V2 integration track. The subset does not establish a complete configuration migration or native trust/lifecycle parity, so the package's full-equivalence verdict remains false.

## Behavior and boundaries

| Area | Supported subset | Boundary |
| --- | --- | --- |
| Sources | Explicit Claude settings/hooks JSON and Codex hooks JSON or inline TOML; sources may be mixed | No automatic global discovery or native configuration-policy/trust replication |
| Registrations | Each selected registration executes independently | No deduplication; equivalent policies from both sources can run twice |
| `UserPromptSubmit` | Command-based blocking and dialect-specific context delivery across accepted text prompts | V1 custom authentication fetch loaders require explicit composition; full attachment, provider, resume and lifecycle coverage remains required |
| `PreToolUse` | Command-based denial, whole input replacement and selected Claude preapproval | Forced approval, deferred execution, complete permission precedence and arbitrary cross-tool translations remain unverified |
| `PostToolUse` | Foreground observation of effective arguments; V1 context/feedback and one Codex string result replacement | V2 default effect delivery needs its service; structured/conflicting replacements and full native rendering remain gaps. Completed effects cannot be undone |
| Completed nonzero V1 shell calls | Claude failure hooks and Codex post-tool hooks, with selected context/feedback/replacement delivery | Other failures, interruption, exact native envelopes and V2 routing remain gaps; see [failure boundaries](runtime.md#v1-completed-shell-failures) |
| Claude HTTP | Selected pre-tool denial/allow, post-tool effects and prompt additional context | Tool fault dispositions have native comparisons; prompt failure artifacts and broader HTTP policies remain gaps; Codex HTTP is not a supported native handler |
| Stop | Prominent incompatible-configuration error and fatal admission/execution guards | Enabled selected Stop is incompatible with both default entrypoints; V1 rejection is an accepted host limitation and V2 completion remains a separate track |
| Startup | Fresh startup context/artifacts and Claude opaque shell replay through public V1 APIs | See [startup delivery](v1-startup-assessment.md) for timing, transport and remaining native-effect coverage; [durable state](session-state.md) covers the exercised owned cold-resume subset |
| Ordinary async commands | Default V1 scheduler, separate native context/UI channels, retained history, and custom-service ownership | [Background controls](compatibility.md#background-execution) include default-factory behavior and named native active-turn/Claude idle cases; complete timing, broader carrier forms, and full UI presentation remain proof gates |
| Claude asyncRewake | [Owned active-tool and idle notification delivery](rewake.md), retained context/history and separate UI | Selected text notification comparisons and controlled races; full native queued-human emulation, timing, media, UI and other providers remain unfinished |
| Other events and services | Explicit unsupported diagnostics for unavailable events/services | Broader lifecycle, model/agent/MCP behavior, conditions, and native extensions remain pending |

The actual-host fixtures use controlled shell commands and a declared permission mode. Their results do not certify arbitrary source scripts or all host tools. File-operation translation between patch and Edit/Write algorithms requires its own evidence. POSIX/macOS execution does not establish Windows support.

The default V1 prompt transport is incompatible with providers that supply a custom fetch through an authentication loader without [explicit provider composition](v1-provider-composition.md). The pinned host reapplies provider configuration after authentication-loader options, so the prompt wrapper replaces that loader's fetch. This can discard credential injection and cause authentication failures. A credential-injecting loader reproduces this limitation; a passthrough fetch alone does not establish credential preservation. Tool-only configurations do not install the prompt wrapper and can use that authentication path. Use the composition helper and verify the intended provider before enabling `UserPromptSubmit` with a custom authentication-fetch provider. See the pinned host's [provider initialization](https://github.com/anomalyco/opencode/blob/v1.19.5/packages/opencode/src/provider/provider.ts) and [LLM initialization](https://github.com/anomalyco/opencode/blob/v1.19.5/packages/opencode/src/session/llm.ts).

V1 internal model requests are isolated from primary prompt projection by comparing the executing agent with the originating message's agent. The prompt probe verifies automatic title completion and absent private correlation headers on provider requests. Matching identities remain primary even when the selected agent is named `title`; missing identity does not bypass primary validation.

Post-tool context differs from prompt-submission context. Default V1 supplies the documented [tool-result context, feedback and string replacement delivery](runtime.md#v1-tool-context-and-feedback); V2 default effect delivery remains a separate boundary. An explicit effect service owns custom delivery. Unsupported post-tool effects produce diagnostics after execution rather than retroactively denying the tool.

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

Before replacing an existing policy plugin, follow the [isolated migration trial](migration-trial.md) procedure. Source-specific exceptions, file-tool translations and lifecycle ownership require their own comparisons even when the bounded package controls pass.

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

## Configured denial control

```sh
node scripts/verify-plugin.mjs --host v1 --dialect mixed --deny-precedence
```

This stock V1 control requires a configured command denial to remain authoritative over native allow/input rewriting. It checks absent original/replacement filesystem effects, independent source invocations and an owned model-visible denial. Select either individual dialect for the corresponding control. The existing `--preapproval` probe separately verifies execution under host `ask`. These controls do not certify full native permission precedence, forced ask or deferred resumption.
