import type { OperatorBodyValue } from "../operator-contracts";
import { selectFieldItems, selectFieldText } from "../artifact-types";

export interface AssessmentView {
  readonly needs_attention: readonly OperatorBodyValue[];
  readonly met: readonly OperatorBodyValue[];
  readonly status_counts: readonly { readonly status: string; readonly count: number }[];
}

const COUNT_ORDER = ["not_met", "partial", "met"] as const;

/** Group the assessor's findings by status, the unmet first, without inventing criteria the body does not name. */
export function selectAssessmentView(body: OperatorBodyValue): AssessmentView {
  const findings = selectFieldItems(body, "findings");
  const status = (finding: OperatorBodyValue) => selectFieldText(finding, "status");
  const attentionPriority = (finding: OperatorBodyValue): number => status(finding) === "not_met" ? 0 : status(finding) === "partial" ? 1 : 2;
  const needs_attention = findings.filter((finding) => status(finding) !== "met")
    .toSorted((left, right) => attentionPriority(left) - attentionPriority(right));
  const met = findings.filter((finding) => status(finding) === "met");
  const status_counts = COUNT_ORDER.map((key) => ({ status: key, count: findings.filter((finding) => status(finding) === key).length }))
    .filter((entry) => entry.count > 0);
  return { needs_attention, met, status_counts };
}
