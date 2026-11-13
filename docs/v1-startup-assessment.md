# V1 startup delivery assessment

The default V1 plugin rejects selected `SessionStart` registrations. This is missing integration, not a demonstrated impossibility of startup support on V1. The [core coordinator](lifecycle.md) supplies an explicit startup barrier, payload preflight, command execution, environment-file ownership, cancellation and admission interface. It does not supply a default host boundary, native context/artifact admission or shell replay.

The awaited `chat.message` callback used by [prompt submission](prompts.md) is a candidate first-prompt barrier. Installed prompt blocking demonstrates that admission can prevent a model request. That does not identify every native startup source or recreate native startup timing. An unawaited session-created observer alone cannot provide the required barrier. A future adapter could combine notification with awaited admission; the exact lifecycle and recovery contract still needs implementation and proof.

## Capability and disposition

| Requirement | Evidence or missing work | Disposition |
| --- | --- | --- |
| Await first-prompt work | Default prompt hooks already use awaited admission and block before provider delivery | Available candidate boundary; not startup parity |
| Shared startup coordination | Core tests cover preflight, overlap ownership, barriers, cancellation, admission timeout/drain and disposal | Reusable implementation; default host binding absent |
| Startup/resume source and activation identity | The core requires an explicit source and activation ID; the default plugin does not reconstruct startup on reactivation or cold resume | Missing binding and proof; do not infer startup from empty history |
| Native session, model and transcript metadata | Existing prompt/tool projections own their dialect-specific identities and artifact timing | Startup projection must share those identities and preserve native pre-user transcript state; not wired |
| Startup context and artifacts | Native Claude reference observes startup/resume records before the first user, completion-order context and selected nonexecuting-handler failures | Default admission and retained model placement absent; ordinary prompt context is not interchangeable |
| Claude environment files | Core reserves per-command files and preserves their opaque shell contents | File ownership is implemented; executable replay and capture timing are not default-bound |
| Environment functions and configuration order | Native reference exercises shell functions, registration-order replay and the snapshot capture point around first tool execution | Missing replay integration and installed-host proof; parsing exports alone would lose behavior |
| Cancellation and retained startup effects | Core separates session lifetime from turn replacement and rejects late/undrained admission | Host session closure, persisted reconstruction and retained artifact ownership need integration |
| Codex startup and mixed dialects | Loader, dispatcher and explicit core startup service exist | Native startup effects, owned metadata and mixed startup ordering lack complete default-host evidence |

No coherent default startup subset is promoted by this assessment. A context-only first-prompt shortcut would leave source classification, pre-user artifact placement and retention unimplemented, and could discard executable environment effects from otherwise valid command hooks. Selected startup remains incompatible with the bounded V1 profile and fails with `HOST_EVENT_UNAVAILABLE`; supplying a core startup service to the default factory fails with `HOST_SESSION_START_HOST_UNAVAILABLE`. Explicit source selection can exclude startup while preserving supported prompt/tool registrations. Those exclusions must remain visible during inspection.

This gap does not block the documented V1 profile or require an upstream change. A future startup task should first define a restricted source/handler contract, implement shared native identity and transcript admission, preserve or explicitly reject environment effects, and verify fresh, replaced-turn, resumed and disposed sessions through the installed host. The independent native fixture and reusable core tests remain reference evidence, not a declaration of bridge equivalence.
