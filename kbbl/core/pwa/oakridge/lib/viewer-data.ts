import type { Result } from "../../lib/result";
import type { FindingSeverity } from "../artifact-types";
import type { RepositoryKey } from "../run-types";

export interface CanonicalRequirement {
  id: string;
  text: string;
  acceptance_conditions: string[];
  source_refs: string[];
  analysis_finding_ids: string[];
}

export interface CanonicalSpec {
  objective: string;
  requirements: CanonicalRequirement[];
  non_goals: string[];
}

export interface CurrentFinding {
  id: string;
  severity: FindingSeverity;
  observation: string;
  evidence: { kind: "file" | "search" | "test" | "output"; ref: string; detail: string }[];
  expected_change_locations: { path: string; symbol?: string | null }[];
  resolution?: {
    kind: "spec_update" | "operator_decision" | "implementation_note";
    text: string;
    question?: string | null;
    alternatives?: { option: string; consequence: string }[] | null;
    chosen?: string | null;
  } | null;
}

export interface CurrentAnalysis {
  requirements: { id: string; text: string; source_refs: string[]; findings: CurrentFinding[] }[];
}

export interface CurrentCohort {
  id: string;
  repository_key: RepositoryKey;
  title: string;
  scope: string;
  allocations: { requirement_id: string; contribution: string }[];
  depends_on: string[];
  rationale: string;
}

export interface CurrentPlan { cohorts: CurrentCohort[] }

export interface CurrentBrief {
  cohort_id: string;
  repository_key: RepositoryKey;
  depends_on: string[];
  files_in_scope: string[];
  build_items: { id: string; requirement_ids: string[]; instructions: string; verification: string[] }[];
  technical_decisions: { id: string; build_item_ids: string[]; decision: string; rationale: string }[];
}

export interface ResolvedAssignment { cohort: CurrentCohort; requirements: CanonicalRequirement[] }

/** The registry checks the pinned schema first. These checks describe which
 * values a specialized presentation can display. */
type ViewerResult<Body> = Result<Body, { readonly detail: string }>;
function presentation<Body>(body: unknown, canDisplay: boolean): ViewerResult<Body> {
  return canDisplay ? { ok: true, value: body as Body } :
    { ok: false, error: { detail: "This artifact does not provide the fields used by this viewer." } };
}

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : null;
}

function rows(value: unknown, fields: readonly string[]): boolean {
  return Array.isArray(value) && value.every((entry) => {
    const row = record(entry);
    return row !== null && fields.every((field) => Object.hasOwn(row, field));
  });
}

export function parseCurrentAnalysis(body: unknown): ViewerResult<CurrentAnalysis> {
  const requirements = record(body)?.requirements;
  const canDisplay = Array.isArray(requirements) && requirements.every((item) => {
    const entry = record(item);
    return typeof entry?.id === "string" && Array.isArray(entry.source_refs)
      && rows(entry.findings, ["id", "severity", "observation", "evidence", "expected_change_locations"]);
  });
  return presentation(body, canDisplay);
}

export function parseCanonicalSpec(body: unknown): ViewerResult<CanonicalSpec> {
  const value = record(body);
  return presentation(body, typeof value?.objective === "string" && Array.isArray(value.non_goals)
    && rows(value.requirements, ["id", "text", "acceptance_conditions", "source_refs", "analysis_finding_ids"]));
}

export function readCohort(value: unknown): CurrentCohort | null {
  const entry = record(value);
  return entry && typeof entry.id === "string" && Array.isArray(entry.depends_on) && rows(entry.allocations, ["requirement_id", "contribution"])
    ? value as CurrentCohort : null;
}

export function parseCurrentPlan(body: unknown): ViewerResult<CurrentPlan> {
  const cohorts = record(body)?.cohorts;
  return presentation(body, Array.isArray(cohorts) && cohorts.every(readCohort));
}

export function parseCurrentBrief(body: unknown): ViewerResult<CurrentBrief> {
  const value = record(body);
  const strings = (list: unknown): boolean => Array.isArray(list) && list.every((item) => typeof item === "string");
  return presentation(body, typeof value?.cohort_id === "string" && typeof value.repository_key === "string"
    && strings(value.depends_on) && strings(value.files_in_scope)
    && Array.isArray(value.build_items) && value.build_items.every((item) => {
      const row = record(item);
      return typeof row?.id === "string" && typeof row.instructions === "string" && strings(row.requirement_ids) && strings(row.verification);
    })
    && Array.isArray(value.technical_decisions) && value.technical_decisions.every((item) => {
      const row = record(item);
      return typeof row?.id === "string" && typeof row.decision === "string" && typeof row.rationale === "string" && strings(row.build_item_ids);
    }));
}

export function readAssignment(body: unknown): ResolvedAssignment | null {
  const value = record(body);
  return value && readCohort(value.cohort) && rows(value.requirements, ["id", "text", "acceptance_conditions", "source_refs", "analysis_finding_ids"])
    ? body as ResolvedAssignment : null;
}
