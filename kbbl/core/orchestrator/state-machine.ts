import type { CohortStatus } from "../types/task-tracker";

export type { CohortStatus };

export type CohortEvent =
  | "dependencies_met"
  | "briefing_started"
  | "brief_submitted"
  | "brief_reopened"
  | "brief_approved"
  | "brief_rejected"
  | "build_completed"
  | "pr_merged"
  | "block"
  | "unblock"
  | "plan_approved"
  | "brief_approved_deps_met"
  | "brief_approved_deps_pending"
  | "pr_opened";

export type PlanStatus = "draft" | "pending_approval" | "approved" | "rejected" | "superseded";
export type PlanEvent = "submit" | "approve" | "reject" | "supersede";

export type BriefStatus = "pending_approval" | "approved" | "rejected" | "superseded";
export type BriefEvent = "approve" | "reject" | "supersede";

export const COHORT_TRANSITIONS: Record<CohortStatus, Partial<Record<CohortEvent, CohortStatus>>> = {
  waiting:       { dependencies_met: "planned", plan_approved: "briefing",                                                            block: "blocked" },
  planned:       { briefing_started: "briefing",                                                                                      block: "blocked" },
  briefing:      { brief_submitted: "brief_review",                                                                                   block: "blocked" },
  brief_review:  { brief_approved: "building", brief_reopened: "briefing", brief_rejected: "briefing", brief_approved_deps_met: "building", brief_approved_deps_pending: "ready_to_build", block: "blocked" },
  building:      { build_completed: "done", pr_merged: "done", pr_opened: "awaiting_merge",                                          block: "blocked" },
  ready_to_build: { dependencies_met: "building",                                                                                     block: "blocked" },
  awaiting_merge: { pr_merged: "done",                                                                                                block: "blocked" },
  done:          { block: "blocked" },
  blocked:       {},
};

export const PLAN_TRANSITIONS: Record<PlanStatus, Partial<Record<PlanEvent, PlanStatus>>> = {
  draft:            { submit: "pending_approval" },
  pending_approval: { approve: "approved", reject: "rejected" },
  approved:         { supersede: "superseded" },
  rejected:         { supersede: "superseded" },
  superseded:       {},
};

export const BRIEF_TRANSITIONS: Record<BriefStatus, Partial<Record<BriefEvent, BriefStatus>>> = {
  pending_approval: { approve: "approved", reject: "rejected" },
  approved:         { supersede: "superseded" },
  rejected:         { supersede: "superseded" },
  superseded:       {},
};

/**
 * Pure helper: compute next CohortStatus from current + event.
 * For 'unblock', caller must supply preBlockStatus (stored in DB on block).
 * Returns { error } if transition is not defined.
 */
export function applyCohortTransition(
  current: CohortStatus,
  event: CohortEvent,
  preBlockStatus?: Exclude<CohortStatus, "blocked"> | null,
): CohortStatus | { error: string } {
  if (event === "unblock") {
    if (current !== "blocked") {
      return { error: `cannot unblock from ${current}: cohort is not blocked` };
    }
    if (!preBlockStatus) {
      return { error: "no pre_block_status recorded; cannot restore prior state" };
    }
    return preBlockStatus;
  }
  const next = COHORT_TRANSITIONS[current]?.[event];
  if (next === undefined) {
    return { error: `no transition from '${current}' via '${event}'` };
  }
  return next;
}
