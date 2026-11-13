# Prompt hook model services

The engine accepts an explicit `HostServices.evaluatePrompt` callback. It receives the substituted hook prompt, source-native event data within that prompt, the requested native model when present, and a cancellation signal bounded by the handler deadline. The callback returns a decision with `ok`, a string `reason` when denying, and an optional Boolean `impossible`. Native per-event control remains in the engine; callback presence alone does not establish model, context, authentication or lifecycle equivalence. The default V1 binding supplies an owned evaluator-session service when the caller has not supplied this callback. Agent/MCP services retain separate requirements.

`captureModelArtifacts` opts into private prompt-model execution evidence. It does not classify a model call as a command invocation. The default runtime requests this evidence when a transcript service admits prompt submissions. Successful `UserPromptSubmit` evaluation adds no attachment, and a prompt-model timeout remains nonblocking without a timeout attachment. A malformed verdict produces the measured Claude Code 2.1.318 `hook_non_blocking_error`: raw model text in `stdout`, `JSON validation failed` in `stderr`, exit status 1, the literal unexpanded handler prompt in `command`, and execution timing. A valid denial prevents prompt admission instead.

Adapters with malformed raw model text can throw `ModelOutputError` from the engine entrypoint. Its raw text is retained only in opted-in private evidence and native artifacts, never dispatch diagnostics. Output budgets apply to this error path as well as returned decisions. Cancellation cannot admit a late result. Unsupported or unclassified failure evidence is rejected rather than converted into a command receipt or an empty history. A classified provider JSON API error can use `ModelApiError`; its private native error summary is retained without entering diagnostic messages. Provider retry policies and unclassified errors retain separate proof requirements.

The [model artifact checks](../test/prompt-model-artifacts.test.ts) exercise admission, exact malformed-verdict fields, empty success/timeout attachments, snapshot restoration, privacy, output limits and cancellation. These core checks do not establish every handler/event/host combination.

## Default V1 evaluator

Selected Claude prompt handlers use an owned child session through the public V1 SDK. The service registers an unpredictable creation receipt before the request, validates the returned session, parent, user-message, provider and model identities, and isolates the evaluator from project instructions through the system transform. Its hidden agent permits only the host schema collector. Evaluator lifecycle, chat, system and tool callbacks are checked before native runtime callbacks, so they cannot recursively run hooks or enter parent native state. Ordinary sessions do not acquire this exemption by choosing the agent name.

The evaluator uses the existing provider transport and authentication. Custom authentication loaders require [explicit provider composition](v1-provider-composition.md), including tool-only selections that contain prompt-model handlers. Successful evaluation, denial, malformed text and timeout controls are compared against actual Claude Code and stock V1 with the same hook source bytes. The [executable comparison](../conformance/README.md#prompt-model-hooks) checks parent model calls, an owned shell effect, private submission artifacts and removal of the evaluator session.

An explicit native handler `model` takes priority. `modelAliases` maps native model names to host `provider/model` references. Exact host references are accepted directly; an unmapped bare name stays under the observed parent provider without guessing a model family. Without an explicit handler model, selection uses `promptModel`, then configured `small_model`, then the observed parent model or configured primary model. These options select a host model; an alias is an explicit mapping rather than proof that different real models behave identically.

```json
{
  "promptModel": "gateway/cheap-evaluator",
  "modelAliases": {
    "haiku": "gateway/native-haiku",
    "claude-sonnet-4-6": "anthropic/claude-sonnet-4-6"
  }
}
```

These fields accompany the ordinary `sources`, `reviewedDigests` and optional `permissionMode` options. They are copied at activation. The service reserves the agent name `opencode-harness-hooks-prompt`; a conflicting configuration fails rather than replacing another agent.

A private request ticket associates captured provider responses with the owned evaluator and is removed before the authenticated delegate runs. Streaming OpenAI chat, Responses and Anthropic formats preserve the original collector argument fragments or text, rather than serializing cooked tool input as if it were original output. The capture has byte limits, rejects foreign or competing collectors, and cancels its reader when the evaluation is cancelled. A provider JSON API error with a string `error.message` retains the measured native API-error attachment. Other provider formats, retry policies and full API-error equivalence remain pending validation; a missing evidence contract is diagnosed explicitly.

Timeout, turn cancellation, session removal and disposal cancel actual child processing through the SDK and delete the child using a fresh bounded cleanup scope. Late verdicts cannot be admitted. Failed abort/delete receipts retain a bounded ownership receipt for cleanup retry and emit correlated metadata with operation/session IDs, phase, outcome and duration; prompts, provider bodies and error text stay private. `inspect().models` exposes active work, ownership retention and cleanup failures. Explicit disposal drains accepted evaluation work and retries retained cleanup failures. Crash orphan recovery and automatic awaited V1 teardown remain separate lifecycle work.

A supplied `RuntimeServices.host.evaluatePrompt` callback retains its own ownership and lifetime. The default service is not created, no evaluator agent is installed, and this adapter does not dispose the caller's service. V2 retains the shared engine interface but does not gain this V1 session binding automatically.

## Agent execution evidence

The engine supplies `runAgent` with an optional typed `AgentHookContext` alongside the existing prompt, model, host session ID, signal and turn limit. Native engine calls populate a deeply frozen copy of the source dialect, event, source/registration identity, optional host version and source-native input. A native `session_id` in that input may differ from the host `sessionID` used for cancellation and permissions. The context supports nested hook projection; its IDs do not grant host permission, and adapters must not recover ownership by parsing arbitrary substituted prompt text.

Opted-in agent execution uses the distinct `agent-model` evidence kind. The measured Claude `UserPromptSubmit` success, timeout, exhausted turn-limit and classified API-error branches emit no submission attachment; a valid denial prevents admission. These receipts contain timing/status metadata without the raw prompt, model output or provider error body. Prompt-model error attachments retain their separate semantics. Unclassified outcomes remain explicit missing evidence, and cancellation cannot retain a success receipt. The [agent receipt tests](../test/agent-model-artifacts.test.ts) cover this core contract, immutable provenance, identity separation, opt-in capture, budgets and snapshot restoration.

This engine evidence does not enable a default agent backend. Stock-host agent tool execution, native nested hooks, permission-mode projection, transcript timing, recursion and provider policies retain their own implementation and conformance requirements.

The internal V1 agent-session backend shares prompt-session ownership, model selection, authenticated provider delegation, cancellation and cleanup. It accepts structured agent provenance, permits multi-turn tools through a required nested-tool binding, and validates its private verdict callback against the child session, tool call and observed assistant message. Its explicit validation applies even when the host passes arguments that violate the declared tool schema. Inference and response-byte limits fence delegated work. Host completion after a captured verdict must match the deliberate owned completion signal; unrelated SDK errors cannot publish the verdict.

This backend is not registered by the default plugin. The default nested-policy binding and its independent native comparison remain pending; internal service coverage does not establish permission, recursion or transcript parity.
