import type { OperatorBodyValue } from "../operator-contracts";
import { selectFieldItems, selectFieldText } from "../artifact-types";

export type SpecBlocker =
  | { readonly kind: "finding"; readonly value: OperatorBodyValue }
  | { readonly kind: "requirement"; readonly value: OperatorBodyValue };

export interface SpecAnalysisView {
  readonly blockers: readonly SpecBlocker[];
  readonly findings: readonly OperatorBodyValue[];
  readonly requirements: readonly OperatorBodyValue[];
  readonly status_counts: readonly { readonly status: string; readonly count: number }[];
}

const FINDING_ORDER = ["warning", "info"] as const;
const REQUIREMENT_ORDER = ["ambiguous", "implementable"] as const;
const TALLY_ORDER = ["blocking", "warning", "info", "blocked", "ambiguous", "implementable"] as const;

/** Separate blocking findings and blocked requirements once, then order the rest by severity and status. */
export function selectSpecAnalysisView(body: OperatorBodyValue): SpecAnalysisView {
  const findings = selectFieldItems(body, "findings");
  const requirements = selectFieldItems(body, "requirements");
  const severity = (finding: OperatorBodyValue) => selectFieldText(finding, "severity");
  const status = (requirement: OperatorBodyValue) => selectFieldText(requirement, "status");
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
