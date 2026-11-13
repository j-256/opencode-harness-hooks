# Foreground HTTP hooks

The bounded V1 profile supports selected Claude HTTP hooks without host changes. The pinned native Codex configuration accepts command, MCP, prompt and agent handlers, but rejects `type: "http"` and ignores that invalid hook configuration. The adapter rejects such a Codex source with `SOURCE_HANDLER`; this is a source-format boundary, not an OpenCode host limitation.

## Native tool comparisons

```sh
npm run build
node scripts/verify-conformance.mjs --case claude.pretooluse.http --case claude.posttooluse.http --case claude.pretooluse.http-failures
```

These cases run the same generated Claude source and endpoint program through actual native Claude and stock V1. A bounded loopback HTTP endpoint receives the native POST payload and runs the trusted fixture observer independently of the adapter's payload builder and output interpreter. Source and program hashes, adapter fingerprints, exact request counts and absence of redirect following constrain the comparison. No model account is required.

The pre-tool case checks denied and allowed shell calls, owned reason delivery and filesystem effects. The post-tool case checks selected context/feedback roles and placement, preservation of completed output/effects, sequential-call ownership and a no-op control. The default-failure case independently checks HTTP error status, invalid JSON, a stalled response body and redirect rejection. Each failure must remain nonblocking, execute its controlled shell call, and keep the response-body marker out of model results. Matching wrong observations cannot pass. These cases certify their narrow catalog requirements, not the full HTTP contract or V2.

## Prompt additional context

```sh
node scripts/verify-plugin.mjs --host v1 --dialect claude-code --prompts --http-prompt
```

The installed-package probe delivers Claude `UserPromptSubmit` additional context through a real HTTP endpoint. It checks prompt denial, native context roles, retained context, transcript readback, call ownership and command failure/timeout isolation alongside that HTTP handler. Native Claude independently supplies the reference `hook_additional_context` attachment shape. HTTP admission records transport completion and does not fabricate command, stdout or stderr fields. Existing command artifact validation remains required for command handlers.

This is installed-host evidence plus a native attachment reference, not a complete native-versus-host prompt differential. HTTP prompt transport/protocol failure artifacts are not implemented in transcript admission and fail explicitly with `TRANSCRIPT_HOOK_EXECUTION_UNAVAILABLE`; those configurations are outside this bounded prompt path. Warning artifacts, all header/authentication policies, every failure-policy combination, exact rendering, resume and V2 HTTP effects remain separate proof or integration gaps. Successful tool fault controls do not establish prompt failure parity.
