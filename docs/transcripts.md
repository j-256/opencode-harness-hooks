# Claude transcript projection

The default V1 and V2 entrypoints can supply a Claude-format JSONL transcript for the supported text and tool history subset. V1 reads session metadata and the complete unpaginated message response through its native SDK. V2 reads session metadata and the active context through its plugin session API. The service checks session identity and content before publishing a file. It does not label an arbitrary host history dump as a Claude transcript.

## Representation and timing

Projected records use Claude's `user` and `assistant` message envelopes, a linked `parentUuid` chain, stable derived UUIDs, host timestamps, host session identity, project directory and the pinned Claude format version. User text remains user content. Assistant text and tool-use blocks preserve order, model identity and correlated tool IDs. Known host tool names and inputs use the shared native tool schema translation. Completed tool results become correlated user `tool_result` blocks, including the error flag for host failures. Usage and native request telemetry are omitted when a compatible source value has not been established.

The service observes original arguments before input rewriting, including calls that do not match a Claude registration. Later projections retain those original arguments when the host has stored the effective arguments instead. An unobserved historical tool call fails with `TRANSCRIPT_ORIGINAL_INPUT_UNAVAILABLE`; a cold resume cannot silently replace missing original arguments with an assumption.

Pinned native command-hook captures establish that a transcript can be absent at `SessionStart` and `UserPromptSubmit`, exists before `PreToolUse`, and does not yet contain the current result during `PostToolUse`. The projection therefore includes the current assistant tool-use block and omits that call's result during the tool hooks. Earlier completed results remain visible. This timing observation covers the exercised native command/MCP flow; it is not a complete lifecycle timing contract.

An independent native Claude resume experiment reads projected text/tool histories from both pinned OpenCode hosts and includes their prompt, tool-call and earlier failure content in the resumed model request. This establishes acceptance by the exercised native reader. It does not prove byte identity, all transcript consumers, or unsupported content. The default-package probe separately proves that an actual native-contract hook can read the generated file before deciding whether to deny or rewrite a tool call. Portable regeneration of the independent native reader capture remains a conformance gate.

## Limits and ownership

The supported projection deliberately rejects content that lacks a verified mapping. Attachments, reasoning, synthetic messages, skills, shell-message records, compaction, location changes, unknown tool states and unknown finish reasons are unsupported. V2's active context is not assumed to contain the full pre-compaction history. Unsupported history prevents execution of the matching Claude hook; an older artifact is not substituted. Full native transcript equivalence, cold resume, subagent semantics, context persistence, native auxiliary records and Codex rollout artifacts remain acceptance gates.

Named limits in [the implementation](../src/transcript.ts) bound history-read time, messages, serialized bytes, observed-call memory and pending snapshots. Exceeding a limit produces a specific diagnostic; history is not truncated to make a projection succeed. Snapshots for one session serialize their reads and atomic file replacement. Each request still runs, and this serialization does not deduplicate source registrations or hook executions.

The service creates its own temporary directory with mode `0700` and files with mode `0600`. Session IDs are hashed for filenames. A hook sees a stable path during that plugin activation. Atomic replacement gives newly opened readers a complete snapshot, but append-only tailing and inode continuity are not established native-equivalent behaviors. Disposal cancels pending work, drains the projection queue and removes the owned directory. A process crash can leave a private temporary directory for normal operating-system or user cleanup. These derived files do not replace the host's durable conversation store.

`RuntimeServices.transcripts` permits an explicit implementation with the same observation, preparation and disposal contract. The runtime owns that service's lifetime. A supplied native metadata callback can provide its own verified transcript path instead of requesting the default projection. The payload builder does not validate an externally supplied artifact's contents. Default-package reports retain `equivalent: false` while the complete native artifact and migration requirements remain unresolved. Native environment-file persistence is a separate, unfinished service.

## Reproduction

The package probe can exercise either native dialect on either host:

```sh
npm run build
npm run test:host:plugin -- --host v1 --dialect claude-code --binary /path/to/v1/opencode
npm run test:host:plugin -- --host v2 --dialect claude-code --binary /path/to/v2/opencode
```

The fixture hook reads its transcript, checks the current original command and user prompt, denies one file write and replaces a subsequent command. Fixture temporary files include the projected transcript and are removed with the isolated project. The default dialect remains `codex`; its nullable transcript behavior is unchanged.

`--dialect mixed` loads the same synthetic file and command as independent Claude and Codex sources. Each controlled call must produce one native-format invocation per source, including the Claude transcript check. Both hosts retain the denied side effect's absence and execute the agreed rewrite. This proves the exercised source mixing and lack of command deduplication; it does not assert that duplicate private policies have composable side effects.
