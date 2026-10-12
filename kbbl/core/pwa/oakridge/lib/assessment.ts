import { selectFieldItems, selectFieldText } from "../artifact-types";

export interface CheckedAssessmentView {
  readonly needs_attention: readonly unknown[];
  readonly met: readonly unknown[];
  readonly status_counts: readonly { readonly status: string; readonly count: number }[];
}

const COUNT_ORDER = ["not_met", "partial", "met"] as const;

/** Group checked findings without inventing brief criteria absent from this projection. */
export function selectCheckedAssessmentView(body: unknown): CheckedAssessmentView {
  const findings = selectFieldItems(body, "findings");
  const status = (finding: unknown) => selectFieldText(finding, "status");
  const attentionPriority = (finding: unknown): number => status(finding) === "not_met" ? 0 : status(finding) === "partial" ? 1 : 2;
  const needs_attention = findings.filter((finding) => status(finding) !== "met")
    .toSorted((left, right) => attentionPriority(left) - attentionPriority(right));
  const met = findings.filter((finding) => status(finding) === "met");
  const status_counts = COUNT_ORDER.map((key) => ({ status: key, count: findings.filter((finding) => status(finding) === key).length }))
    .filter((entry) => entry.count > 0);
  return { needs_attention, met, status_counts };
}
