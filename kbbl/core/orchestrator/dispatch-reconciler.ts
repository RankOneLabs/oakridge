import type { Database } from "bun:sqlite";
import type { SessionManager } from "../session/session-manager";
import type { AcpDispatchStatus } from "../acp/types";
import {
  listActiveAttempts,
  markAttemptFailed,
  markAttemptSucceeded,
  markRunningAttemptFailedBySessionRef,
  markRunningAttemptSucceededBySessionRef,
} from "../db/dispatch-attempts";

/** The slice of AcpSessionService dispatch settlement needs (testable port). */
export interface ReconcilerAcpPort {
  dispatchStatus(sid: string): AcpDispatchStatus | null;
}

/**
 * Eager settlement when a session leaves the live set (fence, operator
 * close, provisioning failure). Success is the initial turn having
 * succeeded — a session that ended any other way fails its attempt
 * instead of being blindly recorded as succeeded.
 */
export function settleAttemptForEndedSession(
  db: Database,
  acp: ReconcilerAcpPort,
  sid: string,
): void {
  const outcome = acp.dispatchStatus(sid);
  if (outcome === "completed") {
    markRunningAttemptSucceededBySessionRef(db, sid);
  } else if (outcome === "failed") {
    markRunningAttemptFailedBySessionRef(db, sid, {
      last_error: `session ${sid} ended without completing its initial turn`,
    });
  }
  // "running"/null: leave the claim — boot or lazy settlement owns it.
}

/**
 * Boot reconciliation for dispatch attempts.
 *
 * Runs once at server startup — after the ACP boot sweep, before new v1
 * dispatch work is accepted. Scans all active (dispatching or running)
 * dispatch_attempts and settles each from the durable record so the
 * active-claim slot reflects reality.
 *
 * Policy:
 * - dispatching (no actual_session_ref): the process died after the DB write
 *   but before session spawn completed. Mark dispatch_failed with
 *   spawn_not_observed_after_restart so the operator knows they can safely retry.
 * - running with an ACP session ref: ACP sessions are durable — the store
 *   survives restart and the boot sweep has already settled in-flight turns
 *   (prompting → unknown). Settle the attempt from the initial turn:
 *   succeeded → succeeded, failed → dispatch_failed, still unsettled →
 *   leave the claim (the session is resumable; lazy recovery owns it).
 * - running with a non-ACP (legacy) ref: the legacy manager is in-memory
 *   only, so the session is unknown post-restart. Mark dispatch_failed so
 *   the slot is freed; the operator can verify externally and retry.
 */
export function reconcileDispatchAttempts(
  db: Database,
  manager: SessionManager,
  acp: ReconcilerAcpPort,
): void {
  const stranded = listActiveAttempts(db);
  for (const attempt of stranded) {
    if (attempt.status === "dispatching") {
      markAttemptFailed(db, attempt.id, {
        last_error: "spawn_not_observed_after_restart: process died between DB claim and session spawn",
        recovery_hint:
          "Retry dispatch manually. The session was never started, so no duplicate work exists.",
      });
      continue;
    }
    // status === "running": settle from the ACP record when the ref is ours.
    const sessionRef = attempt.actual_session_ref ?? "(none)";
    const acpStatus = acp.dispatchStatus(sessionRef);
    if (acpStatus === "completed") {
      markAttemptSucceeded(db, attempt.id);
      continue;
    }
    if (acpStatus === "failed") {
      markAttemptFailed(db, attempt.id, {
        last_error: `session ${sessionRef} did not complete its initial turn (settled from the ACP record at restart)`,
        recovery_hint: "Retry dispatch manually.",
      });
      continue;
    }
    if (acpStatus === "running") {
      // The session survived the restart with unsettled work: the claim is
      // still valid, and marking it failed here would free the slot for
      // duplicate work against a resumable session.
      continue;
    }
    // Not an ACP session — legacy in-memory sessions do not survive restarts.
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
