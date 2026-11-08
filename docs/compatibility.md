# Compatibility contract

The initial reference versions are OpenCode 1.19.5, Claude Code 2.1.318, and Codex CLI 0.167.0. The source event catalogs are represented by `HOOK_EVENTS`; recognizing a configuration event does not establish that OpenCode can reproduce it.

## Evidence and completion

Each required capability is classified as verified, unsupported, or unresolved, with supporting evidence. A required unsupported or unresolved capability prevents an equivalence claim. Missing evidence also prevents that claim. Tests proving an unsupported diagnostic are diagnostic coverage, not successful protocol equivalence.

## Source references

- [Claude Code hook reference](https://code.claude.com/docs/en/hooks)
- [Codex hook reference](https://learn.chatgpt.com/docs/hooks)
- [OpenCode plugin API at the pinned release](https://github.com/anomalyco/opencode/blob/v1.19.5/packages/plugin/src/index.ts)
- [OpenCode event dispatch at the pinned release](https://github.com/anomalyco/opencode/blob/v1.19.5/packages/opencode/src/plugin/index.ts)

## Host boundaries under investigation

The pinned host calls plugin event handlers without awaiting their promises. An asynchronous completion observer therefore does not itself provide an awaited final-turn veto. Completion control requires separate execution evidence and must not be inferred from an event name.

Source-native handler families include command, HTTP, MCP tool, prompt, and agent hooks. Their availability and intentional skip behavior differ by dialect and event. Recognition, execution, and equivalent native effects are separate checks.

OpenCode V2 and Windows are not covered by evidence for the initial host and macOS environment.

