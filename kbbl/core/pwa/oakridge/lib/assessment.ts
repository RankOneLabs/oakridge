import type { Result } from "../../lib/result";
import type { AssessmentVerdict, CriterionStatus } from "../artifact-types";
import { parseTestEvidence, type TestEvidence } from "./build-result";
import type { PlanCriterion, PlanTraceId } from "./plan";

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

/** Mirrors `assessment_body` in workflow-config/development.yaml, for current revisions. */
export interface LegacyAssessment {
  shape?: "legacy";
  head_sha: string;
  verdict: AssessmentVerdict;
  findings: AssessmentFinding[];
  test_evidence: TestEvidence | null;
  recommended_next_actions: NextAction[];
}

/** Stored next_action from the authored assessment schema. */
export interface NextAction { readonly id: string; readonly text: string }

export interface AssessmentParseError {
  operation: "parse_assessment";
  field: string;
  detail: string;
}

type Parsed<T> = Result<T, AssessmentParseError>;

const VERDICTS: readonly AssessmentVerdict[] = ["pass", "pass_with_notes", "fail"];
const CRITERION_STATUSES: readonly CriterionStatus[] = ["not_met", "partial", "met"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
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

function parseLegacyAssessment(body: unknown): Parsed<LegacyAssessment> {
  if (!isRecord(body)) return fail("body", "expected an object");
  const verdict = VERDICTS.find((candidate) => candidate === body.verdict);
  if (!verdict) return fail("verdict", "expected pass, pass_with_notes or fail");
  if (typeof body.head_sha !== "string" || body.head_sha.trim() === "") return fail("head_sha", "expected the assessed commit");
  if (!Array.isArray(body.findings)) return fail("findings", "expected an array");
  const findings: AssessmentFinding[] = [];
  for (const [index, entry] of body.findings.entries()) {
    const finding = parseLegacyFinding(entry, `findings[${index}]`, `/findings/${index}`);
    if (!finding.ok) return finding;
    findings.push(finding.value);
  }
  const actions = body.recommended_next_actions;
  if (!Array.isArray(actions) || !actions.every((action) => isRecord(action) && typeof action.id === "string" && UUID.test(action.id) && typeof action.text === "string")) {
    return fail("recommended_next_actions", "expected {id, text} actions");
  }
  let testEvidence: TestEvidence | null = null;
  if (body.test_evidence !== undefined && body.test_evidence !== null) {
    const parsed = parseTestEvidence(body.test_evidence, "test_evidence");
    if (!parsed.ok) return fail(parsed.error.field, parsed.error.detail);
    testEvidence = parsed.value;
  }
  return {
    ok: true,
    value: {
      head_sha: body.head_sha,
      verdict,
      findings,
      test_evidence: testEvidence,
      recommended_next_actions: actions,
    },
  };
}

/** A task a finding names, with the brief's wording when this cohort's brief carries it. */
export interface CheckTask { readonly id: PlanTraceId; readonly number: number | null; readonly text: string | null }

/**
 * One line of the review. Every finding is one line, however many tasks it names and however many
 * findings share a task; a brief task no finding names is its own line. Links are explicit task ids,
 * nothing is matched by wording, and an id the brief does not hold stays visible as unresolved.
 */
export type CriterionCheck =
  | { kind: "finding"; finding: AssessmentFinding; tasks: CheckTask[]; unresolved_task_ids: PlanTraceId[] }
  | { kind: "unassessed"; number: number; criterion: PlanCriterion };

export interface CriterionTally {
  met: number;
  partial: number;
  not_met: number;
  unassessed: number;
}

export interface CriterionReport {
  /** Not met, then partial, then unassessed; finding order, then brief order, within each. */
  needs_attention: CriterionCheck[];
  met: CriterionCheck[];
  tally: CriterionTally;
}

export interface CriterionCount {
  /** null counts brief tasks no finding names and findings recorded with no status. */
  status: CriterionStatus | null;
  count: number;
}

/** Non-zero counts, worst first. */
export function selectCriterionCounts(tally: CriterionTally): CriterionCount[] {
  const counts: CriterionCount[] = [
    { status: "not_met", count: tally.not_met },
    { status: "partial", count: tally.partial },
    { status: null, count: tally.unassessed },
    { status: "met", count: tally.met },
  ];
  return counts.filter(({ count }) => count > 0);
}

export function selectCheckStatus(check: CriterionCheck): CriterionStatus | null {
  return check.kind === "finding" ? check.finding.status : null;
}

/** The line a check is read by: what the finding says, else the task it names, else the brief's task. */
export function selectCheckText(check: CriterionCheck): string {
  if (check.kind === "unassessed") return check.criterion.text;
  return check.finding.description ?? check.tasks.find((task) => task.text !== null)?.text ?? "Unnamed finding";
}

const ATTENTION_ORDER: readonly (CriterionStatus | null)[] = ["not_met", "partial", null];

/** Lays the assessment over the brief's tasks by explicit task id. A null brief (integration) has no comparison to make. */
function selectLegacyCriterionReport(briefCriteria: PlanCriterion[] | null, findings: AssessmentFinding[]): CriterionReport {
  const briefTasks = new Map((briefCriteria ?? []).map((criterion, index) => [criterion.id, { number: index + 1, text: criterion.text }]));
  const named = new Set(findings.flatMap((finding) => finding.task_ids));
  const findingChecks = findings.map((finding): CriterionCheck => ({ kind: "finding", finding,
    tasks: finding.task_ids.filter((id) => briefCriteria === null || briefTasks.has(id)).map((id) => ({ id, number: briefTasks.get(id)?.number ?? null, text: briefTasks.get(id)?.text ?? null })),
    unresolved_task_ids: briefCriteria === null ? [] : finding.task_ids.filter((id) => !briefTasks.has(id)) }));
  const unassessed = (briefCriteria ?? []).flatMap((criterion, index): CriterionCheck[] => named.has(criterion.id) ? [] : [{ kind: "unassessed", number: index + 1, criterion }]);
  const checks = [...findingChecks, ...unassessed];
  const statuses = checks.map(selectCheckStatus);
  return {
    needs_attention: ATTENTION_ORDER.flatMap((status) => checks.filter((check) => selectCheckStatus(check) === status)),
    met: checks.filter((check) => selectCheckStatus(check) === "met"),
    tally: {
      met: statuses.filter((status) => status === "met").length,
      partial: statuses.filter((status) => status === "partial").length,
      not_met: statuses.filter((status) => status === "not_met").length,
      unassessed: statuses.filter((status) => status === null).length,
    },
  };
}

/** Mirrors assessment_subject in development.yaml. */
export type AssessmentSubject = { kind: "task"; id: string; cohort_id?: string } | { kind: "build_item"; id: string; cohort_id?: string };
export interface BuildItemFinding extends Omit<AssessmentFinding, "task_ids"> { subjects: AssessmentSubject[] }
export interface BuildItemAssessment extends Omit<LegacyAssessment, "shape" | "findings"> { shape: "build_items"; findings: BuildItemFinding[] }
export type Assessment = LegacyAssessment | BuildItemAssessment;
function parseSubjects(value: unknown): Parsed<AssessmentSubject[]> {
  if (!Array.isArray(value)) return fail("subjects", "expected subjects");
  const subjects: AssessmentSubject[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || (entry.kind !== "task" && entry.kind !== "build_item") || typeof entry.id !== "string" || !entry.id.trim()
      || (entry.cohort_id !== undefined && typeof entry.cohort_id !== "string")) return fail("subjects", "invalid subject");
    subjects.push({ kind: entry.kind, id: entry.id, ...(typeof entry.cohort_id === "string" ? { cohort_id: entry.cohort_id } : {}) });
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
export function parseAssessment(body: unknown): Parsed<Assessment> {
  if (!isRecord(body) || !Array.isArray(body.findings) || !body.findings.some((finding) => isRecord(finding) && "subjects" in finding)) {
    const legacy = parseLegacyAssessment(body);
    return legacy.ok ? { ok: true, value: { ...legacy.value, shape: "legacy" } } : legacy;
  }
  const findings: BuildItemFinding[] = [];
  for (const [index, entry] of body.findings.entries()) {
    const parsed = parseAssessmentFinding(entry, `findings[${index}]`, `/findings/${index}`);
    if (!parsed.ok) return parsed;
    if (!("subjects" in parsed.value)) return fail("findings", "mixed finding shapes");
    findings.push(parsed.value);
  }
  const common = parseLegacyAssessment({ ...body, findings: [] });
  return common.ok ? { ok: true, value: { ...common.value, shape: "build_items", findings } } : common;
}

export interface BuildItemReportRow { item: import("./build-brief").BuildItem | null; findings: BuildItemFinding[]; unresolved_subjects?: AssessmentSubject[] }
export interface BuildItemReportGroup { label: string; rows: BuildItemReportRow[] }
export function selectBuildItemReport(brief: Extract<import("./build-brief").BuildBrief, { shape: "build_items" }> | null, findings: BuildItemFinding[]): BuildItemReportGroup[] {
  if (brief === null) return [{ label: "Findings", rows: findings.map((finding) => ({ item: null, findings: [finding] })) }];
  const matches = (subject: AssessmentSubject, id: string) => subject.kind === "build_item" && subject.id === id && (subject.cohort_id === undefined || subject.cohort_id === brief.cohort_id);
  const rows = brief.build_items.map((item) => ({ item, findings: findings.filter((finding) => finding.subjects.some((subject) => matches(subject, item.id))) }));
  const isMet = (row: BuildItemReportRow) => row.findings.length > 0 && row.findings.every((finding) => finding.status === "met");
  return [
    { label: "Needs attention", rows: rows.filter((row) => row.findings.length > 0 && !isMet(row)) },
    { label: "Not assessed", rows: rows.filter((row) => row.findings.length === 0) },
    { label: "Met (assessor's judgment)", rows: rows.filter(isMet) },
    { label: "Cross-cutting findings", rows: findings.filter((finding) => finding.subjects.length === 0).map((finding) => ({ item: null, findings: [finding] })) },
    { label: "Task findings", rows: findings.filter((finding) => finding.subjects.some((subject) => subject.kind === "task")).map((finding) => ({ item: null, findings: [finding] })) },
    { label: "Unresolved item references", rows: findings.flatMap((finding) => {
      const unresolved_subjects = finding.subjects.filter((subject) => subject.kind === "build_item" && !brief.build_items.some((item) => matches(subject, item.id)));
      return unresolved_subjects.length === 0 ? [] : [{ item: null, findings: [finding], unresolved_subjects }];
    }) },
  ];
}

type ItemBrief = Extract<import("./build-brief").BuildBrief, { shape: "build_items" }>;
export function selectCriterionReport(brief: ItemBrief, findings: BuildItemFinding[]): BuildItemReportGroup[];
export function selectCriterionReport(brief: PlanCriterion[] | null, findings: AssessmentFinding[]): CriterionReport;
export function selectCriterionReport(brief: ItemBrief | PlanCriterion[] | null, findings: AssessmentFinding[] | BuildItemFinding[]): CriterionReport | BuildItemReportGroup[] {
  if (brief !== null && !Array.isArray(brief)) return selectBuildItemReport(brief, findings.filter((finding): finding is BuildItemFinding => "subjects" in finding));
  return selectLegacyCriterionReport(brief, findings.filter((finding): finding is AssessmentFinding => "task_ids" in finding));
}
