import type { UsageTurn, UsageReview } from "../domain/usage";
import { isTerminalStatus, selectRootStatus } from "../domain/unit-status";
import type { RunRead } from "../storage/read-store";
import type { ReviewDecisionRecord } from "../storage/schema-records";
export function turnDuration(turn: UsageTurn): { agent_ms: number | null; queue_ms: number | null } {
  return { agent_ms: turn.started_at && turn.completed_at ? Date.parse(turn.completed_at)-Date.parse(turn.started_at) : null,
    queue_ms: turn.started_at ? Date.parse(turn.started_at)-Date.parse(turn.created_at) : null };
}
/**
 * The revision a decision reviewed: the unit's latest revision of the review's `of`
 * artifact at or before the decision. A redirected decision (`on:`) targets another
 * artifact, so its target revision does not say when the review became ready.
 */
export function selectReviewedRevision(read: Pick<RunRead, "revisions">, decision: ReviewDecisionRecord, artifact: string) {
  return read.revisions.filter((r) => r.unit_id === decision.unit_id && r.artifact === artifact && +r.created_at <= +decision.created_at)
    .sort((a,b) => +b.created_at - +a.created_at || b.seq-a.seq)[0] ?? null;
}
export interface ReviewTime extends UsageReview { unit_id: string; kind: "human" | "external" }
export function reviewTimes(read: RunRead): ReviewTime[] {
  return read.decisions.flatMap((decision): ReviewTime[] => {
    const unit = read.units.find((u) => u.id === decision.unit_id);
    const stage = unit?.stage ? read.definition.parsed_workflow.stages[unit.stage] : null;
    const review = stage?.reviews?.[decision.review];
    if (!review || review.by === "engine") return [];
    const reviewed = selectReviewedRevision(read, decision, review.of);
    // Without the reviewed revision, the effect target is the only start left, and only approximate.
    const revision = reviewed ?? read.revisions.find((r) => r.id === decision.target_revision_id);
    if (!revision) return [];
    const external = decision.review === "merge_confirmation" || decision.review === "pr_closed";
    const periodic = Object.values(stage?.workers ?? {}).some((w) => w.kind === "code" && !!w.every && w.produces.includes(revision.artifact));
    return [{ unit_id: decision.unit_id, review: decision.review, decision: decision.decision,
      wait_ms: +decision.created_at - +revision.created_at, approximate: !reviewed || !!review.when || (external && periodic), kind: external ? "external" : "human" }];
  });
}
/** A finished run ends at its last recorded event (the terminal transition); an active run runs to the read. */
export function elapsedTime(read: RunRead, now: Date): number {
  const end = isTerminalStatus(selectRootStatus(read.run, read.units))
    ? Math.max(+read.run.created_at, ...read.latest_events.map((e) => +e.created_at), ...read.revisions.map((r) => +r.created_at), ...read.decisions.map((d) => +d.created_at))
    : +now;
  return Math.max(0, end - +read.run.created_at);
}
