# Stop reference and integration gates

OpenCode V1 rejects configurations containing enabled Stop registrations under the accepted [V1 compatibility exception](compatibility.md#v1-stop-exception). V2 provides an awaited idle mechanism, but the default package's Stop translation remains gated with `HOST_EVENT_UNAVAILABLE` until native effects, artifacts and lifecycle integration pass. A mechanism probe alone does not establish V2 Stop parity.

## Independent native reference

`scripts/verify-native-stop.mjs` exercises Claude Code 2.1.318 and Codex 0.167.0 through their actual command-line runtimes. Each generated source config contains one command Stop registration and remains unchanged during that case. The fixture covers JSON `decision: "block"`, blocking stderr with exit code two, a failing command configured with `onFailure: "block"`, and `continue: false` with a stop reason.

JSON block and exit-code-two feedback cause another model response in the same turn. The first Stop payload has `stop_hook_active: false`; the continued pass has `true`, preserves session and turn/prompt identity, and supplies the updated last assistant message. The fixture checks the hook payload's working directory and transcript availability, that the next model waits for the command, and that CLI completion waits for the final Stop command. A nonblocking command failure does not become a continuation even when its configuration requests failure blocking at this event.

Claude's JSON block produces a `hook_blocking_error` attachment and a meta user feedback record. The feedback record precedes that attachment in the transcript, while the next model receives the rendered blocking-error reminder before the feedback text. Blocking stderr instead prefixes feedback with the command and creates no equivalent blocking-error attachment. Nonblocking failures retain their native error attachment. `continue: false` produces a stopped-continuation attachment followed by the command success attachment and a summary with the prevention flag. The fixture checks native Stop summaries, exact owned error content, field presence, record order and batch identity.

Codex delivers both blocking paths as a user message wrapped in `hook_prompt`, with a run identity containing the native Stop prefix and source config path. Its rollout retains a corresponding `HookPrompt` item, message identity, turn identity and harness provenance. The fixture compares the rollout and provider request, including their order after the prior assistant response. Claude feedback and Codex hook prompts require separate translation; passing the unrendered reason to a host synthetic-message API is insufficient.

The fixture isolates HOME, configuration and project state, uses synthetic credentials and a loopback provider, bounds subprocesses and artifacts, and removes temporary state. Isolation does not remove machine-managed native settings. Claude Stop summaries report additional native handlers separately from the exact generated command. Unexpected aggregate effects still fail the controlled assertions. Codex's controlled fixture explicitly bypasses hook trust and can emit startup diagnostics for that bypass and the synthetic model; their item count is reported. These observations do not establish native trust, managed-policy or complete artifact parity.

## Reproduction

From a repository checkout with Node.js 22+, POSIX process groups and the selected pinned executable:

```sh
npm run test:native:stop -- --dialect claude-code --binary /path/to/claude
npm run test:native:stop -- --dialect codex --binary /path/to/codex
```

The command supports `-h`/`--help`, `-d`/`--dialect`, `-b`/`--binary`, `CLAUDE_BINARY` and `CODEX_BINARY`. The dialect defaults to `claude-code`. It requires no package build, model account, installation or live configuration change. Metadata-only JSON goes to stdout; diagnostics go to stderr without commands, outputs, native payloads or local paths. Exit statuses are zero for passing native checks, one for runtime/check failures, two for usage/version/platform preconditions and three for a missing executable.

The result retains `bridgeStopComparison: "not-implemented"` and `equivalent: false`. V2 default-root control, exact synthetic input and artifact projection, cancellation, repeated decisions, background work, subagent completion, remaining handler families and the private migration comparison remain required gates. The V1 exception does not waive these V2 requirements.
