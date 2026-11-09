# Read-only inspection

The CLI reads explicit native sources using the same loader and metadata report as plugin activation. It executes no hooks, changes no configuration and discovers no global sources. Inspection requires Node.js 22+ and the package dependencies; it needs no OpenCode executable or model account.

Build the package, then inspect a plugin-options JSON file:

```sh
npm run build
node dist/cli.js inspect --host v1 --directory /path/to/project options.json
node dist/cli.js inspect --host v2 --directory /path/to/project options.json
```

The installed command is `opencode-harness-hooks`. `-h` and `--help` describe the input schema and all options. `-H` is the short form of `--host`, and `-d` is the short form of `--directory`. Value options support separate values, glued short values and long `--option=value` forms. Options may be interleaved with positional arguments. Use `--` before a positional filename beginning with a dash.

The options file has the [runtime options schema](runtime.md), with `reviewedDigests` optional for inspection. An omitted map is treated as empty, so source digests can be inspected before configuring review pins. The options filename resolves against the CLI's working directory. Relative source paths, `projectRoot` and `pluginRoot` resolve against `--directory`, which defaults to that working directory. Native hook JSON and inline TOML retain their native extraction and selection rules. Inspection does not edit them or grant native trust.

JSON output identifies the host and native contract versions, source digests and review matches, enabled state, independently selected registrations, exclusions with reasons, unwired events and unresolved compatibility gates. Repeated registrations and sources remain separate. Commands, matchers, paths, hook payloads and unrelated settings are omitted. This is configuration metadata: a selected registration may still require an unavailable host service or fail during execution. The report does not certify an installed host, executable contents, native trust, protocol conformance or migration parity.

The options file is limited to 1 MiB. Native files use the source loader's size limits. Both readers require regular files and reject pipes without waiting for a writer. Errors report stable codes and validated source IDs, without parser excerpts, paths or native command text.

Exit statuses are:

- `0`: inspection succeeded, including reports with unresolved behavior
- `1`: a file could not be read or inspection encountered a runtime failure
- `2`: invalid arguments, invalid options or native source schema, or a size limit
- `3`: required package dependencies could not be loaded
- `4`: `--require-equivalent` was requested and required equivalence is unproven

Help and inspection results go to stdout; failures go to stderr. Status `4` preserves the JSON result on stdout. `--require-equivalent` checks the report's equivalence verdict, not only whether the file parsed. Required native conformance and migration gates keep that verdict false even for a source containing only wired events. This mode does not run the independent acceptance fixtures.

The library's `inspectSources()` helper is available from `opencode-harness-hooks/core`. It expects the runtime options schema, including an explicit `reviewedDigests` map, and returns the parsed snapshots alongside their metadata report. Plugin activation applies review and event-availability gates to that same report before allowing execution.

## Verify the npm artifact

After `npm run build`, run `npm run test:package`. This requires npm, tar and access to the public npm registry for the locked runtime dependencies. `-h`/`--help` and `-p`/`--npm PATH` are available through `npm run test:package -- ...`. The probe packs without lifecycle scripts, rejects unexpected package paths and machine-local references, verifies dependency-free help and missing-dependency diagnostics, installs the artifact into an isolated consumer with scripts disabled, imports the default plugin and library, and invokes the installed executable. It also checks that unresolved equivalence produces status `4`.

The probe uses disposable temporary files, isolated HOME/cache and explicit public registry settings without machine credentials. It publishes nothing, changes no live configuration and removes its own temporary state. Its JSON success report covers packaging, not full native compatibility. Probe exit statuses are `0` for success, `1` for a runtime or check failure, `2` for invalid arguments and `3` for missing dependencies or an absent build. Failures identify the stage without subprocess output.
