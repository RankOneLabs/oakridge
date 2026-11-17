import type { UsageTurn, UsageReview } from "../domain/usage";
import type { RunRead } from "../storage/read-store";
export function turnDuration(turn: UsageTurn): { agent_ms: number | null; queue_ms: number | null } {
  return { agent_ms: turn.started_at && turn.completed_at ? Date.parse(turn.completed_at)-Date.parse(turn.started_at) : null,
    queue_ms: turn.started_at ? Date.parse(turn.started_at)-Date.parse(turn.created_at) : null };
}
export interface ReviewTime extends UsageReview { unit_id: string; kind: "human" | "external" }
export function reviewTimes(read: RunRead): ReviewTime[] {
  return read.decisions.flatMap((decision): ReviewTime[] => {
    const unit = read.units.find((u) => u.id === decision.unit_id);
    const stage = unit?.stage ? read.definition.parsed_workflow.stages[unit.stage] : null;
    const review = stage?.reviews?.[decision.review];
    if (!review || review.by === "engine") return [];
    const revision = read.revisions.find((r) => r.id === decision.target_revision_id);
    if (!revision) return [];
    const external = decision.review === "merge_confirmation" || decision.review === "pr_closed";
    const periodic = Object.values(stage?.workers ?? {}).some((w) => w.kind === "code" && !!w.every && w.produces.includes(revision.artifact));
    return [{ unit_id: decision.unit_id, review: decision.review, decision: decision.decision,
      wait_ms: +decision.created_at - +revision.created_at, approximate: !!review.when || (external && periodic), kind: external ? "external" : "human" }];
  });
}
export const elapsedTime = (read: RunRead): number => Math.max(+read.run.created_at, ...read.revisions.map((r) => +r.created_at), ...read.decisions.map((d) => +d.created_at)) - +read.run.created_at;
