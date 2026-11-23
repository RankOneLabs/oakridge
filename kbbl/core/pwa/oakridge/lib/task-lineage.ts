import type { ObservationLineageEntry } from "../grading-contracts/grading/composite";
export interface TaskLineageGroup { kind: string; label: string; entries: ObservationLineageEntry[] }
export function selectTaskLineageGroups(entries: readonly ObservationLineageEntry[]): TaskLineageGroup[] {
  const groups = new Map<string, TaskLineageGroup>();
  for (const entry of entries) {
    const kind = entry.kind === "edge" ? "relationships" : entry.kind === "occurrence" ? entry.item_kind : entry.item.item_kind;
    const group = groups.get(kind) ?? { kind, label: kind.replaceAll("_", " "), entries: [] };
    group.entries.push(entry);
    groups.set(kind, group);
  }
  return [...groups.values()];
}

type RecordedDecision = import("../operator-contracts/projections/unit-view").OperatorRevisionDecision;

export interface RevisionDecisionRole {
  readonly role: "reviewed" | "assessment approved" | "effect target";
  readonly decision: RecordedDecision;
}

export function selectRevisionDecisionRoles(revisionId: string, decisions: readonly RecordedDecision[]): readonly RevisionDecisionRole[] {
  return decisions.flatMap((decision) => {
    const roles: RevisionDecisionRole[] = [];
    if (decision.reviewed_revision_id === revisionId) roles.push({ role: "reviewed", decision });
    if (decision.approved_assessment_revision_id === revisionId) roles.push({ role: "assessment approved", decision });
    if (decision.effect_target_revision_id === revisionId) roles.push({ role: "effect target", decision });
    return roles;
  });
}

export function selectRepositoryJudgments(
  repositories: readonly import("../grading-contracts/grading/composite").ObservationApplicableRepository[],
  decisions: readonly RecordedDecision[],
) {
  const approvals = new Set(decisions.map((decision) => decision.approved_assessment_revision_id));
  return repositories.map(({ repository_key, judgments }) => {
    const latest = judgments.findLast((judgment) => approvals.has(judgment.assessment_revision_id));
    return { repository_key, status: latest?.status ?? "pending" };
  });
}
