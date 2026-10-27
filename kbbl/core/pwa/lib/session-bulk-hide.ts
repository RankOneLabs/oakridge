import type { SessionSnapshot } from "../types";
import type { Sid } from "./ids";
import type { SessionCloseRefusal } from "./session-close";

/** One attempted archive from DELETE /sessions/:sid?archive=true. */
export type BulkHideAttempt =
  | { readonly kind: "archived"; readonly sid: Sid }
  | { readonly kind: "refused"; readonly sid: Sid; readonly refusal: SessionCloseRefusal };

export interface BulkHideFailure {
  readonly sid: Sid;
  readonly refusal: SessionCloseRefusal;
}

export interface BulkHideOutcome {
  readonly eligibleCount: number;
  readonly archivedSids: readonly Sid[];
  readonly failures: readonly BulkHideFailure[];
}

export function selectBulkHideActionLabel(eligibleCount: number, isArmed: boolean): string {
  return `${isArmed ? "Confirm hide" : "Hide"} ${eligibleCount} ended ${eligibleCount === 1 ? "session" : "sessions"}`;
}

export function selectBulkHideFailureMessage(failure: BulkHideFailure): string {
  const { sid, refusal } = failure;
  return refusal.kind === "held_by_attempt"
    ? `${sid}: ${refusal.message} (run ${refusal.hold.run_id}, unit ${refusal.hold.unit_id})`
    : `${sid}: ${refusal.message}`;
}

/** Freeze the terminal, unarchived session identities before issuing any requests. */
export function selectBulkHideEligibleSessions(sessions: readonly SessionSnapshot[]): Sid[] {
  return sessions
    .filter((session) =>
      session.archivedAt === null &&
      (session.status === "ended" || session.status === "fenced" || session.status === "failed"),
    )
    .map((session) => session.sid as Sid);
}

/** Preserve each outcome so a refusal cannot hide successful archives. */
export function summarizeBulkHideOutcome(
  eligibleSids: readonly Sid[],
  attempts: readonly BulkHideAttempt[],
): BulkHideOutcome {
  return {
    eligibleCount: eligibleSids.length,
    archivedSids: attempts.flatMap((attempt) => attempt.kind === "archived" ? [attempt.sid] : []),
    failures: attempts.flatMap((attempt) => attempt.kind === "refused"
      ? [{ sid: attempt.sid, refusal: attempt.refusal }]
      : []),
  };
}
