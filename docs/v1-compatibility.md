# Bounded V1 compatibility and gaps

The delivery target is a useful OpenCode V1 plugin without host changes. Success means verified behavior for the documented profile, explicit rejection of incompatible configurations, and an honest gap register. Full native equivalence is a separate target, not a prerequisite for delivering this profile. `equivalent: false`, `nativeConformant: false`, and the complete-profile runner's exit status remain truthful measures of the broader target; they do not mean that the supported subset cannot be used.

The profile covers explicitly selected foreground command hooks and the documented Claude HTTP subset on the prompt and tool paths below. Use the pinned versions in the [compatibility contract](compatibility.md), review source digests, and select supported events using the [stock-host configuration guide](stock-hosts.md). An arbitrary complete native configuration is not automatically compatible. Selected unsupported events fail activation rather than disappearing silently. Live activation, private migration acceptance, publication, and V2 integration remain separate review steps.

## Capability and gap register

`Supported` identifies a usable bounded behavior with controlled evidence, not exhaustive native conformance. `Partial` identifies an implemented subset and its boundary. `Not wired` identifies missing default-plugin bindings or services. `Unverified` identifies missing proof and must not be interpreted as impossible. `Host limitation` is reserved for a demonstrated unavailable host capability. The register records the disposition of each gap; it does not turn diagnostic coverage into native equivalence.

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
| `UserPromptSubmit` blocking and context | Partial; [prompt guide](prompts.md), native references and controlled host probes | Text prompts and verified provider transports only; attachments, cold resume and complete lifecycle/persistence coverage remain gaps |
| Custom authentication fetch providers | Partial; [explicit V1 provider composition](v1-provider-composition.md) | Prompt hooks need verified composition with the intended provider; tool-only use avoids that prompt-transport boundary |
| Tool preapproval | Partial; [owned preapproval delivery](runtime.md#tool-preapproval) and controlled installed probes, including selected V1 configured-command denial controls | Full native configured-permission precedence, forced `ask`, deferred execution, `PermissionRequest` hook delivery and complete policy precedence need default-host integration/evidence |
| Claude and Codex transcripts | Partial; [Claude projections](transcripts.md) and [Codex tool transcripts](codex-transcripts.md) | Selected fresh text/tool history only; attachments, compaction, resumed reconstruction, exact native records and automatic awaited V1 teardown remain gaps |
| Post-tool failures | Partial; [completed nonzero V1 shell calls](runtime.md#v1-completed-shell-failures) deliver Claude failure/error/context and Codex post-tool raw output/replacement, with native comparisons and mixed-source tests | Unknown/non-shell failures, interrupted calls, V2 routing, exact error envelopes, stderr ordering and full artifacts remain unverified; unclassified matching Codex failures retain `HOST_POST_FAILURE_UNVERIFIED` |
| HTTP handlers | Partial; [Claude HTTP tool comparisons and installed prompt context](http-hooks.md) | Codex HTTP is absent from the pinned native format. HTTP prompt failure artifacts fail explicitly; broad policies, rendering, authentication and V2 effects remain gaps |
| Prompt, agent and MCP hook services | Not wired in the default profile; engine service interfaces exist | Native skip behavior is retained where applicable; required absent services report unsupported. A missing binding is future integration work, not a proven host impossibility |
| Background, rewake, conditions and environment persistence | Not wired or incomplete default services; [lifecycle](lifecycle.md) and engine implementations document their seams | Retain explicit unsupported outcomes where a required service is absent; source-native timing, ownership and persistence need separate integration |
| Startup and other lifecycle events | Not wired in the default plugin; [startup assessment](v1-startup-assessment.md) separates reusable core code from missing admission, metadata, replay and resume integration | Keep selected-event load rejection. Awaited first-prompt admission is a candidate boundary; no coherent startup subset has been certified. Other event mappings need individual evidence |
| Enabled selected `Stop` | Host limitation; V1 lacks an awaited completion decision. Both dialects have actual fatal-load rejection evidence | Configurations remain incompatible with V1. Keep prominent config/event/capability failure; do not skip Stop or approximate it with idle |
| Full native rendering, trust, source reload, resume, synthetic/subagent lifetimes and all platform/provider combinations | Unverified or outside the profile; [conformance inventory](../conformance/README.md) preserves the broader obligations | Document and retain their separate status; these gaps do not block the bounded V1 delivery |
| V2 native hook integration and Stop parity | Separate track; shared engine and V2 entrypoint remain available | V2 default capability gaps and retained integration work do not require a V1 host change or block this V1 profile |

A missing default binding is not the same as a host limitation. New direct mappings can be added when their event, metadata, effect and lifecycle contracts can be verified. A broad unsupported or unverified requirement does not force the profile to wait indefinitely for upstream changes.

## Pinned event coverage

The following table inventories every event in the pinned source catalogs. `Partial` refers to the supported/profile boundaries above. `Not wired` means selecting the event prevents default-plugin activation; it does not establish that a future binding is impossible. `n/a` means the event is absent from that dialect's pinned catalog.

| Native event | Claude Code on V1 | Codex on V1 |
| --- | --- | --- |
| `SessionStart` | Not wired | Not wired |
| `Setup` | Not wired | n/a |
| `InstructionsLoaded` | Not wired | n/a |
| `UserPromptSubmit` | Partial; documented profile | Partial; documented profile |
| `UserPromptExpansion` | Not wired | n/a |
| `MessageDisplay` | Not wired | n/a |
| `PreToolUse` | Partial; documented profile | Partial; documented profile |
| `PermissionRequest` | Not wired | Not wired |
| `PostToolUse` | Partial; documented profile | Partial; documented profile |
| `PostToolUseFailure` | Partial; documented profile | n/a |
| `PostToolBatch` | Not wired | n/a |
| `PermissionDenied` | Not wired | n/a |
| `Notification` | Not wired | n/a |
| `SubagentStart` | Not wired | Not wired |
| `SubagentStop` | Not wired | Not wired |
| `TaskCreated` | Not wired | n/a |
| `TaskCompleted` | Not wired | n/a |
| `Stop` | Host limitation; fatal load rejection | Host limitation; fatal load rejection |
| `StopFailure` | Not wired | n/a |
| `TeammateIdle` | Not wired | n/a |
| `ConfigChange` | Not wired | n/a |
| `CwdChanged` | Not wired | n/a |
| `DirectoryAdded` | Not wired | n/a |
| `FileChanged` | Not wired | n/a |
| `WorktreeCreate` | Not wired | n/a |
| `WorktreeRemove` | Not wired | n/a |
| `PreCompact` | Not wired | Not wired |
| `PostCompact` | Not wired | Not wired |
| `PreModelSwitch` | Not wired | n/a |
| `PostModelSwitch` | Not wired | n/a |
| `SessionEnd` | Not wired | Not wired |
| `Elicitation` | Not wired | n/a |
| `ElicitationResult` | Not wired | n/a |
| `PreModelRequest` | n/a | Not wired |
| `PostModelRequest` | n/a | Not wired |
| `Interrupt` | n/a | Not wired |

## Delivery checks

Use focused implementation checks and the controlled native/host cases for the supported behavior being changed. Preserve the inspector's exclusions and unsupported diagnostics, run the documented package and installed-host checks, and keep the gap register synchronized with behavior changes. A passing bounded profile does not justify changing full-equivalence flags or promoting untested catalog rows.

Configuration migration still needs its own [intended-source review and isolated project trial](migration-trial.md). The profile's compatibility boundary does not authorize editing native hooks, live settings, installing host patches, or publication.
