import type { FindingSeverity, RequirementStatus } from "../types";

/** Mirrors `SpecFinding` in oakridge-dbos/src/domain/dev-flow-artifacts.ts. */
export interface SpecFinding {
  id: string;
  description: string;
  severity: FindingSeverity;
}

/** Mirrors `SpecRequirement` in oakridge-dbos/src/domain/dev-flow-artifacts.ts. */
export interface SpecRequirement {
  id: string;
  description: string;
  status: RequirementStatus;
}

/** Mirrors `DevRisk` in oakridge-dbos/src/domain/dev-flow-artifacts.ts. */
export interface SpecRisk {
  description: string;
  mitigation: string;
}

/** Mirrors the registered oakridge-dbos `dev.spec_analysis` artifact body. */
export interface SpecAnalysis {
  summary: string;
  source_spec_refs: string[];
  findings: SpecFinding[];
  requirements: SpecRequirement[];
  risks: SpecRisk[];
}

/** Anything in a spec analysis that stops the work: a blocking finding or a blocked requirement. */
export type SpecBlocker =
  | { kind: "finding"; finding: SpecFinding }
  | { kind: "requirement"; requirement: SpecRequirement };

export interface SpecStatusCount {
  status: FindingSeverity | RequirementStatus;
  count: number;
}

/** Non-zero counts across every finding and requirement, blockers included, most urgent first. */
export interface SpecAnalysisTally {
  status_counts: SpecStatusCount[];
  risk_count: number;
}

/** What the viewer renders: blockers pulled out, every other item listed once, most urgent first. */
export interface SpecAnalysisView {
  blockers: SpecBlocker[];
  findings: SpecFinding[];
  requirements: SpecRequirement[];
  risks: SpecRisk[];
  tally: SpecAnalysisTally;
}

const FINDING_SEVERITIES: readonly FindingSeverity[] = ["blocking", "warning", "info"];
const REQUIREMENT_STATUSES: readonly RequirementStatus[] = ["blocked", "ambiguous", "implementable"];

function isRecord(value: unknown): value is { [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isSpecFinding(value: unknown): value is SpecFinding {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.description === "string"
    && FINDING_SEVERITIES.some((severity) => severity === value.severity);
}

function isSpecRequirement(value: unknown): value is SpecRequirement {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.description === "string"
    && REQUIREMENT_STATUSES.some((status) => status === value.status);
}

function isSpecRisk(value: unknown): value is SpecRisk {
  return isRecord(value)
    && typeof value.description === "string"
    && typeof value.mitigation === "string";
}

export function isSpecAnalysis(value: unknown): value is SpecAnalysis {
  return isRecord(value)
    && typeof value.summary === "string"
    && isStringArray(value.source_spec_refs)
    && Array.isArray(value.findings) && value.findings.every(isSpecFinding)
    && Array.isArray(value.requirements) && value.requirements.every(isSpecRequirement)
    && Array.isArray(value.risks) && value.risks.every(isSpecRisk);
}

function countBy<K extends FindingSeverity | RequirementStatus, T>(keys: readonly K[], items: readonly T[], keyOf: (item: T) => K): SpecStatusCount[] {
  return keys
    .map((status) => ({ status, count: items.filter((item) => keyOf(item) === status).length }))
    .filter((entry) => entry.count > 0);
}

/** Stable sort by the position of each item's key in `order`; ties keep the agent's order. */
function orderBy<K extends string, T>(order: readonly K[], items: readonly T[], keyOf: (item: T) => K): T[] {
  return [...items].sort((a, b) => order.indexOf(keyOf(a)) - order.indexOf(keyOf(b)));
}

export function selectSpecAnalysisView(analysis: SpecAnalysis): SpecAnalysisView {
  const blockers: SpecBlocker[] = [
    ...analysis.findings.filter((finding) => finding.severity === "blocking").map((finding) => ({ kind: "finding" as const, finding })),
    ...analysis.requirements.filter((requirement) => requirement.status === "blocked").map((requirement) => ({ kind: "requirement" as const, requirement })),
  ];
  return {
    blockers,
    findings: orderBy(FINDING_SEVERITIES, analysis.findings.filter((finding) => finding.severity !== "blocking"), (finding) => finding.severity),
    requirements: orderBy(REQUIREMENT_STATUSES, analysis.requirements.filter((requirement) => requirement.status !== "blocked"), (requirement) => requirement.status),
    risks: analysis.risks,
    tally: {
      status_counts: [
        ...countBy(FINDING_SEVERITIES, analysis.findings, (finding) => finding.severity),
        ...countBy(REQUIREMENT_STATUSES, analysis.requirements, (requirement) => requirement.status),
      ],
      risk_count: analysis.risks.length,
    },
  };
}
