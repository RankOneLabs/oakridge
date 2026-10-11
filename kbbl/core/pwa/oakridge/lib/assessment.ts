import type { OperatorCheckedValue, OperatorSchema } from "../operator-contracts";
import { selectFieldItems, selectFieldText } from "../artifact-types";

export interface CheckedAssessmentView {
  readonly needs_attention: readonly OperatorCheckedValue[];
  readonly met: readonly OperatorCheckedValue[];
  readonly status_counts: readonly { readonly status: string; readonly count: number }[];
}

const COUNT_ORDER = ["not_met", "partial", "met"] as const;

/** Group checked findings without inventing brief criteria absent from this projection. */
export function selectCheckedAssessmentView(body: OperatorCheckedValue, schemas: readonly OperatorSchema[]): CheckedAssessmentView {
  const findings = selectFieldItems(body, schemas, "findings");
  const status = (finding: OperatorCheckedValue) => selectFieldText(finding, schemas, "status");
  const attentionPriority = (finding: OperatorCheckedValue): number => status(finding) === "not_met" ? 0 : status(finding) === "partial" ? 1 : 2;
  const needs_attention = findings.filter((finding) => status(finding) !== "met")
    .toSorted((left, right) => attentionPriority(left) - attentionPriority(right));
  const met = findings.filter((finding) => status(finding) === "met");
  const status_counts = COUNT_ORDER.map((key) => ({ status: key, count: findings.filter((finding) => status(finding) === key).length }))
    .filter((entry) => entry.count > 0);
  return { needs_attention, met, status_counts };
}
