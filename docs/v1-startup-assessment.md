# V1 startup delivery

The default V1 plugin delivers selected `SessionStart` hooks through public host APIs. Observed session creation starts the activation when a configured default model is available. The awaited first-prompt callback joins that activation, or starts it when model metadata first becomes available. Prompt, tool and primary model paths share the startup barrier. The host does not await the session-created observer, so returning from the create-session API alone is not a startup-completion receipt.

An observed new session uses native source `startup`. Activating an existing session uses `resume`, even when its history is empty. Each activation has an owned identity; concurrent callers join its work and failed admission cannot silently rerun command side effects. Replacing a user turn cancels its waiter while startup continues under session ownership. Session deletion closes the session and cancels pending work. Core integrations can still supply their own startup service; they own its admission effects.

## Native artifacts and context

Claude startup reserves its native transcript path before a user record exists. Command receipts retain native success, nonblocking-error and timeout fields. Plain stdout produces the native success reminder. JSON `additionalContext` produces an empty success receipt followed by a separate additional-context attachment. Command completion order determines main receipts; deferred additional context follows those receipts. Selected native nonexecuting-handler failures remain private attachments and repeated resume failures are suppressed by owned evidence. The default coordinator rolls back earlier consumers if later artifact/environment admission fails. Failed first-prompt binding reverses native bindings and withdraws the unsaved model prompt. External transcript consumers used with this coordinator must supply the paired revoke/unbind operations. Records are bound before the first accepted user, so a rejected first prompt does not consume startup context.

Codex startup receives its native session UUID and an existing metadata-only journal without a fabricated turn. Its later prompt/tool paths share that session identity and artifact. Startup context enters an owned developer message before the original user; journal records retain native hook provenance and turn attribution. Ordinary prompt-submission context keeps its separate placement after the user. Verified Chat and Responses transports preserve these roles; a transport without a developer role fails explicitly.

The [registered native comparisons](../conformance/README.md#startup-context-and-environment) independently check startup invocation, metadata, exact model text/role/order, retention after a tool request, unchanged source bytes and allowed/denied tool side effects. Unit checks cover owned transcript insertion, immutable batches, rejected first prompts, repeated configuration, cancellation and deletion. These checks establish a fresh-session subset rather than every native lifecycle branch.

## Opaque Claude environment replay

Claude command hooks receive configuration-ordered environment file paths. The default V1 binding selects a plugin-owned shell launcher through the in-memory `config.shell` hook. Public `shell.env` supplies an owned snapshot path for the executing session. Original model/tool arguments and the host's permission parser remain intact.

The first actual shell boundary captures opaque file contents after pre-tool hooks. Each tool shell sources the snapshot before its original command, preserving functions, append side effects, source order, shell flags and positional arguments. Later source-file changes do not alter that activation's captured snapshot. Retained native ordinal files remain eligible when a resumed selection is shorter or empty. Files and snapshots have ownership, symlink, type, byte, concurrency and cancellation checks. Session closure drops memory state; explicit plugin disposal drains captures, removes temporary launchers/snapshots and restores only in-memory shell configuration it still owns. Durable environment files remain under the process's HOME/XDG state directory, partitioned by project and session.

Actual Bash, Zsh and sh subprocess checks cover replay and passthrough. The installed Claude comparison requires both an exported value and an opaque function before the allowed filesystem effect can occur. Windows launcher support remains pending implementation and proof.

## Remaining implementation

Cold resume of native context and original tool inputs requires durable plugin-owned state. OpenCode's stored tool input contains the effective rewritten arguments; it cannot reconstruct a discarded original model input. The adapter preserves that distinction and fails explicitly rather than substituting effective arguments. Persistence for plugin-owned sessions, historical attachment/model reconstruction, source reload, clear/compact sources, child-session semantics, remaining handler effects and platform/provider coverage remain implementation work. Their absence is not evidence that a host change is required.

Enabled selected `Stop` remains incompatible with V1 and fails prominently at load time. It is the separately accepted host limitation described in [compatibility](compatibility.md).
