import type { CohortId, RepositoryKey } from "../types";
import { parsePlanCriterionList, type PlanCriterion, type PlanTraceId } from "./plan";

interface LegacyBriefDecision {
  decision: string;
  rationale: string;
  id?: never;
}

interface LinkedBriefDecision {
  id: PlanTraceId;
  decision: string;
  rationale: string;
}

export type BriefDecision = LegacyBriefDecision | LinkedBriefDecision;

interface LegacyRejectedApproach {
  approach: string;
  reason: string;
  id?: never;
}

interface LinkedRejectedApproach {
  id: PlanTraceId;
  approach: string;
  reason: string;
  decision_ids: PlanTraceId[];
}

export type RejectedApproach = LegacyRejectedApproach | LinkedRejectedApproach;

/** Mirrors `brief_body` in workflow-config/development.yaml, including legacy revisions. */
export interface BuildBrief {
  cohort_id: CohortId;
  repository_key: RepositoryKey;
  title: string;
  depends_on: string[];
  goal: string;
  files_in_scope: string[];
  decisions_made: BriefDecision[];
  approaches_rejected: RejectedApproach[];
  acceptance_criteria: PlanCriterion[];
  next_action: string;
}

export const isBuildBriefIdLinked = (brief: BuildBrief): boolean =>
  brief.decisions_made.some((decision) => "id" in decision)
  || brief.approaches_rejected.some((approach) => "id" in approach)
  || brief.acceptance_criteria.some((criterion) => typeof criterion !== "string");

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

function isUniformList<T>(value: unknown, isEntry: (entry: unknown) => entry is T): value is T[] {
  if (!Array.isArray(value)) return false;
  const hasIds = value.length > 0 && isRecord(value[0]) && "id" in value[0];
  return value.every((entry) => isRecord(entry) && ("id" in entry) === hasIds && isEntry(entry));
}

function isBriefDecision(value: unknown): value is BriefDecision {
  return isRecord(value)
    && typeof value.decision === "string"
    && typeof value.rationale === "string"
    && (!("id" in value) || isIdent(value.id));
}

function isRejectedApproach(value: unknown): value is RejectedApproach {
  return isRecord(value)
    && typeof value.approach === "string"
    && typeof value.reason === "string"
    && (!("id" in value) || (isIdent(value.id) && isIdentList(value.decision_ids)));
}

export function isBuildBrief(value: unknown): value is BuildBrief {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const brief = value as Partial<BuildBrief>;
  return typeof brief.cohort_id === "string"
    && brief.cohort_id.trim().length > 0
    && typeof brief.repository_key === "string"
    && brief.repository_key.trim().length > 0
    && typeof brief.title === "string"
    && isStringArray(brief.depends_on)
    && typeof brief.goal === "string"
    && isStringArray(brief.files_in_scope)
    && isUniformList(brief.decisions_made, isBriefDecision)
    && isUniformList(brief.approaches_rejected, isRejectedApproach)
    && parsePlanCriterionList(brief.acceptance_criteria, "acceptance_criteria").ok
    && typeof brief.next_action === "string";
}

/** A build brief body, or null when it breaks the contract. */
export function readBuildBrief(body: unknown): BuildBrief | null {
  return isBuildBrief(body) ? body : null;
}
