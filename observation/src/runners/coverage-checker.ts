import { err, ok, type JsonValue, type Result } from "../domain/primitives";
import type { EvaluationOutcome, GradingContext, GradingError, RunnerResult } from "../grading/runner";
import type { GradeRunner } from "../ports/grade-runner";
import type { LinkReference, SelectedItem } from "../projection/extractor";

/** The small link view mirrors brief.criteria and assessment.findings selections. */
export interface CoverageCriterion {
  readonly item_kind: "criterion";
  readonly item_scope: string;
  readonly producer_local_id: string;
}
export interface CoverageFinding {
  readonly item_kind: "assessment_finding";
  readonly links: readonly CoverageLink[];
}
export type CoverageLink = Pick<LinkReference, "type" | "target_artifact_kind" | "target_item_kind" | "target_local_id">;
export interface CoverageInput {
  readonly brief_criterion: CoverageCriterion;
  readonly assessment_findings: readonly CoverageFinding[];
}

export function coverageInput(briefCriterion: SelectedItem, assessmentFindings: readonly SelectedItem[])
  : Result<CoverageInput, GradingError> {
  if (briefCriterion.item_kind !== "criterion" || !briefCriterion.item_scope?.startsWith("cohort/")
    || !briefCriterion.producer_local_id)
    return err({ operation: "coverage_input", entity_id: briefCriterion.item_id_or_path,
      detail: "subject must be a cohort-scoped brief criterion" });
  if (assessmentFindings.some((finding) => finding.item_kind !== "assessment_finding"))
    return err({ operation: "coverage_input", entity_id: briefCriterion.item_id_or_path,
      detail: "all covering candidates must be assessment findings" });
  return ok({ brief_criterion: { item_kind: "criterion", item_scope: briefCriterion.item_scope,
    producer_local_id: briefCriterion.producer_local_id },
    assessment_findings: assessmentFindings.map((finding) => ({ item_kind: "assessment_finding", links: finding.links.map((link) => ({
      type: link.type, target_artifact_kind: link.target_artifact_kind, target_item_kind: link.target_item_kind,
      target_local_id: link.target_local_id })) })) });
}

/** Missing criterion_id creates no assesses link; it never creates a miss by itself. */
export function checkAssessmentCoverage(input: CoverageInput): Result<EvaluationOutcome, GradingError> {
  const criterion = input.brief_criterion;
  if (criterion.item_kind !== "criterion" || !criterion.item_scope.startsWith("cohort/") || !criterion.producer_local_id)
    return err({ operation: "assessment_coverage", entity_id: criterion.producer_local_id,
      detail: "invalid brief criterion identity" });
  if (input.assessment_findings.some((finding) => finding.item_kind !== "assessment_finding"))
    return err({ operation: "assessment_coverage", entity_id: criterion.producer_local_id,
      detail: "invalid assessment finding" });
  const covering = input.assessment_findings.filter((finding) => finding.links.some((link) =>
    link.type === "assesses" && link.target_artifact_kind === "brief"
    && link.target_item_kind === "criterion" && link.target_local_id === criterion.producer_local_id));
  return ok({ answer: { state: "answered", kind: "boolean", value: covering.length > 0 },
    rationale: `${covering.length} assessment findings explicitly assess brief criterion ${criterion.producer_local_id}` });
}

function isObject(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Decode the small, local link view stored in the first coverage evidence reference. */
export function decodeCoverageInput(value: JsonValue): Result<CoverageInput, GradingError> {
  const invalid = () => err({ operation: "decode_coverage_input", entity_id: "assessment.coverage",
    detail: "coverage evidence must contain a brief criterion and assessment finding links" });
  if (!isObject(value) || !isObject(value.brief_criterion) || !Array.isArray(value.assessment_findings)) return invalid();
  const criterion = value.brief_criterion;
  if (criterion.item_kind !== "criterion" || typeof criterion.item_scope !== "string"
    || typeof criterion.producer_local_id !== "string") return invalid();
  const findings: CoverageFinding[] = [];
  for (const candidate of value.assessment_findings) {
    if (!isObject(candidate) || candidate.item_kind !== "assessment_finding" || !Array.isArray(candidate.links)) return invalid();
    const links: CoverageLink[] = [];
    for (const link of candidate.links) {
      if (!isObject(link) || typeof link.type !== "string" || typeof link.target_artifact_kind !== "string"
        || typeof link.target_item_kind !== "string" || typeof link.target_local_id !== "string") return invalid();
      links.push({ type: link.type as LinkReference["type"], target_artifact_kind: link.target_artifact_kind,
        target_item_kind: link.target_item_kind, target_local_id: link.target_local_id });
    }
    findings.push({ item_kind: "assessment_finding", links });
  }
  return ok({ brief_criterion: { item_kind: "criterion", item_scope: criterion.item_scope,
    producer_local_id: criterion.producer_local_id }, assessment_findings: findings });
}

export function runCoverageCheck(context: GradingContext): RunnerResult {
  if (context.question.question_id !== "assessment.coverage" || context.question.response_kind !== "boolean")
    return err({ operation: "assessment_coverage", entity_id: context.question.question_id,
      detail: "coverage runner requires the boolean assessment.coverage question" });
  const content = context.evidence.references[0]?.content;
  if (content === undefined) return err({ operation: "assessment_coverage", entity_id: context.evidence.evidence_set_id,
    detail: "coverage link evidence is absent" });
  const decoded = decodeCoverageInput(content);
  return decoded.ok ? checkAssessmentCoverage(decoded.value) : decoded;
}

export const coverageChecker: GradeRunner = { kind: "code", run: async (context) => runCoverageCheck(context) };
