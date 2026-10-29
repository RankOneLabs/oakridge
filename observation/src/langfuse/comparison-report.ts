import { canonicalDigest } from "../canonical/canonical-json";
import type { CanonicalDigest, ExecutionId, GradeObservationId, ItemOccurrenceId, QuestionId } from "../domain/identity";
import { err, ok, type Result } from "../domain/primitives";
import type { EvaluationExecution } from "../grading/execution";
import type { GradeAnswer, GradeObservation } from "../grading/observation";
import type { PopulationManifest, PopulationMember } from "./population-manifest";

export type PilotSplit = "exploratory" | "held_out";
export type DisagreementCause = "machine_disagreement" | "evidence_insufficiency" | "ambiguous_rubric"
  | "inconsistent_human_review" | "unclassified";
export interface HumanComparisonLabel {
  readonly answer: GradeAnswer;
  readonly origin: "langfuse_annotation_blinded" | "oakridge_operator_unblinded" | "direct_human_unblinded";
  readonly reviewer_id: string;
}
export interface ComparisonMeasurement {
  readonly member: PopulationMember;
  readonly split: PilotSplit;
  /** Pinned evaluator identity or version; changing a model, prompt, or runtime changes this. */
  readonly evaluator_version: string;
  readonly attempt_label: string;
  readonly execution: EvaluationExecution | null;
  readonly observation: GradeObservation | null;
  readonly human_label: HumanComparisonLabel | null;
  readonly disagreement_cause: DisagreementCause | null;
}
export interface ComparisonGroupKey {
  readonly question_id: QuestionId;
  readonly question_version: string;
  readonly evidence_set_digest: CanonicalDigest;
  readonly population_manifest_id: string;
  readonly evaluator_version: string;
  readonly split: PilotSplit;
}
export type ComparisonState = "missing" | "failed" | "running" | "answered" | "abstain" | "unclear";
export interface ComparisonRow {
  readonly occurrence_id: ItemOccurrenceId;
  readonly attempt_label: string;
  readonly execution_id: ExecutionId | null;
  readonly observation_id: GradeObservationId | null;
  readonly state: ComparisonState;
  readonly answer: GradeAnswer | null;
  readonly probabilities: GradeObservation["probabilities"];
  readonly confidence: number | null;
  readonly normalized_score: number | null;
  readonly decision_policy_id: string | null;
  readonly decision_policy_version: string | null;
  readonly human_label: HumanComparisonLabel | null;
  readonly disagreement_cause: DisagreementCause | null;
  readonly latency_ms: number | null;
  readonly cost: number | null;
}
export interface LabelDisagreement { readonly label: string; readonly compared: number; readonly disagreements: number }
export interface MeasuredTotals { readonly count: number; readonly total: number }
export interface ComparisonGroup {
  readonly key: ComparisonGroupKey;
  readonly denominator: number;
  readonly answered: number;
  readonly missing: number;
  readonly failed: number;
  readonly running: number;
  readonly abstain: number;
  readonly unclear: number;
  readonly label_agreement: { readonly compared: number; readonly agreed: number };
  readonly per_label_disagreement: readonly LabelDisagreement[];
  readonly latency_ms: MeasuredTotals;
  readonly cost: MeasuredTotals;
  readonly rows: readonly ComparisonRow[];
}
export interface ComparisonReport {
  readonly population_manifest_id: string;
  readonly population_membership_digest: CanonicalDigest;
  readonly groups: readonly ComparisonGroup[];
}
export interface ComparisonError { readonly operation: "comparison_report"; readonly entity_id: string; readonly detail: string }

function failure(entity_id: string, detail: string): Result<never, ComparisonError> {
  return err({ operation: "comparison_report", entity_id, detail });
}
function answerLabel(answer: GradeAnswer): string {
  if (answer.state !== "answered") return answer.state;
  return typeof answer.value === "object" ? JSON.stringify(answer.value) : String(answer.value);
}
function sameAnswer(left: GradeAnswer, right: GradeAnswer): boolean {
  return left.state === right.state && left.kind === right.kind && answerLabel(left) === answerLabel(right);
}
function toRow(measurement: ComparisonMeasurement): ComparisonRow {
  const { execution, observation } = measurement;
  const state: ComparisonState = execution === null ? "missing"
    : execution.status === "failed" ? "failed" : execution.status === "running" ? "running"
      : observation === null ? "missing" : observation.answer.state;
  const latency_ms = execution?.ended_at === null || !execution ? null
    : execution.ended_at.getTime() - execution.started_at.getTime();
  return { occurrence_id: measurement.member.occurrence_id, attempt_label: measurement.attempt_label,
    execution_id: execution?.execution_id ?? null, observation_id: observation?.observation_id ?? null,
    state, answer: observation?.answer ?? null, probabilities: observation?.probabilities ?? null,
    confidence: observation?.confidence ?? null, normalized_score: observation?.normalized_score ?? null,
    decision_policy_id: observation?.decision_policy_id ?? null,
    decision_policy_version: observation?.decision_policy_version ?? null,
    human_label: measurement.human_label, disagreement_cause: measurement.disagreement_cause,
    latency_ms: latency_ms !== null && latency_ms >= 0 ? latency_ms : null, cost: execution?.cost ?? null };
}
function groupKey(manifest: PopulationManifest, measurement: ComparisonMeasurement): ComparisonGroupKey {
  return { question_id: measurement.member.question_id, question_version: measurement.member.question_version,
    evidence_set_digest: measurement.member.evidence_set_digest, population_manifest_id: manifest.manifest_id,
    evaluator_version: measurement.evaluator_version, split: measurement.split };
}
function summarize(key: ComparisonGroupKey, rows: readonly ComparisonRow[]): ComparisonGroup {
  const labels = new Map<string, { compared: number; disagreements: number }>();
  let compared = 0;
  let agreed = 0;
  for (const row of rows) {
    if (!row.answer || !row.human_label || row.state !== "answered") continue;
    compared++;
    const is_agreed = sameAnswer(row.answer, row.human_label.answer);
    if (is_agreed) agreed++;
    const label = answerLabel(row.human_label.answer);
    const count = labels.get(label) ?? { compared: 0, disagreements: 0 };
    count.compared++;
    if (!is_agreed) count.disagreements++;
    labels.set(label, count);
  }
  const measured = (field: "latency_ms" | "cost"): MeasuredTotals => ({
    count: rows.filter((row) => row[field] !== null).length,
    total: rows.reduce((sum, row) => sum + (row[field] ?? 0), 0),
  });
  return { key, denominator: rows.length, answered: rows.filter((row) => row.state === "answered").length,
    missing: rows.filter((row) => row.state === "missing").length,
    failed: rows.filter((row) => row.state === "failed").length,
    running: rows.filter((row) => row.state === "running").length,
    abstain: rows.filter((row) => row.state === "abstain").length,
    unclear: rows.filter((row) => row.state === "unclear").length,
    label_agreement: { compared, agreed },
    per_label_disagreement: [...labels].sort(([a], [b]) => a.localeCompare(b))
      .map(([label, count]) => ({ label, ...count })),
    latency_ms: measured("latency_ms"), cost: measured("cost"), rows };
}

/** Aggregates immutable attempts; unavailable and failed executions remain in the denominator. */
export function makeComparisonReport(manifest: PopulationManifest,
  measurements: readonly ComparisonMeasurement[]): Result<ComparisonReport, ComparisonError> {
  const membership_digest = canonicalDigest(manifest.membership);
  if (!membership_digest.ok || membership_digest.value !== manifest.membership_digest)
    return failure(manifest.manifest_id, "frozen population membership digest does not match");
  const members = new Map(manifest.membership.map((member) =>
    [`${member.occurrence_id}\u0000${member.question_id}\u0000${member.question_version}`, member]));
  const groups = new Map<string, { key: ComparisonGroupKey; rows: ComparisonRow[] }>();
  const identities = new Set<string>();
  for (const measurement of measurements) {
    const member = measurement.member;
    const identity = `${member.occurrence_id}\u0000${member.question_id}\u0000${member.question_version}`;
    const pinned = members.get(identity);
    if (!pinned || pinned.disposition !== "included" || pinned.evidence_set_digest !== member.evidence_set_digest
      || pinned.stratum !== member.stratum || pinned.reason !== member.reason)
      return failure(member.occurrence_id, "measurement does not match included frozen membership");
    if (!measurement.evaluator_version.trim() || !measurement.attempt_label.trim())
      return failure(member.occurrence_id, "evaluator version and attempt label are required");
    const execution = measurement.execution;
    const observation = measurement.observation;
    if (execution && (execution.subject_occurrence_id !== member.occurrence_id
      || execution.question_id !== member.question_id || execution.question_version !== member.question_version
      || execution.attempt_label !== measurement.attempt_label))
      return failure(member.occurrence_id, "execution does not match frozen measurement identity");
    if (observation && (!execution || execution.status !== "completed"))
      return failure(member.occurrence_id, "observation requires a completed execution");
    if (observation && ((observation.normalized_score === null)
      !== (observation.decision_policy_id === null && observation.decision_policy_version === null)
      || (observation.normalized_score !== null
        && (!observation.decision_policy_id || !observation.decision_policy_version))))
      return failure(observation.observation_id, "normalized score requires a pinned decision policy");
    const attemptIdentity = `${identity}\u0000${measurement.evaluator_version}\u0000${measurement.attempt_label}\u0000${execution?.execution_id ?? "missing"}`;
    if (identities.has(attemptIdentity)) return failure(member.occurrence_id, "duplicate measurement attempt");
    identities.add(attemptIdentity);
    const key = groupKey(manifest, measurement);
    const encoded = JSON.stringify(key);
    const group = groups.get(encoded) ?? { key, rows: [] };
    group.rows.push(toRow(measurement));
    groups.set(encoded, group);
  }
  return ok({ population_manifest_id: manifest.manifest_id,
    population_membership_digest: manifest.membership_digest,
    groups: [...groups.values()].sort((a, b) => JSON.stringify(a.key).localeCompare(JSON.stringify(b.key)))
      .map(({ key, rows }) => summarize(key, rows)) });
}
