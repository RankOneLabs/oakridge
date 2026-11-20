import type { FindingSeverity, RequirementStatus } from "../artifact-types";

/** Mirrors `spec_finding` in workflow-config/development.yaml. */
export interface SpecFinding {
  id: string;
  description: string;
  severity: FindingSeverity;
}

/** Mirrors `requirement` in workflow-config/development.yaml. */
export interface SpecRequirement {
  id: string;
  description: string;
  status: RequirementStatus;
}

const FINDING_SEVERITIES: readonly FindingSeverity[] = ["blocking", "warning", "info"];
const REQUIREMENT_STATUSES: readonly RequirementStatus[] = ["blocked", "ambiguous", "implementable"];

function isRecord(value: unknown): value is { [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isSpecFinding(value: unknown): value is SpecFinding {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.description === "string"
    && FINDING_SEVERITIES.some((severity) => severity === value.severity);
}

export function isSpecRequirement(value: unknown): value is SpecRequirement {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.description === "string"
    && REQUIREMENT_STATUSES.some((status) => status === value.status);
}

export { parseCurrentAnalysis, type CurrentAnalysis, type CurrentFinding } from "./current-contract";
export { requirementStatus, selectAnalysisCounts, selectCodeHotspots, selectOperatorDecisions } from "./current-analysis";
