// Named selectors over the authority unit view and observation reads; no stage topology is assumed.
import { itemSelectionKey } from "./grading";
import type { ArtifactId, Sid } from "../../lib/ids";
import { artifactId } from "../adapters/core";
import type { OperatorArtifactDetail } from "../operator-contracts/projections/artifact-view";
import type { OperatorArtifactRevisionView, OperatorUnitView } from "../operator-contracts/projections/unit-view";
import type { ObservationGradeableItemRow, ObservationItemAddress } from "../grading-contracts/grading/item-reads";
import type { ObservationItemStatusResponse } from "../grading-contracts/storage/grading-record-store";
import type { ObservationRunStageRead } from "../grading-contracts/grading/task-stages";
import type { ObservationCompositeRead } from "../grading-contracts/grading/item-reads";
import { selectUncapturedGradingLink, selectUncapturedTaskLink, selectDependencyLinks, selectGradingSubjectLink, selectIntentLinks, selectRevisionRelationships, selectTaskAssociationLink, type RecordedLink, type RelationshipIndex } from "./recorded-relationships";
import type { RunWorkspacePane } from "./run-workspace";
export type StageRead<Value> = { readonly state: "loaded"; readonly value: Value; readonly is_partial?: boolean } | { readonly state: "pending" | "unavailable" };
export interface StageOverviewSource {
  readonly unit: OperatorUnitView;
  readonly index: RelationshipIndex;
  readonly artifacts: readonly OperatorArtifactDetail[];
}
export interface StageInputAttempt extends Pick<OperatorUnitView["attempts"][number], "id" | "unit_id" | "worker" | "number" | "intent"> {}
export interface StageInputs {
  readonly resolved_input: OperatorUnitView["input"];
  readonly attempts: StageInputAttempt[];
  readonly links: readonly RecordedLink[];
}
export const selectStageInputs = ({ unit, index }: StageOverviewSource): StageInputs => ({
  resolved_input: unit.input,
  attempts: unit.attempts.map(({ id, unit_id, worker, number, intent }) => ({ id, unit_id, worker, number, intent })),
  links: [...selectDependencyLinks(index, unit), ...selectIntentLinks(index, unit)],
});
export interface StageAttempt extends Pick<OperatorUnitView["attempts"][number], "id" | "worker" | "number" | "status" | "mode" | "cause" | "is_current" | "failure"> { readonly session: RunWorkspacePane | null }
export interface StageOutputRevision { readonly revision: OperatorArtifactRevisionView; readonly pane: RunWorkspacePane; readonly links: readonly RecordedLink[] }
export interface StageOutput { readonly key: string; readonly schema: string; readonly revisions: readonly StageOutputRevision[] }
export interface StageExecution {
  readonly attempts: readonly StageAttempt[];
  readonly outputs: readonly StageOutput[];
  readonly reviews: OperatorUnitView["decisions"];
  readonly recorded_decisions: OperatorUnitView["recorded_decisions"];
}
export const selectStageExecution = ({ unit, index, artifacts }: StageOverviewSource): StageExecution => ({
  attempts: unit.attempts.map(({ kbbl_session_id, ...attempt }) => ({ ...attempt, session: kbbl_session_id === null ? null : { kind: "session", session_id: kbbl_session_id as Sid } })),
  outputs: unit.artifacts.map((artifact) => ({ key: artifact.artifact_key, schema: artifact.schema,
    revisions: (artifacts.find((detail) => detail.unit_id === unit.unit_id && detail.artifact_key === artifact.artifact_key)?.revisions ?? []).map((revision) => ({
      revision, pane: { kind: "artifact", artifact_id: artifactId(artifact) as ArtifactId, revision_id: revision.id, run_id: unit.run_id, unit_id: unit.unit_id },
      links: selectRevisionRelationships(index, revision) })) })),
  reviews: unit.decisions.filter((decision) => decision.submit.kind === "review"), recorded_decisions: unit.recorded_decisions,
});
export interface StageEvaluationSource {
  readonly source: StageOverviewSource;
  readonly stages: StageRead<readonly ObservationRunStageRead[]>;
  readonly findings: StageRead<readonly ObservationGradeableItemRow[]>;
  readonly tasks: StageRead<readonly ObservationCompositeRead[]>;
  readonly statuses: readonly StageRead<ObservationItemStatusResponse>[];
}
export interface StageEvaluation {
  readonly stages: StageEvaluationSource["stages"];
  readonly findings: StageEvaluationSource["findings"];
  readonly tasks: StageEvaluationSource["tasks"];
  readonly statuses: StageEvaluationSource["statuses"];
  readonly links: readonly RecordedLink[];
}
export function selectUnitFindings(source: StageOverviewSource, findings: readonly ObservationGradeableItemRow[]): readonly ObservationGradeableItemRow[] {
  const ids = new Set(source.index.revisions.filter((revision) => revision.unit_id === source.unit.unit_id).map((revision) => revision.id));
  return findings.filter(({ item }) => ids.has(item.source_revision_id));
}
export function selectStageEvaluation({ source, stages, findings, tasks, statuses }: StageEvaluationSource): StageEvaluation {
  const rows = findings.state === "loaded" ? selectUnitFindings(source, findings.value) : [];
  const ids = new Set(rows.map(({ item }) => item.occurrence_id));
  const selectedStatuses = statuses.filter((status) => status.state !== "loaded" || ids.has(status.value.item.occurrence_id));
  const taskIds = new Set(rows.flatMap((row) => row.links.items.flatMap((link) => link.state === "resolved" ? [link.logical_item_id] : [])));
  // Observation stages are run-level grading context and carry no revision ids.
  // Their labels are not authority stage identities; item reads below use revision ids.
  return { stages,
    findings: findings.state === "loaded" ? { ...findings, value: rows } : findings,
    tasks: tasks.state === "loaded" ? { ...tasks, value: tasks.value.filter((task) => taskIds.has(task.logical_item_id)) } : tasks,
    statuses: selectedStatuses,
    links: rows.flatMap((row) => [selectGradingSubjectLink(source.index, { item: row.item, question: null }), ...(row.links.total === 0 ? [selectUncapturedTaskLink(row.item.occurrence_id)] : row.links.items.map((link) => selectTaskAssociationLink(source.index, { link, item: row.item })))])
      .concat(findings.state === "loaded" ? source.index.revisions.filter((revision) => revision.unit_id === source.unit.unit_id && !rows.some((row) => row.item.source_revision_id === revision.id)).map((revision) => selectUncapturedGradingLink(revision.id)) : [])
      .concat(selectedStatuses.flatMap((status) => status.state === "loaded" ? status.value.questions.items.map((question) => selectGradingSubjectLink(source.index, { item: status.value.item, question: question.question, task_id: question.task_id })) : [])) };
}

export interface StageRow extends Pick<OperatorUnitView, "unit_id" | "label" | "stage"> { readonly status: OperatorUnitView["status"]["kind"] }
export const selectStageRows = (units: readonly OperatorUnitView[]): readonly StageRow[] => units.filter((unit) => unit.stage !== null)
  .map((unit) => ({ unit_id: unit.unit_id, label: unit.label, stage: unit.stage, status: unit.status.kind }));

type StageQuestionStatus = ObservationItemStatusResponse["questions"]["items"][number];
export interface StageEvaluator extends Pick<StageQuestionStatus["machine"]["items"][number], "evaluator_definition_id" | "backend_kind" | "model"> {}
export interface StageEvaluationQuestion {
  readonly selection: ObservationItemAddress;
  readonly question: StageQuestionStatus["question"];
  readonly evidence: StageQuestionStatus["evidence"];
  readonly human: StageQuestionStatus["human"];
  readonly evaluators: readonly StageEvaluator[];
  readonly machine: StageQuestionStatus["machine"] | null;
  readonly answers: StageQuestionStatus["answers"] | null;
  readonly superseded_answers: StageQuestionStatus["superseded_answers"] | null;
}
export const selectEvaluationSelections = (status: ObservationItemStatusResponse): readonly ObservationItemAddress[] => status.questions.items.map((question) => ({
  source_revision_id: status.item.source_revision_id, item_path: status.item.item_path, task_id: question.task_id,
}));
export const selectIsGradingReadPartial = (status: ObservationItemStatusResponse): boolean => status.questions.total > status.questions.items.length
  || status.links.total > status.links.items.length || status.questions.items.some((question) => question.answers.total > question.answers.items.length
    || question.evidence.references.total > question.evidence.references.items.length || question.machine.total > question.machine.items.length
    || question.machine.items.some((machine) => machine.attempts.total > machine.attempts.items.length));

/** Blinding is applied before presentation, including the new overview. */
export function selectEvaluationQuestions(status: ObservationItemStatusResponse, revealed_item_keys: ReadonlySet<string>): readonly StageEvaluationQuestion[] {
  return status.questions.items.map((question) => {
    const selection = { source_revision_id: status.item.source_revision_id, item_path: status.item.item_path, task_id: question.task_id };
    const is_revealed = revealed_item_keys.has(itemSelectionKey(selection));
    return { selection, question: question.question, evidence: question.evidence, human: question.human,
      evaluators: question.machine.items.map(({ evaluator_definition_id, backend_kind, model }) => ({ evaluator_definition_id, backend_kind, model })),
      machine: is_revealed ? question.machine : null, answers: is_revealed ? question.answers : null, superseded_answers: is_revealed ? question.superseded_answers : null };
  });
}
