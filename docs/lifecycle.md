# Session lifecycle reference

The default package rejects selected `SessionStart` registrations with `HOST_EVENT_UNAVAILABLE`. Lifecycle dispatch, startup context, executable shell replay and resume reconstruction remain required host integration work. A shared file-ownership service is available through the core API. The native fixture below supplies an independent reference for integration; it does not activate those registrations or establish bridge parity.

## Environment-file ownership

`ClaudeEnvironmentFiles` from `opencode-harness-hooks/core` reserves separate file paths for an ordered selection of Claude `SessionStart` command registrations. Its `prepare(sessionID, registrations, signal)` method returns an immutable plan with ordered `files` and a `registrationContext` map for command dispatch. Hook commands receive their own `CLAUDE_ENV_FILE` through that map. Source-level plugin data, options and shell selection remain in `HostServices.sourceContext`.

The caller supplies an absolute, dedicated state directory and preflights native payload metadata before executing hooks. The service creates private directories, hashes the session identity in paths, binds the registration order and source revisions in a bounded manifest, and leaves the hook files absent until commands write them. Concurrent activations can reserve the same layout without overwriting each other's manifest. A fresh process recovers the same paths and preserves appended code for session-ID resume. The service leaves that code opaque; it does not parse exports or execute shell content.

Preparation bounds registration and identity sizes, checks directory ownership and private permissions, and rejects existing hook-file symlinks, hard links and special files. Cancellation does not delete persisted files. The host owns the dedicated directory's retention policy; the service does not impose a disk quota or remove resume state on activation shutdown. These checks support POSIX hosts. Windows integration remains unsupported.

A different ordered selection or source revision for an existing session produces `ENVIRONMENT_LAYOUT_UNSUPPORTED`. Matcher-dependent selection changes, native reload, transcript-path resume namespaces and storage retention require further lifecycle integration and native comparison. Passing a file plan into `dispatchEvent` verifies hook-process ownership only. It does not establish startup barriers, context placement, tool-shell capture timing or replay parity, and it does not remove the default package's lifecycle capability gate.

## Native startup and resume

The pinned Claude Code headless fixture starts concurrent command handlers and gives them different completion delays. Startup context follows completion order, appears in native `SessionStart:startup` attachment records before the first user record, and reaches the model as user-role reminder blocks. The first submitted prompt and model request wait for the startup batch in this exercised headless flow. The fixture repeats the checks with `source: "resume"` and the corresponding native record label.

Each handler receives a distinct `CLAUDE_ENV_FILE` path in configuration order. On startup, the path is reserved before the file exists. Shell commands replay environment code in configuration order, so a later configured handler can override an earlier handler's value even when it completed first. Executable shell code and functions survive; reducing these files to parsed assignments would lose behavior. Repeated shell commands each evaluate the captured code, and their temporary shell state does not accumulate across commands in the fixture.

During startup, the fixture changes a variable in the same environment file from a prompt hook, the provider and the first pre-tool hook. The first shell command observes the pre-tool value. An edit made during that command remains present in the file but is not reflected by the second command. A separate append side effect still runs for each command. This establishes repeated execution of captured contents, rather than rereading a changed file for every command. Other cache invalidation events remain separate conformance cases.

Resuming by session ID reuses the existing environment files, and the resume hooks append another copy of their code. The fixture observes both copies executing for each command and the new generation taking effect. Resuming by transcript path retains the transcript session ID but allocates a new environment-file directory. Shell commands in that pinned capture nevertheless observe the previous activation's generation and its edited variable, even though the resume hooks wrote to the new directory. The fixture checks and reports both behaviors explicitly; a fresh pathname does not establish fresh environment consumption. The underlying cache mechanism and other resume flows require separate evidence. The persisted variables do not enter later hook processes, and events without environment-file support do not receive `CLAUDE_ENV_FILE`.

The native reference is [Claude's SessionStart contract](https://code.claude.com/docs/en/hooks#sessionstart). Its interactive startup behavior, other startup sources, extra native control fields, other environment-file events, Windows and PowerShell remain separate conformance cases. The fixture does not infer those behaviors from its headless startup/resume capture.

## Reproduction

From a repository checkout:

```sh
npm run test:native:claude:lifecycle -- --binary /path/to/claude
npm run test:native:claude:lifecycle -- --binary /path/to/claude --resume-mode path
```

The command requires Node.js, POSIX process groups and Claude Code 2.1.318. It uses isolated HOME/config/project state, unchanged generated synthetic hook configuration and a loopback provider with synthetic credentials. It requires no package build or model account and installs nothing. `-h`/`--help`, `-b`/`--binary`, `-r`/`--resume-mode` and `CLAUDE_BINARY` are supported. Resume mode defaults to `id`; `path` exercises the separate transcript-import behavior. Temporary state is removed on completion or failure.

Metadata-only JSON reports the exercised native properties, `bridgeLifecycleComparison: "not-implemented"` and `equivalent: false`. It excludes source commands, output, environment values, local paths and provider traffic. Exit statuses are `0` for the native fixture checks, `1` for runtime/check failures, `2` for usage/version/platform preconditions and `3` for missing dependencies. A native-only success does not satisfy the required bridge or migration acceptance gates.
