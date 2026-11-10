# Codex rollout persistence

The core export `CodexRollout` persists explicit native history and the payloads produced by `compileCodexStopPrompt`. It provides native-readable files for an embedding service. Default OpenCode integration, native identity allocation, source trust and complete history translation remain required. The default plugin still rejects Codex Stop registrations.

The caller supplies canonical native root-thread UUIDs, creation metadata and a proven history projection. The store does not infer those values from an OpenCode session ID, import native configuration or grant trust. Its history subset is legacy root sessions with text user/assistant messages and their turn/message events. Images, tools, subagents, compaction, other native history modes and unrecognized fields reject explicitly. This subset does not establish general transcript compatibility.

An embedding service can supply `NativeEvent.nativeSessionIDs.codex` when its journal identity differs from the host session ID. That explicit projection controls the Codex hook payload's `session_id` and its `CODEX_THREAD_ID` environment variable. Host correlation, session lifetime, cancellation, diagnostics and Stop receipts retain `NativeEvent.sessionID`. Each dialect has its own optional projection; arbitrary `data` or `dialectData` fields cannot override reserved identity. Supplied identities must be nonempty strings without NUL and fit the bounded identity budget; the embedding producer still owns identity format, allocation, root association and artifact agreement. An absent or undefined optional entry retains the existing host identity, consistently before and after JSON event snapshots. Null, empty and other invalid values reject. The default plugin does not allocate native identities through this API.

```ts
const store = new CodexRollout()
const path = await store.create({
  metadata: nativeProjection.metadata,
  history: nativeProjection.history,
}, signal)

await store.appendStop(nativeThreadID, compiledStopArtifacts, signal)
await store.appendHistory(nativeThreadID, laterNativeRecords, signal)
await store.dispose()
```

`create` publishes a private, date/thread-named JSONL file containing a `session_meta` record followed by the supplied history. Records have native timestamp/type/payload envelopes and sequential ordinals. File permissions are `0600` inside a private temporary directory. `temporaryParent` can select an existing absolute parent; the store removes only its own generated state during disposal.

`appendStop` checks thread, active-turn and message ownership, response/event agreement, rendered HookPrompt text, harness provenance and timing metadata before writing. The response record precedes its completion event. Repeating the same admission preserves the file bytes; changing a previously admitted Stop identity fails. Separate selected registrations retain their fragments and run IDs.

Operations for one thread serialize. Appends preserve the file inode and sync before resolving. Written bytes receive bounded digest verification before and after the writer handle closes. Cancellation or an I/O failure before admission rolls back only when the original inode and appended bytes can still be verified. A changed path or unverifiable rollback requires recovery and prevents further admission. The store records file and directory identities, rejects replaced directory chains, and checks ownership before cleanup. Disposal unlinks verified journal files and removes only recorded empty directories; replacements and unexpected entries remain for recovery. It does not promise atomic visibility to another reader during an append, a transaction spanning filesystem and model delivery, or recovery across plugin reloads.

Input snapshots, pending work, sessions, records and encoded bytes have bounded budgets. Defaults allow up to 32 MiB per session and 64 MiB across persisted sessions, with smaller `maxSessionBytes`, `maxTotalBytes` and `maxSessions` options. Uncertain failed writes retain their budget charge until cleanup; `inspect().uncertainBytes` identifies that reservation. These are encoded-data limits rather than a measurement of JavaScript heap usage. Unsupported values, cycles, accessors and excessive nesting reject before full serialization. Failures use stable codes without source commands, raw records or filesystem error details.

Run the native reference from a built checkout:

```sh
npm ci
npm run build
node scripts/verify-codex-rollout.mjs --binary /path/to/codex
```

The reference requires Node.js 22+, POSIX and pinned Codex CLI 0.167.0. It executes a generated hook through the actual core Stop coordinator, lets that hook read the persisted history through `transcript_path`, binds real read-only `hooks/list` metadata, compiles the feedback and writes it through `CodexRollout`. The hook checks that its projected session ID, `CODEX_THREAD_ID` and journal metadata agree while the Stop receipt keeps a distinct host session ID. The native reader accesses that file through an alias in separate isolated Codex state, keeping native auxiliary files outside the store's owned directory. Native `thread/read` must recover the expected user, assistant and HookPrompt items with the exact feedback identity and fragments. A separate malformed-record copy must omit the HookPrompt. Source and journal bytes remain unchanged by native reads.

The fixture isolates its files and native state, starts no model or OpenCode host, and changes no live configuration. Its native APIs are read-only; its generated hook runs through the adapter core under an explicit fixture review. This does not prove native trust enforcement, default plugin activation or model continuation. The report retains `defaultPluginIntegration: false`, `nativeTrustEnforced: false` and `equivalent: false`.
