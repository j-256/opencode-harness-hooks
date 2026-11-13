# Trial an existing hook migration

A passing [bounded V1 profile](v1-compatibility.md) establishes the plugin's documented behavior. It does not establish equivalence with a project-specific plugin or an arbitrary complete Claude/Codex configuration. Review the intended source selection and compare observable policy behavior in an isolated project before replacing an existing integration.

Use a disposable project copy and separate HOME, XDG configuration/state/cache and host processes. Load the legacy plugin only in the baseline process. Load only harness-hooks in each candidate process and test Claude and Codex sources separately before any mixed-source trial. Read back the effective plugin selection; merely configuring a candidate alongside the legacy enforcer cannot prove the candidate enforced anything. Keep source files and referenced hooks unchanged, record their hashes and fingerprint the built adapter before and after the run.

Select only supported events and intended policy owners using the [inspector](inspection.md) and [stock-host guide](stock-hosts.md). Keep excluded registrations visible in the report, with ownership and reason. Selected enabled Stop and startup remain incompatible with the default V1 profile. Excluding an event to run a focused trial does not establish full-file compatibility. Mixed configurations run independent registrations without deduplication; selecting duplicate private policies can intentionally cause repeated effects.

Use literal deny and allow controls for each selected policy. Verify hook invocation or source selection, original/effective input, absent or completed filesystem effects, the owned model-visible reason or context, output placement and a final successful response. Include intentional policy exceptions as separate controls. Compare expected behavior for each unchanged source before comparing it with the legacy baseline; a different native exception variable or missing source registration can be a genuine source-contract difference rather than a translation bug. Preserve counterexamples and failed migration verdicts instead of rewriting private policies inside the portable plugin.

## Result register

| Outcome | Required evidence and disposition |
| --- | --- |
| Matched controlled behavior | Both profiles satisfy literal positive/negative expectations at the installed host boundary; report only the tested workload |
| Source-contract difference | Unchanged sources deliberately make different decisions or lack a required registration; record the counterexample and obtain separate source-migration approval |
| Adapter gap | Source meaning can be expressed but the binding, metadata, effect or tool translation is missing; retain a focused failure and implementation requirement |
| Unverified | Required workload, provider or lifecycle has no complete comparison; do not count matcher coverage or an engine-only run as host equivalence |
| Accepted V1 limitation | Enabled Stop rejects prominently; verify rejection rather than silently skipping or approximating completion |

File-write and patch hooks need their own workloads. Matching Edit/Write and apply_patch registrations does not prove equivalent multi-file operations, moves/deletes, failed edits, input rewriting or post-tool data. Startup context, instruction/state ownership, queues, child sessions, protected configuration and cold resume also need independent intended-source evidence. Do not run external side effects merely to fill a coverage table; use explicitly isolated state or retain the unverified row.

Keep private configurations, source paths, payloads and policy-specific reports outside portable artifacts. A useful bounded plugin can pass its delivery checks while a particular migration remains partial or incompatible. Live activation, adopting source changes and publication retain their separate review boundaries.
