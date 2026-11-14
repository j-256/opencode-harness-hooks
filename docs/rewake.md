# V1 wake notifications

The default V1 binding supports the bounded Claude `asyncRewake` command path through stock host APIs. A selected command exiting with code 2 requests a notification from stderr, with stdout fallback. The notification is a system event and conveys no human approval. Source callbacks receive its raw native text; model requests receive the guarded native notification form. This feature does not provide V1 Stop veto support.

## Active and idle delivery

At a verified completed-tool boundary, the binding runs `UserPromptSubmit` callbacks under the existing logical prompt identity. Accepted notification text and callback context follow the owned original result, and the Claude transcript receives its native queued-command attachment. It preserves the original raw host result. Multiple retained jobs keep independent identities, source callbacks and ordered bindings.

From idle, the binding saves an owned synthetic user input through the public SDK before resuming it. The saved input carries the raw notification; provider projection supplies the guarded model text and callback context. Native history retains the system origin and genuine-prompt index. SDK save and resume identities are correlated through bounded one-use metadata; an arbitrary synthetic flag or matching text grants no ownership.

An active callback block consumes the notification without cancelling the genuine turn. An active `continue: false` outcome can be reevaluated once from idle. An idle block rejects that notification; an idle `continue: false` saves native terminal feedback without starting inference. Selected Claude and Codex callbacks remain independent, and supplied background or notification services retain their own ownership.

## Persistence and failure behavior

Source attempts are checkpointed before execution. An unresolved attempt cannot execute again after restart. Saved notification history survives source deselection without authorizing new commands. Binding writes drain before cancellation rollback, and session deletion cancels owned work. A known-unsent SDK claim can be released; a submitted request without a conclusive acknowledgement remains explicitly unresolved and is never blindly retried. Diagnostics identify the session, operation, phase, outcome and timing without printing notification text.

UI messages use a separate bounded worker. A slow or failed UI transport does not block model admission. Retained acknowledgement permits retry; ambiguous delivery can repeat a warning, so exactly-once UI presentation is not claimed. See [durable session storage](session-state.md).

## Verification and remaining work

The registered `claude.rewake.active` and `claude.rewake.idle` [native comparisons](../conformance/README.md#rewake-context-comparison) run unchanged source and helper bytes under pinned native Claude and stock V1 with synthetic loopback providers. They check the selected source callbacks and prompt identities, literal non-human model text and carrier, retained native artifact fields, genuine inputs and original tool effects. Unit and default-factory controls separately exercise mixed callbacks, cold replay, independent queued jobs, failed writes, held transports, genuine-input races and deletion. Passing these cases does not establish all-background or whole-event conformance.

Complete native emulation of a human message queued mid-turn remains pending prompt-event work. The binding safely handles newer genuine input without promising native queued-human timing, logical identity or transcript/model representation. The engine's literal queued-human codec alone does not supply that host binding. Broader batching timing, mixed media carriers, other providers, complete UI presentation, native trust/reload and V2 wake delivery retain separate implementation or proof obligations. Conditions, environment policy, general MCP prompt-failure artifacts and first-prompt Codex journal headers are separate pending capabilities. These are not classified as host limitations merely because unfinished.
