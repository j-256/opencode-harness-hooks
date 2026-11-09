# Execution failures

The subprocess runner reports a stable status, process exit code and signal, and elapsed duration. Spawn errors omit operating-system error messages that could disclose a command or environment value. Captured stdout and stderr are execution data for the protocol interpreter; they must not be copied into general diagnostics.

Input and combined stdout/stderr have explicit byte budgets. An input-limit failure occurs before spawning a command. An output-limit failure terminates the process group and discards captured output; partial output must not become an approval, rewrite, or context message. These resource limits are plugin limits, not a claim that the native harness has the same limits.

The runner receives an explicit duration, including a nullable deadline for callers that own background lifetime. The dialect adapter owns native defaults and seconds-to-duration conversion. The runner does not inherit an arbitrary short timeout from another integration. Deadlines include stdin delivery and stream draining, and long deadlines are scheduled without overflowing Node's timer range.

On POSIX systems, cancellation, deadlines, and output-limit failures send SIGTERM to the subprocess group, then SIGKILL after a short grace period. Escalation still runs when the original process has exited but descendants remain. Descendants that deliberately leave the group require a different containment boundary. Windows descendant cleanup needs separate execution evidence.

HTTP and model evaluation use cancellable service scopes with the same explicit resource budgets. A timeout or cancellation aborts the service signal, releases timers and parent listeners, and prevents a late response from producing effects. A remote service can perform work before observing cancellation; cancellation does not undo an HTTP request or completed remote operation. Host evaluation services must honor the supplied signal.

Claude model-switch timeouts block the switch even without an explicit failure policy. Worktree creation fails when its hook fails. These event-specific rules remain separate from a configured `onFailure` policy.

Background completion records identify the source, registration, job, queued duration, execution duration and stable failure code. Invalid-field diagnostics name known fields without including their values. A nonzero background process can still provide native informational output; its process failure never becomes a veto on the already-started operation.

Background queue and deferred-output limits fail with explicit metadata instead of silently truncating context. Delivery or wake failures retain pending data for an explicit retry. Disposing the session cancels queued and running work, aborts pending host delivery and wake signals, and removes parent cancellation listeners. Failed telemetry callbacks are counted without exposing their exception text.

The tool bridge separates native denial from unavailable bridge capabilities and cancellation. It bounds retained calls and diagnostic history, retains no argument or output text in diagnostic records, and counts failed synchronous or asynchronous observers. Session or plugin disposal aborts both before-tool and post-tool dispatch, including a post-tool operation whose original-input claim has already been removed. V2 removes its registrations on disposal and partial setup failure; concurrent disposal shares one cleanup operation, and failed removals remain retryable with an explicit failure code. Late dispatch output cannot mutate tool arguments or apply effects after disposal. Input aliases use own-property lookup so reserved JavaScript property names remain literal data.
