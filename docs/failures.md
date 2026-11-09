# Execution failures

The subprocess runner reports a stable status, process exit code and signal, and elapsed duration. Spawn errors omit operating-system error messages that could disclose a command or environment value. Captured stdout and stderr are execution data for the protocol interpreter; they must not be copied into general diagnostics.

Input and combined stdout/stderr have explicit byte budgets. An input-limit failure occurs before spawning a command. An output-limit failure terminates the process group and discards captured output; partial output must not become an approval, rewrite, or context message. These resource limits are plugin limits, not a claim that the native harness has the same limits.

The runner receives an explicit duration, including a nullable deadline for callers that own background lifetime. The dialect adapter owns native defaults and seconds-to-duration conversion. The runner does not inherit an arbitrary short timeout from another integration. Deadlines include stdin delivery and stream draining, and long deadlines are scheduled without overflowing Node's timer range.

On POSIX systems, cancellation, deadlines, and output-limit failures send SIGTERM to the subprocess group, then SIGKILL after a short grace period. Escalation still runs when the original process has exited but descendants remain. Descendants that deliberately leave the group require a different containment boundary. Windows descendant cleanup needs separate execution evidence.
