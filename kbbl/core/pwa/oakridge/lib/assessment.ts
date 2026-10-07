import type { Result } from "../../lib/result";
import type { AssessmentVerdict, CriterionStatus } from "../types";
import { parseTestEvidence, type TestEvidence } from "./build-result";

/** Mirrors `AssessmentFinding` in oakridge-dbos/src/domain/dev-flow-artifacts.ts. */
export interface AssessmentFinding {
  criterion: string | null;
  status: CriterionStatus | null;
  evidence: string | null;
  description: string | null;
}

/** Mirrors the registered oakridge-dbos `dev.assessment` artifact body. */
export interface Assessment {
  verdict: AssessmentVerdict;
  findings: AssessmentFinding[];
  test_evidence: TestEvidence | null;
  recommended_next_actions: string[];
}

export interface AssessmentParseError {
  operation: "parse_assessment";
  field: string;
  detail: string;
}

type Parsed<T> = Result<T, AssessmentParseError>;

const VERDICTS: readonly AssessmentVerdict[] = ["pass", "pass_with_notes", "fail"];
const CRITERION_STATUSES: readonly CriterionStatus[] = ["not_met", "partial", "met"];
const fail = (field: string, detail: string): Parsed<never> => ({ ok: false, error: { operation: "parse_assessment", field, detail } });

function isRecord(value: unknown): value is { [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const TEXT_FIELDS = ["criterion", "evidence", "description"] as const;

/** A nullable text field: absent or null reads as null, as does a blank string; anything else that is not a string is refused. */
function parseNullableText(value: unknown, field: string): Parsed<string | null> {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== "string") return fail(field, "expected a string or null");
  return { ok: true, value: value.trim() === "" ? null : value };
}

function parseFinding(value: unknown, field: string): Parsed<AssessmentFinding> {
  if (!isRecord(value)) return fail(field, "expected an object");
  const text: Partial<Record<(typeof TEXT_FIELDS)[number], string | null>> = {};
  for (const key of TEXT_FIELDS) {
    const parsed = parseNullableText(value[key], `${field}.${key}`);
    if (!parsed.ok) return parsed;
    text[key] = parsed.value;
  }
  const status = value.status === undefined || value.status === null
    ? null
    : CRITERION_STATUSES.find((candidate) => candidate === value.status);
  if (status === undefined) return fail(`${field}.status`, "expected met, partial, not_met or null");
  return { ok: true, value: { criterion: text.criterion ?? null, status, evidence: text.evidence ?? null, description: text.description ?? null } };
}

export function parseAssessment(body: unknown): Parsed<Assessment> {
  if (!isRecord(body)) return fail("body", "expected an object");
  const verdict = VERDICTS.find((candidate) => candidate === body.verdict);
  if (!verdict) return fail("verdict", "expected pass, pass_with_notes or fail");
  if (!Array.isArray(body.findings)) return fail("findings", "expected an array");
  const findings: AssessmentFinding[] = [];
  for (const [index, entry] of body.findings.entries()) {
    const finding = parseFinding(entry, `findings[${index}]`);
    if (!finding.ok) return finding;
    findings.push(finding.value);
  }
  const actions = body.recommended_next_actions;
  if (!Array.isArray(actions) || !actions.every((action) => typeof action === "string")) {
    return fail("recommended_next_actions", "expected an array of strings");
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
      verdict,
      findings,
      test_evidence: testEvidence,
      recommended_next_actions: actions,
    },
  };
}

/**
 * One line of the review: a brief criterion with the finding the assessor
 * recorded against it (null when it went unassessed), or a finding that names
 * no criterion from the brief.
 */
export type CriterionCheck =
  | { kind: "brief"; number: number; criterion: string; finding: AssessmentFinding | null }
  | { kind: "assessment_only"; finding: AssessmentFinding };

export interface CriterionTally {
  met: number;
  partial: number;
  not_met: number;
  unassessed: number;
}

export interface CriterionReport {
  /** Not met, then partial, then unassessed; brief order within each. */
  needs_attention: CriterionCheck[];
  met: CriterionCheck[];
  tally: CriterionTally;
}

export interface CriterionCount {
  /** null counts criteria the assessor never assessed. */
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
  return check.finding?.status ?? null;
}

/** The line a check is read by: the brief's criterion, else what the finding says about itself. */
export function selectCheckCriterionText(check: CriterionCheck): string {
  if (check.kind === "brief") return check.criterion;
  return check.finding.criterion ?? check.finding.description ?? "Unnamed finding";
}

/** A finding's description, when it adds something beyond the criterion line. */
export function selectCheckNote(check: CriterionCheck): string | null {
  const description = check.finding?.description ?? null;
  return description !== null && description !== selectCheckCriterionText(check) ? description : null;
}

const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
const ATTENTION_ORDER: readonly (CriterionStatus | null)[] = ["not_met", "partial", null];

/**
 * Lays the assessment over the brief's criteria. The assessor quotes each
 * criterion verbatim, so matching is on the whitespace-normalised text.
 */
export function selectCriterionReport(briefCriteria: string[] | null, findings: AssessmentFinding[]): CriterionReport {
  const unmatched = [...findings];
  const takeFinding = (criterion: string): AssessmentFinding | null => {
    const index = unmatched.findIndex((finding) => finding.criterion !== null && normalize(finding.criterion) === normalize(criterion));
    return index === -1 ? null : unmatched.splice(index, 1)[0] ?? null;
  };
  const briefChecks: CriterionCheck[] = (briefCriteria ?? []).map((criterion, index) => ({
    kind: "brief",
    number: index + 1,
    criterion,
    finding: takeFinding(criterion),
  }));
  const checks = [...briefChecks, ...unmatched.map((finding): CriterionCheck => ({ kind: "assessment_only", finding }))];
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
