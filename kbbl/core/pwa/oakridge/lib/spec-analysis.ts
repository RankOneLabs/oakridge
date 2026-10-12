import { selectFieldItems, selectFieldText } from "../artifact-types";

export type SpecBlocker =
  | { readonly kind: "finding"; readonly value: unknown }
  | { readonly kind: "requirement"; readonly value: unknown };

export interface SpecAnalysisView {
  readonly blockers: readonly SpecBlocker[];
  readonly findings: readonly unknown[];
  readonly requirements: readonly unknown[];
  readonly status_counts: readonly { readonly status: string; readonly count: number }[];
}

const FINDING_ORDER = ["warning", "info"] as const;
const REQUIREMENT_ORDER = ["ambiguous", "implementable"] as const;
const TALLY_ORDER = ["blocking", "warning", "info", "blocked", "ambiguous", "implementable"] as const;

/** Separate urgent checked records once, retaining the pinned severity/status meanings. */
export function selectCheckedSpecAnalysisView(body: unknown): SpecAnalysisView {
  const findings = selectFieldItems(body, "findings");
  const requirements = selectFieldItems(body, "requirements");
  const severity = (finding: unknown) => selectFieldText(finding, "severity");
  const status = (requirement: unknown) => selectFieldText(requirement, "status");
  const blockers: readonly SpecBlocker[] = [
    ...findings.filter((finding) => severity(finding) === "blocking").map((value): SpecBlocker => ({ kind: "finding", value })),
    ...requirements.filter((requirement) => status(requirement) === "blocked").map((value): SpecBlocker => ({ kind: "requirement", value })),
  ];
  const remainingFindings = findings.filter((finding) => severity(finding) !== "blocking")
    .toSorted((left, right) => FINDING_ORDER.indexOf(severity(left) as typeof FINDING_ORDER[number])
      - FINDING_ORDER.indexOf(severity(right) as typeof FINDING_ORDER[number]));
  const remainingRequirements = requirements.filter((requirement) => status(requirement) !== "blocked")
    .toSorted((left, right) => REQUIREMENT_ORDER.indexOf(status(left) as typeof REQUIREMENT_ORDER[number])
      - REQUIREMENT_ORDER.indexOf(status(right) as typeof REQUIREMENT_ORDER[number]));
  const status_counts = TALLY_ORDER.map((key) => ({ status: key, count: findings.filter((finding) => severity(finding) === key).length
    + requirements.filter((requirement) => status(requirement) === key).length })).filter((entry) => entry.count > 0);
  return { blockers, findings: remainingFindings, requirements: remainingRequirements, status_counts };
}
