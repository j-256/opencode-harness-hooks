# Stop reference and integration gates

OpenCode V1 rejects configurations containing enabled Stop registrations under the accepted [V1 compatibility exception](compatibility.md#v1-stop-exception). V2 provides an awaited idle mechanism, but the default package's Stop translation remains gated with `HOST_EVENT_UNAVAILABLE` until native effects, artifacts and lifecycle integration pass. A mechanism probe alone does not establish V2 Stop parity.

## Explicit core coordination

The V2 core API accepts `RuntimeServices.stop` with a required `admit` service. Call `runtime.stop(event)` with the host, `event: "Stop"`, session ID, original user `messageID`, unique assistant `completionID`, working directory and native metadata in `data` or `dialectData`. The coordinator supplies the active turn identity and its own `stop_hook_active` flag. Conflicting supplied identities or active flags fail. Matching executable handlers have required metadata preflighted before dispatch, including the last assistant text and Claude's transcript, background-task and session-cron fields. Supplied artifacts and metadata remain the caller's responsibility and must be compatible with the native consumers.

The service receives the immutable event, originating session snapshot, attributed dispatch, resolved effects and cancellation signal. It must admit native artifacts and deliver every effect, or reject. Command execution artifacts remain private inputs to that service. A callback which discards them does not establish parity. Successful admission returns a metadata-only receipt with `continue`, `complete` or `stop` control; a successful feedback admission makes the next Stop in that logical turn active. A new real prompt resets that state. `continue: false` prevents continuation without permanently closing the session to later prompts. If explicit startup coordination is configured, Stop waits for its admission before running commands.

`ClaudeTranscript.prepare()` can supply the initial V2 [completion snapshot](transcripts.md#v2-completion-snapshots) before dispatch when called with the Stop event and its originating session. The caller still supplies the remaining native metadata and the admission service. Preparation alone does not create Stop summaries, feedback records or subsequent synthetic-history projection.

Repeated delivery of the same completion identity joins its existing work or receipt. Different content under that identity, stale turns and overlapping different completions fail. This delivery guard does not deduplicate registrations. Native nonblocking failures and native skipped handlers retain their outcome; unsupported handlers prevent admission. Named limits in [the coordinator](../src/stop.ts) bound retained completions, metadata and service time. Diagnostics contain correlated IDs, stable codes, phase and duration, excluding payloads, commands and output.

New prompts, session closure and disposal cancel pending work. Admission services must honor their cancellation signal before committing effects. An admission which remains pending after timeout or cancellation retains the session's completion lock, including across prompt replacement. Disposal tracks those underlying promises, reports `HOST_STOP_ADMISSION_DRAIN_FAILED` if they remain pending beyond the service timeout, and permits a cleanup retry. Cancellation alone does not establish successful drain.

The default V2 factory rejects an injected core Stop service with `HOST_STOP_HOST_UNAVAILABLE`; its actual idle, synthetic input and native artifact adapters remain unconnected. V1 retains its configuration-specific `HOST_STOP_UNSUPPORTED` rejection, including when a core Stop service is supplied. The core coordinator's tests establish its dispatch/admission contract, while default-root and native artifact parity remain separate required gates.

## Independent native reference

`scripts/verify-native-stop.mjs` exercises Claude Code 2.1.318 and Codex 0.167.0 through their actual command-line runtimes. Each generated source config contains one command Stop registration and remains unchanged during that case. The fixture covers JSON `decision: "block"`, blocking stderr with exit code two, a failing command configured with `onFailure: "block"`, and `continue: false` with a stop reason.

JSON block and exit-code-two feedback cause another model response in the same turn. The first Stop payload has `stop_hook_active: false`; the continued pass has `true`, preserves session and turn/prompt identity, and supplies the updated last assistant message. The fixture checks the hook payload's working directory and transcript availability, that the next model waits for the command, and that CLI completion waits for the final Stop command. A nonblocking command failure does not become a continuation even when its configuration requests failure blocking at this event.

Claude's JSON block produces a `hook_blocking_error` attachment and a meta user feedback record. The feedback record precedes that attachment in the transcript, while the next model receives the rendered blocking-error reminder before the feedback text. Blocking stderr instead prefixes feedback with the command and creates no equivalent blocking-error attachment. Nonblocking failures retain their native error attachment. `continue: false` produces a stopped-continuation attachment followed by the command success attachment and a summary with the prevention flag. The fixture checks native Stop summaries, exact owned error content, field presence, record order and batch identity.

Codex delivers both blocking paths as a user message wrapped in `hook_prompt`, with a run identity containing the native Stop prefix and source config path. Its rollout retains a corresponding `HookPrompt` item, message identity, turn identity and harness provenance. The fixture compares the rollout and provider request, including their order after the prior assistant response. Claude feedback and Codex hook prompts require separate translation; passing the unrendered reason to a host synthetic-message API is insufficient.

The fixture isolates HOME, configuration and project state, uses synthetic credentials and a loopback provider, bounds subprocesses and artifacts, and removes temporary state. Isolation does not remove machine-managed native settings. Claude Stop summaries report additional native handlers separately from the exact generated command. Unexpected aggregate effects still fail the controlled assertions. Codex's controlled fixture explicitly bypasses hook trust and can emit startup diagnostics for that bypass and the synthetic model; their item count is reported. These observations do not establish native trust, managed-policy or complete artifact parity.

## Additional Claude output cases

Claude Code 2.1.318 accepts a parsed `decision: "approve"` at Stop without turning it into an approval or continuation. Empty `additionalContext` does not continue the turn, while whitespace context remains significant. An empty or missing block reason continues with the native fallback `Blocked by hook`; a whitespace reason is preserved. Blocking stderr is preserved without trimming and uses `No stderr output` only when empty. The [focused interpreter cases](../test/protocol.test.ts) retain these observed Stop distinctions. Portable regeneration of these additional native cases and their complete artifact projection remain conformance work.

## Reproduction

From a repository checkout with Node.js 22+, POSIX process groups and the selected pinned executable:

```sh
npm run test:native:stop -- --dialect claude-code --binary /path/to/claude
npm run test:native:stop -- --dialect codex --binary /path/to/codex
```

The command supports `-h`/`--help`, `-d`/`--dialect`, `-b`/`--binary`, `CLAUDE_BINARY` and `CODEX_BINARY`. The dialect defaults to `claude-code`. It requires no package build, model account, installation or live configuration change. Metadata-only JSON goes to stdout; diagnostics go to stderr without commands, outputs, native payloads or local paths. Exit statuses are zero for passing native checks, one for runtime/check failures, two for usage/version/platform preconditions and three for a missing executable.

The result retains `bridgeStopComparison: "not-implemented"` and `equivalent: false`. V2 default-root control, exact synthetic input and artifact projection, cancellation, repeated decisions, background work, subagent completion, remaining handler families and the private migration comparison remain required gates. The V1 exception does not waive these V2 requirements.
