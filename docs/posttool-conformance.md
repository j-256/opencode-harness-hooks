# Post-tool effects conformance

The independent post-tool cases compare unchanged synthetic hooks through the pinned native harness and default OpenCode V1. They measure Claude `additionalContext` and blocking feedback, Codex blocking result replacement, and no-op controls. Each variant issues sequential shell calls in the same session and turn. Only the first call can produce hook output; the next call checks ownership and absence of replayed effects.

## Running the comparison

Build the package, then select both cases:

```sh
npm run build
node scripts/verify-conformance.mjs --case claude.posttooluse.effects --case codex.posttooluse.effects --require-complete
```

The runner requires the [pinned native and host versions](compatibility.md). Use `--claude-binary`, `--codex-binary`, and `--opencode-binary` to select isolated pinned executables when installed defaults differ. A version mismatch is a precondition error; it does not establish a behavior difference. The fixtures use isolated HOME/config/project state and deterministic loopback providers without a model account. Native hook trust and permissions are bypassed only in the fixture.

The source and script bytes remain identical between native and V1 execution within each case. Both shell calls write distinct markers before the post-tool hook. Their stdout tokens are assembled from separate shell arguments, so an echoed command cannot satisfy output validation. The hook records invocation metadata and whether the completed side effect exists. The observer then verifies actual file contents and the next model requests independently from the production payload builder and protocol interpreter.

## Selected observations

Results must belong to the emitted calls, with no foreign or duplicate result candidates. The first model request after execution must preserve the original output for Claude context/feedback and no-op controls, or replace it with feedback for Codex blocking output. The report records original-output and effect-text presence separately from validity. A matching effect in arguments or metadata cannot establish delivery. The later result must contain its own output without the first call's output or effect, and retained historical effects must not be duplicated. The later model request also retains its effect layout for comparison: a retained effect must keep its established role/channel and placement, remain before the next result, and match the native reference's observed layout. Removing an old effect and reinserting it after the next result cannot pass as isolation.

The observer identifies the logical tool-result channel across Anthropic `tool_result`, Responses `function_call_output`, and chat messages with role `tool`. Anthropic results require a user container. Ordinary user, developer, or assistant text remains a separate message segment with its actual role. The comparison retains whether the effect appears inside the owned result or in a separate message before or after it. It does not equate a tool-result insertion with a separate user/developer message, or compare arbitrary serialized provider payloads as if their wire formats were identical.

Reports contain selected booleans, counts, layout metadata, source/build fingerprints, and host diagnostic codes. Raw provider traffic, commands, source paths, and hook payloads stay inside disposable fixtures. Native and host observations must meet literal positive/no-op expectations before a case can pass. Unsupported host effects remain failed comparisons with their diagnostics; they are not successful diagnostic coverage. A failed comparison exits 1, including in a combined report with passing cases. A passing selected case still exits 4 under `--require-complete` when broader requirements are unverified.

## Measured behavior and remaining fix

For the selected successful shell calls, native Claude places both post-tool additional context and blocking feedback inside the tool result, preserves the original output, and does not attach the effect to the next call's result. Default V1 agrees on these observations. The comparison does not establish exact reminder text, wrapping, complete payloads, transcript artifacts, or persistence equivalence.

Native Codex blocking output replaces the first model-visible tool result with the hook's feedback while retaining the completed side effects. Default V1 reports `HOST_EFFECT_UNAVAILABLE` and does not deliver that replacement. The no-op control and the next call's result remain valid. The case therefore retains failed conformance evidence rather than certifying the unsupported behavior.

The next implementation task is default V1 delivery of an owned Codex post-tool result replacement. This comparison provides the acceptance gate for the exercised shell path. Competing replacements, nested tool promises, failed commands, other tool families, full rendering and lifecycle semantics, native trust, and V2 remain separate obligations. The [coverage catalog](../conformance/README.md) keeps these narrow cases separate from broad result and PostToolUse requirements.
