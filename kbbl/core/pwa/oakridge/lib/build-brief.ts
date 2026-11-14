import type { CohortId, RepositoryKey } from "../run-types";
import { parsePlanCriterionList, type PlanCriterion, type PlanTraceId } from "./plan";

export interface BriefDecision {
  id: PlanTraceId;
  decision: string;
  rationale: string;
}

export interface RejectedApproach {
  id: PlanTraceId;
  approach: string;
  reason: string;
  decision_ids: PlanTraceId[];
}

/** Mirrors `brief_body` in workflow-config/development.yaml. */
export interface BriefFields {
  cohort_id: CohortId;
  repository_key: RepositoryKey;
  title: string;
  depends_on: string[];
  goal: string;
  files_in_scope: string[];
  decisions_made: BriefDecision[];
  approaches_rejected: RejectedApproach[];
  next_action: string;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isRecord(value: unknown): value is { [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIdent(value: unknown): value is PlanTraceId {
  return typeof value === "string" && value.trim().length > 0;
}

function isIdentList(value: unknown): value is PlanTraceId[] {
  return Array.isArray(value) && value.every(isIdent);
}

function isBriefDecision(value: unknown): value is BriefDecision {
  return isRecord(value)
    && typeof value.decision === "string"
    && typeof value.rationale === "string"
    && isIdent(value.id);
}

function isRejectedApproach(value: unknown): value is RejectedApproach {
  return isRecord(value)
    && typeof value.approach === "string"
    && typeof value.reason === "string"
    && isIdent(value.id)
    && isIdentList(value.decision_ids);
}

function isBriefFields(value: unknown): value is BriefFields {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const brief = value as Partial<BriefFields>;
  return typeof brief.cohort_id === "string"
    && brief.cohort_id.trim().length > 0
    && typeof brief.repository_key === "string"
    && brief.repository_key.trim().length > 0
    && typeof brief.title === "string"
    && isStringArray(brief.depends_on)
    && typeof brief.goal === "string"
    && isStringArray(brief.files_in_scope)
    && Array.isArray(brief.decisions_made) && brief.decisions_made.every(isBriefDecision)
    && Array.isArray(brief.approaches_rejected) && brief.approaches_rejected.every(isRejectedApproach)
    && typeof brief.next_action === "string";
}

/** Mirrors build_item in workflow-config/development.yaml. */
export interface BuildItem {
  id: PlanTraceId;
  description: string;
  task_ids: PlanTraceId[];
  decision_ids: PlanTraceId[];
  verification: string[];
}
export type BuildBrief = BriefFields & (
  | { shape: "legacy"; acceptance_criteria: PlanCriterion[] }
  | { shape: "build_items"; build_items: BuildItem[] }
);
export function isBuildItem(value: unknown): value is BuildItem {
  return isRecord(value) && isIdent(value.id) && typeof value.description === "string"
    && isIdentList(value.task_ids) && isIdentList(value.decision_ids) && isStringArray(value.verification);
}
export function parseBuildBrief(body: unknown): BuildBrief | null {
  if (!isBriefFields(body) || !isRecord(body)) return null;
  if ("build_items" in body) return Array.isArray(body.build_items) && body.build_items.every(isBuildItem)
    ? { ...body, shape: "build_items", build_items: body.build_items } : null;
  const criteria = parsePlanCriterionList(body.acceptance_criteria, "acceptance_criteria");
  return criteria.ok ? { ...body, shape: "legacy", acceptance_criteria: criteria.value } : null;
}
export const readBuildBrief = parseBuildBrief;
/** Shape guard for raw artifact callers; parsed consumers use parseBuildBrief. */
export function isBuildBrief(body: unknown): boolean { return parseBuildBrief(body) !== null; }
