# V1 compatibility and implementation status

The target is every native hook behavior that can be implemented through stock V1 APIs. Only demonstrated missing host capabilities are terminal gaps. Supported subsets can be used while the remaining implementation and proof proceeds; missing default services, mappings or tests are pending work. `equivalent: false`, `nativeConformant: false` and complete-profile failures retain their broader meaning.

The profile covers explicitly selected foreground command hooks, the documented Claude HTTP subset and bounded Claude prompt-model evaluation on the prompt and tool paths below. Use the pinned versions in the [compatibility contract](compatibility.md), review source digests, and select supported events using the [stock-host configuration guide](stock-hosts.md). An arbitrary complete native configuration is not automatically compatible. Selected unsupported events fail activation rather than disappearing silently. Live activation, private migration acceptance, publication, and V2 integration remain separate review steps.

## Capability and gap register

`Supported` identifies a usable bounded behavior with controlled evidence, not exhaustive native conformance. `Partial` identifies an implemented subset and its boundary. `Pending` identifies missing default-plugin bindings, services or proof that must still be implemented. `Unverified` identifies missing proof and must not be interpreted as impossible. `Host limitation` is reserved for a demonstrated unavailable host capability. The register records the disposition of each gap; it does not turn diagnostic coverage into native equivalence.

| Capability | V1 status and evidence | Remaining gap and disposition |
| --- | --- | --- |
| Explicit Claude and Codex source files, source selection, review digests and mixed registrations | Supported; [configuration and snapshot review](runtime.md#options-and-snapshot-review), loader tests and installed source controls | No automatic discovery or replication of native trust/managed-policy ownership; explicit selection is the profile boundary |
| Registration identity and repetition | Supported; each selected registration executes independently | Intentional no-deduplication behavior; equivalent policies selected from both dialects can execute twice |
| Foreground command execution | Supported for selected prompt/tool events; [native comparisons](../conformance/README.md) and installed package probes | Native shell/environment policy and all command-option combinations are not exhaustively certified |
| Pre-tool denial and unchanged execution | Supported for controlled shell calls; native Claude/Codex deny/allow-control comparisons | Selected V1 configured-deny controls have separate host evidence; forced approval and full native permission precedence remain unverified |
| Pre-tool input replacement | Supported for controlled shell calls; native input-rewrite comparisons verify original/effective arguments, side effects and model results | Other tool families, competing rewrites and whole-object behavior have separate evidence; no universal cross-tool claim |
| Claude post-tool feedback and context | Supported for selected text results; [post-tool comparisons](posttool-conformance.md) verify preservation, role/channel, placement and sequential-call isolation | Exact reminder wrapping, artifacts and general history persistence remain unverified |
| Codex post-tool result replacement | Supported for one string replacement on a classified writable text result; native shell comparison verifies feedback replaces original model output while completed effects remain | Structured/Claude replacement actions, competing replacements, code-mode nested promise rejection and non-text result layouts remain outside this delivery path |
| Hook-provided text budgets and output ownership | Supported; per-call state, combined UTF-8 text budget, immutable-result and lifecycle tests | Oversized, immutable, unreadable or unsupported output is diagnosed without truncation or retroactive denial of completed tool effects |
| `UserPromptSubmit` blocking and context | Partial; [prompt guide](prompts.md), native references and controlled host probes | Text prompts and verified provider transports, including [owned cold-resume context](session-state.md); attachments and complete lifecycle/persistence coverage remain gaps |
| Custom authentication fetch providers | Partial; [explicit V1 provider composition](v1-provider-composition.md) | Prompt hooks need verified composition with the intended provider; tool-only command use avoids that prompt-transport boundary; prompt-model handlers need the verified evaluator transport |
| Tool preapproval | Partial; [owned preapproval delivery](runtime.md#tool-preapproval) and controlled installed probes, including selected V1 configured-command denial controls | Full native configured-permission precedence, forced `ask`, deferred execution, `PermissionRequest` hook delivery and complete policy precedence need default-host integration/evidence |
| Claude and Codex transcripts | Partial; [Claude projections](transcripts.md) and [Codex tool transcripts](codex-transcripts.md) | Selected observed text/tool history and [owned cold reconstruction](session-state.md); attachments, compaction, pre-plugin originals, remaining native records and automatic awaited V1 teardown remain gaps |
| Post-tool failures | Partial; [completed nonzero V1 shell calls](runtime.md#v1-completed-shell-failures) deliver Claude failure/error/context and Codex post-tool raw output/replacement, with native comparisons and mixed-source tests | Unknown/non-shell failures, interrupted calls, V2 routing, exact error envelopes, stderr ordering and full artifacts remain unverified; unclassified matching Codex failures retain `HOST_POST_FAILURE_UNVERIFIED` |
| HTTP handlers | Partial; [Claude HTTP tool comparisons and installed prompt context](http-hooks.md) | Codex HTTP is absent from the pinned native format. HTTP prompt failure artifacts fail explicitly; broad policies, rendering, authentication and V2 effects remain gaps |
| Prompt hook model service | Partial; [default V1 evaluator sessions](model-hooks.md) and native submission control/artifact comparison | Explicit model aliases and verified provider transports; API retries, other provider formats, broader events and full model semantics remain pending proof |
| Agent hook service | Partial; [owned default V1 agent sessions](model-hooks.md#agent-execution-evidence), nested policies, bounded inference and exact-call permission replies | Independent public native comparison, broader readonly shell classification, full rendering/permission precedence and other providers/events remain pending implementation and proof |
| MCP hook service | Pending in the default profile; engine service interface exists | Native skip behavior is retained where applicable; required absent services report unsupported. A missing binding is future integration work, not a proven host impossibility |
| Background, rewake, conditions and environment persistence | Pending or incomplete default services; [lifecycle](lifecycle.md) and engine implementations document their seams | Retain explicit unsupported outcomes where a required service is absent; source-native timing, ownership and persistence need separate integration |
| Startup and other lifecycle events | Fresh startup subset supported; [startup guide](v1-startup-assessment.md) documents actual native/V1 comparisons and cancellation/ownership checks | Owned text/tool history and retained startup context survive cold resume; remaining effects, broader source transitions and other events are pending implementation |
| Enabled selected `Stop` | Host limitation; V1 lacks an awaited completion decision. Both dialects have actual fatal-load rejection evidence | Configurations remain incompatible with V1. Keep prominent config/event/capability failure; do not skip Stop or approximate it with idle |
| Full native rendering, trust, source reload, resume, synthetic/subagent lifetimes and all platform/provider combinations | Unverified or outside the profile; [conformance inventory](../conformance/README.md) preserves the broader obligations | Document and retain their separate status; these are pending implementation and proof |
| V2 native hook integration and Stop parity | Separate track; shared engine and V2 entrypoint remain available | V2 default capability gaps and retained integration work do not require a V1 host change or block this V1 profile |

A missing default binding is not the same as a host limitation. New direct mappings can be added when their event, metadata, effect and lifecycle contracts can be verified. A broad unsupported or unverified requirement does not force the profile to wait indefinitely for upstream changes.

## Pinned event coverage

The following table inventories every event in the pinned source catalogs. `Partial` refers to the supported/profile boundaries above. `Pending` means selecting the event prevents default-plugin activation; it does not establish that a future binding is impossible. `n/a` means the event is absent from that dialect's pinned catalog.

| Native event | Claude Code on V1 | Codex on V1 |
| --- | --- | --- |
| `SessionStart` | Partial; fresh context/artifacts/environment | Partial; fresh context/journal |
| `Setup` | Pending | n/a |
| `InstructionsLoaded` | Pending | n/a |
| `UserPromptSubmit` | Partial; documented profile | Partial; documented profile |
| `UserPromptExpansion` | Pending | n/a |
| `MessageDisplay` | Pending | n/a |
| `PreToolUse` | Partial; documented profile | Partial; documented profile |
| `PermissionRequest` | Pending | Pending |
| `PostToolUse` | Partial; documented profile | Partial; documented profile |
| `PostToolUseFailure` | Partial; documented profile | n/a |
| `PostToolBatch` | Pending | n/a |
| `PermissionDenied` | Pending | n/a |
| `Notification` | Pending | n/a |
| `SubagentStart` | Pending | Pending |
| `SubagentStop` | Pending | Pending |
| `TaskCreated` | Pending | n/a |
| `TaskCompleted` | Pending | n/a |
| `Stop` | Host limitation; fatal load rejection | Host limitation; fatal load rejection |
| `StopFailure` | Pending | n/a |
| `TeammateIdle` | Pending | n/a |
| `ConfigChange` | Pending | n/a |
| `CwdChanged` | Pending | n/a |
| `DirectoryAdded` | Pending | n/a |
| `FileChanged` | Pending | n/a |
| `WorktreeCreate` | Pending | n/a |
| `WorktreeRemove` | Pending | n/a |
| `PreCompact` | Pending | Pending |
| `PostCompact` | Pending | Pending |
| `PreModelSwitch` | Pending | n/a |
| `PostModelSwitch` | Pending | n/a |
| `SessionEnd` | Pending | Pending |
| `Elicitation` | Pending | n/a |
| `ElicitationResult` | Pending | n/a |
| `PreModelRequest` | n/a | Pending |
| `PostModelRequest` | n/a | Pending |
| `Interrupt` | n/a | Pending |

## Delivery checks

Use focused implementation checks and the controlled native/host cases for the supported behavior being changed. Preserve the inspector's exclusions and unsupported diagnostics, run the documented package and installed-host checks, and keep the gap register synchronized with behavior changes. A passing bounded profile does not justify changing full-equivalence flags or promoting untested catalog rows.

Configuration migration still needs its own [intended-source review and isolated project trial](migration-trial.md). The profile's compatibility boundary does not authorize editing native hooks, live settings, installing host patches, or publication.
