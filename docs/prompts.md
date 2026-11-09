# Prompt submission

The default package connects native `UserPromptSubmit` registrations through an awaited admission callback on each pinned host. V1 uses `chat.message`; V2 uses `session.prompt`. Both call the same source loader, metadata preflight, dispatcher and effect resolver as tool hooks. Each selected source runs independently, including repeated commands and mixed dialects. Native blocking decisions reject admission before any model request. A hook's request to stop processing that submission also prevents admission; this does not implement the separate native `Stop` lifecycle event.

Prompt input remains the host's submitted text. V1 obtains model identity from its prompt/message metadata; V2 reads the session's selected model before dispatch. Missing required model, permission mode or artifact metadata prevents executable hook side effects. Files, agents, skills, ignored text and synthetic prompt parts lack a verified native input mapping and fail explicitly. These paths do not strip quotes, rewrite the original user text or insert durable host message parts.

## Native context roles

Installed native fixtures distinguish Claude command stdout from JSON `additionalContext`, and distinguish both from Codex context. The request projection preserves those differences:

| Source output | Model content and position |
| --- | --- |
| Claude `additionalContext` | User text before the original prompt, wrapped in a `system-reminder` with the native `UserPromptSubmit hook additional context:` label |
| Claude command stdout | User text before the original prompt, wrapped in a `system-reminder` with the native `UserPromptSubmit hook success:` label |
| Codex context | A separate developer message after the original user prompt |

Claude `systemMessage` remains a warning. Warnings, feedback and extension effects require an explicit `RuntimeServices.promptEffects` service; without one the root reports `HOST_PROMPT_EFFECT_UNAVAILABLE`. Tool input changes, permission decisions, continuation requests and result replacements are not silently applied to prompt admission. Hook handler families still require their documented native services.

Accepted prompt context is retained by session and native user-message ID for the activation's lifetime, with independent source attribution. Every subsequent model request reprojects the context at its original prompt position. Claude context follows hook completion order, as exercised by a native fixture whose handlers finish in a different order from configuration. Repeated identical prompt text does not merge identities or deduplicate sources. The bridge validates the complete retained user layout and each text segment before projection; changed, pruned, compacted, foreign and cold-resumed layouts fail instead of matching context by text alone.

## Host transport

V1 wraps the configured provider's `options.fetch` while preserving the preceding implementation and forwarding unrelated requests unchanged. It verifies the effective fetch identity before model execution. An undeclared provider or a later fetch override fails with `HOST_PROMPT_TRANSPORT_UNAVAILABLE`. The adapter accepts the direct provider metadata shape exercised by the installed pin and the nested shape declared by its published plugin type; conflicting identities fail.

V2 registers `session.model.request` and `session.http.request` for primary requests. It resolves the selected model/provider package through the native APIs and reconstructs the request after the provider driver has serialized it. Both hosts select the body protocol from an explicit supported provider package, not a URL guess. The projection handles the validated text-only OpenAI Chat, OpenAI Responses and Anthropic message shapes. The installed package fixture exercises OpenAI-compatible Chat on each host; the other body shapes have focused projection tests and remain separate native-provider conformance gates. Codex developer context on the Anthropic shape fails with `HOST_PROMPT_ROLE_UNAVAILABLE` because a compatible role representation has not been proved.

A random private header correlates each serialized request with its session, active turn and validated layout. It is removed before provider delivery, including when a runtime retains headers during request reconstruction. Projected-body fingerprints prevent a repeated transport pass from inserting context twice; this delivery guard does not deduplicate hook registrations. Starting a new turn, closing the session or disposing the plugin invalidates request correlation. Disposal cancels body reads and releases retained context. Named limits in [the implementation](../src/prompt-contexts.ts) bound retained user-message entries, bytes, correlation tickets, body variants and read time; excess work fails rather than truncating context.

The internal projector can also retain explicitly owned continuation IDs under the original logical turn and cancellation signal, without adding prompt-hook context to feedback messages. These slots share the prompt retention budget and remain in their historical positions after a later real prompt. Unknown user-message IDs still fail validation. This ownership primitive does not enable the default package's [Stop adapter](stop.md); native continuation rendering, artifact admission and lifecycle coordination remain required.

Prompt failure diagnostics identify host, phase, session/message IDs, stable code, outcome and duration. They exclude prompt text, context, request bodies, correlation tokens and exception text. `RuntimeServices.promptDiagnostic` can observe them, and diagnostic observer failures are counted without changing the original decision. `createRuntime().inspect()` and the V1 helper's `inspect()` expose metadata-only counts.

## Reproduction and remaining gates

Run the actual default package against each installed pin, using independent synthetic native sources and a loopback provider:

```sh
npm run build
npm run test:host:plugin -- --host v1 --dialect mixed --prompts --preapproval --binary /path/to/v1/opencode
npm run test:host:plugin -- --host v2 --dialect mixed --prompts --preapproval --binary /path/to/v2/opencode
```

The prompt profile proves blocked admission without a model request, independent source invocation, native context roles on every provider request, retention across accepted turns, private correlation headers and prompt artifact timing. Claude hooks read stdout, additional-context, nonblocking-error and timed-out command attachments from the generated transcript, including their stable identities across tool calls. Failure and timeout output remain absent from provider requests. It also exercises tool denial, rewritten execution and native preapproval under host `ask` permissions. It isolates its own project, configuration, state, temporary files and server, and leaves live configuration unchanged.

The success report retains `equivalent: false`. Prompt wiring does not complete native lifecycle ordering, native trust, source reload/once behavior, cold resume, compaction, provider/auth transport combinations, complete [Claude artifacts](transcripts.md), Codex rollout artifacts or private migration parity. The approved no-deduplication behavior also has an explicit [native identity difference](compatibility.md#source-loading-and-matching). These remain required acceptance gates.
