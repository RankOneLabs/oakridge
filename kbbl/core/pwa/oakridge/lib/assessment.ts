// The current reader lives in current-assessment; the finding parser below reads the findings grading evidence addresses.
export { parseCurrentAssessment, selectItemAssessmentGroups, selectAdditionalFindings, selectAssessmentActions, selectDerivedVerdict } from "./current-assessment";
export type { CurrentAssessment } from "./current-assessment";
import type { CohortId } from "../run-types";
import type { PlanTraceId } from "./plan";
import type { Result } from "../../lib/result";
import type { CriterionStatus } from "../artifact-types";

/** Mirrors `evidence_ref` in workflow-config/development.yaml. */
export interface EvidenceRef {
  kind: "file" | "test" | "output";
  ref: string;
  detail: string | null;
}

/** Mirrors `assessment_finding` in workflow-config/development.yaml, plus where it sits in its revision. */
export interface AssessmentFinding {
  /** The exact path that addresses this finding within its revision. */
  item_path: string;
  /** Explicit task links; empty is valid. A link is navigation, never the finding's address. */
  task_ids: PlanTraceId[];
  status: CriterionStatus | null;
  evidence: EvidenceRef[];
  description: string | null;
}

export interface AssessmentParseError {
  operation: "parse_assessment";
  field: string;
  detail: string;
}

type Parsed<T> = Result<T, AssessmentParseError>;

const CRITERION_STATUSES: readonly CriterionStatus[] = ["not_met", "partial", "met"];
const fail = (field: string, detail: string): Parsed<never> => ({ ok: false, error: { operation: "parse_assessment", field, detail } });

function isRecord(value: unknown): value is { [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A nullable text field: absent or null reads as null, as does a blank string; anything else that is not a string is refused. */
function parseNullableText(value: unknown, field: string): Parsed<string | null> {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== "string") return fail(field, "expected a string or null");
  return { ok: true, value: value.trim() === "" ? null : value };
}

function parseEvidence(value: unknown, field: string): Parsed<EvidenceRef[]> {
  if (!Array.isArray(value)) return fail(field, "expected a list of evidence references");
  const refs: EvidenceRef[] = [];
  for (const [index, entry] of value.entries()) {
    const entryField = `${field}[${index}]`;
    if (!isRecord(entry)) return fail(entryField, "expected an evidence reference object");
    if (entry.kind !== "file" && entry.kind !== "test" && entry.kind !== "output") {
      return fail(`${entryField}.kind`, "expected file, test or output");
    }
    if (typeof entry.ref !== "string") return fail(`${entryField}.ref`, "expected a string");
    const detail = parseNullableText(entry.detail, `${entryField}.detail`);
    if (!detail.ok) return detail;
    refs.push({ kind: entry.kind, ref: entry.ref, detail: detail.value });
  }
  return { ok: true, value: refs };
}

function parseTaskIds(value: unknown, field: string): Parsed<PlanTraceId[]> {
  if (!Array.isArray(value) || value.some((id) => typeof id !== "string" || id.trim() === "")) return fail(field, "expected a list of ids");
  return { ok: true, value: value as PlanTraceId[] };
}

function parseLegacyFinding(value: unknown, field: string, item_path: string): Parsed<AssessmentFinding> {
  if (!isRecord(value)) return fail(field, "expected an object");
  const taskIds = parseTaskIds(value.task_ids, `${field}.task_ids`);
  if (!taskIds.ok) return taskIds;
  const evidence = parseEvidence(value.evidence, `${field}.evidence`);
  if (!evidence.ok) return evidence;
  const description = parseNullableText(value.description, `${field}.description`);
  if (!description.ok) return description;
  const status = value.status === undefined || value.status === null
    ? null
    : CRITERION_STATUSES.find((candidate) => candidate === value.status);
  if (status === undefined) return fail(`${field}.status`, "expected met, partial, not_met or null");
  return { ok: true, value: { item_path, task_ids: taskIds.value, status, evidence: evidence.value, description: description.value } };
}

/** Mirrors assessment_subject in development.yaml. */
export type AssessmentSubject = { kind: "task"; id: PlanTraceId; cohort_id?: CohortId } | { kind: "build_item"; id: PlanTraceId; cohort_id?: CohortId };
export interface BuildItemFinding extends Omit<AssessmentFinding, "task_ids"> { subjects: AssessmentSubject[] }
function parseSubjects(value: unknown): Parsed<AssessmentSubject[]> {
  if (!Array.isArray(value)) return fail("subjects", "expected subjects");
  const subjects: AssessmentSubject[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || (entry.kind !== "task" && entry.kind !== "build_item") || typeof entry.id !== "string" || !entry.id.trim()
      || (entry.cohort_id != null && (typeof entry.cohort_id !== "string" || !entry.cohort_id.trim()))) return fail("subjects", "invalid subject");
    subjects.push({ kind: entry.kind, id: entry.id as PlanTraceId, ...(typeof entry.cohort_id === "string" ? { cohort_id: entry.cohort_id as CohortId } : {}) });
  }
  return { ok: true, value: subjects };
}
export function parseAssessmentFinding(value: unknown, field: string, item_path: string): Parsed<AssessmentFinding | BuildItemFinding> {
  if (!isRecord(value) || !("subjects" in value)) return parseLegacyFinding(value, field, item_path);
  const subjects = parseSubjects(value.subjects);
  if (!subjects.ok) return subjects;
  // Share validation of the common fields without turning subjects into legacy task links.
  const common = parseLegacyFinding({ ...value, task_ids: [] }, field, item_path);
  if (!common.ok) return common;
  const { task_ids, ...fields } = common.value;
  return { ok: true, value: { ...fields, subjects: subjects.value } };
}
