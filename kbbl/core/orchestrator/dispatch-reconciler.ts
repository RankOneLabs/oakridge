import type { Database } from "bun:sqlite";
import type { SessionManager } from "../session/session-manager";
import { listActiveAttempts, markAttemptFailed } from "../db/dispatch-attempts";

/**
 * Boot reconciliation for dispatch attempts.
 *
 * Runs once at server startup, before new v1 dispatch work is accepted.
 * Scans all active (dispatching or running) dispatch_attempts and resolves
 * each stranded record into an operator-visible terminal state so the
 * active-claim slot is freed and retries are possible.
 *
 * Policy:
 * - dispatching (no actual_session_ref): the process died after the DB write
 *   but before session spawn completed. Mark dispatch_failed with
 *   spawn_not_observed_after_restart so the operator knows they can safely retry.
 * - running (has actual_session_ref): the process held an active session ref at
 *   crash time. Because the session manager is in-memory only and does not
 *   survive restarts, the session is unknown post-restart. Mark dispatch_failed
 *   so the slot is freed; the operator can verify the session separately and
 *   retry if needed.
 */
export function reconcileDispatchAttempts(db: Database, manager: SessionManager): void {
  const stranded = listActiveAttempts(db);
  for (const attempt of stranded) {
    if (attempt.status === "dispatching") {
      markAttemptFailed(db, attempt.id, {
        last_error: "spawn_not_observed_after_restart: process died between DB claim and session spawn",
        recovery_hint:
          "Retry dispatch manually. The session was never started, so no duplicate work exists.",
      });
    } else {
      // status === "running": had an actual_session_ref, but the manager does
      // not know about it after restart.
      const sessionRef = attempt.actual_session_ref ?? "(none)";
      const session = manager.get(sessionRef);
      if (!session || session.status === "ended") {
        markAttemptFailed(db, attempt.id, {
          last_error: `session ${sessionRef} not found in session manager after restart — state is unknown`,
          recovery_hint:
            "Verify the agent process externally. If it is not running, retry dispatch manually.",
        });
      }
      // If the session IS known and alive (edge case: live session after hot
      // reload in dev), leave it running — the claim is still valid.
    }
  }
}
