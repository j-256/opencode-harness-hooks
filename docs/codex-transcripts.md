# Codex tool-hook transcripts

The default V1 adapter supplies a Codex-compatible journal before matching `PreToolUse` and `PostToolUse` hooks execute. The journal contains the user prompt, assistant text, original function calls, and available earlier tool results. Hooks receive its absolute path through `transcript_path`. Session and turn UUIDs are stable projections of the host identities; the journal metadata, hook payload, and `CODEX_THREAD_ID` agree. Internal session ownership and cancellation continue to use the OpenCode identities.

The V1 binding reads session history through the host client and normalizes it for the host-neutral `CodexTranscript` service. The core exports that service and its history/view types for other integrations. `RuntimeServices.codexTranscripts` supplies an explicit override. An explicitly supplied Codex `nativeData.transcript_path` retains ownership instead of triggering the default projection. V2 default integration and prompt/lifecycle transcript delivery remain separate gates.

## Records and timing

The writer uses Codex's reader-compatible legacy journal format with `session_meta`, turn boundaries, message response items and user/assistant events. Metadata identifies the bridge as the originator and the OpenCode version as the CLI version. This is a projected host history, with no fabricated Codex system instructions, world state, usage records, or paginated storage metadata.

Shell calls use `function_call` records named `exec_command`, with the original command in `arguments.cmd` and the owned call ID in `call_id`. The pre-tool observation snapshots input before any replacement; later snapshots retain that original input. Other host tools use generic function-call records with their original host names and arguments. Native Codex tool-specific views for those functions remain unverified.

The current call is present before its hook executes. Its `function_call_output` is excluded at both tool hooks, matching the observed native response-item timing. Completed earlier results become visible when a later call is prepared. Native command-completion events, their output wrapping and UI views remain unverified; the absence of a response-item result does not describe every native event record. Assistant text retains its host part order. Calls and results append as they become eligible, so parallel siblings can appear in observation order rather than host storage order. Function-call timestamps use the owning assistant message's creation time, keeping published records stable across host tool-state updates; exact native timestamps and parallel ordering are not claimed.

Preparations serialize by host session and append new records without rewriting the published journal. Previously published records and the host message/part layout are checked for changes independently from mutable tool completion state. A pending or running sibling in the active turn enters the journal after its own pre-tool observation captures the original input. This boundary permits parallel scheduling without inferring originals from effective host state. Reused call IDs, foreign ownership, contradictory turns, changed history, and other missing original inputs fail explicitly before hook execution. History predating the bridge's observations, compaction, attachments, synthetic content and resumed-session reconstruction are outside the supported history subset. These failures are not converted to an empty transcript.

## Storage and lifecycle

`CodexRollout` owns journal files and verifies their identity before writes. Directories use mode `0700`, and files use `0600`. Journal size, record/session counts, retained original inputs and pending work have explicit limits. Cancellation drains preparation, and runtime disposal removes owned journal state while preserving replacements or unowned files for recovery. Metadata-only inspection and error codes exclude commands, transcript contents and source paths. The temporary journals are an adapter artifact, not a durable native session store. Automatic awaited V1 teardown remains unverified.

## Verification

Build and run the independent native/V1 comparison:

```sh
npm run build
node scripts/verify-conformance.mjs --case codex.pretooluse.control
```

The same synthetic hook reads each runtime's journal and checks the actual prompt, original current function call, session/turn/call relationships and current-result exclusion. The pinned native Codex reader must recover the prompt under those identities without changing the journal. Denial and allowed-control effects retain their independent checks. Native hook trust is bypassed only in the fixture, and the provider runs locally without a model account.

This evidence covers the selected tool-hook records and effects. It does not establish full native transcript, trust, lifecycle, model-context, output-format, or host parity. The [conformance catalog](../conformance/README.md) retains those obligations separately.
