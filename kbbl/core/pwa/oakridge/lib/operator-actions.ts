import type { OperatorDisposition } from "../operator-contracts/domain/adjudication";
import type { OperatorRunView } from "../operator-contracts/projections/run-view";

const dispositionLabels = { accepted: "Kept", modified: "Edited", rejected: "Dropped" } as const satisfies Record<OperatorDisposition, string>;

export interface OperatorActionRow {
  readonly key: string;
  readonly disposition_label: typeof dispositionLabels[OperatorDisposition] | "Added";
  readonly original_text: string | null;
  readonly final_text: string | null;
  readonly source_label: string;
  readonly assessment_revision_id: string;
  readonly review: string;
  readonly decision: string;
  readonly actor_label: string;
  readonly created_at: string;
}

export function selectOperatorActionRows(run: Pick<OperatorRunView, "operator_actions">): readonly OperatorActionRow[] {
  return [...(run.operator_actions ?? [])]
    .sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at)
      || right.decision_id.localeCompare(left.decision_id))
    .map(entry => ({
      key: `${entry.decision_id}:${entry.action_id}`,
      disposition_label: entry.kind === "added" ? "Added" : dispositionLabels[entry.disposition],
      original_text: entry.kind === "added" ? null : entry.original_text,
      final_text: entry.final_text,
      source_label: `${entry.source.kind === "item_assessment" ? "Item" : "Finding"} ${entry.source.id}`,
      assessment_revision_id: entry.assessment_revision_id,
      review: entry.review,
      decision: entry.decision,
      actor_label: entry.actor?.kind === "operator" ? entry.actor.subject : entry.actor?.kind ?? "Unknown",
      created_at: entry.created_at,
    }));
}
