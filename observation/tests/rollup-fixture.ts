import type { ArtifactRevisionId, EvaluatorDefinitionId, EvidenceSetId, ExecutionId, GradeObservationId, ItemOccurrenceId, LogicalItemId, QuestionId, RelationId, RunId, UnitId } from "../src/domain/identity";
import type { CompositeAnswer, CompositeInputs, CompositeOccurrence, CompositeRelation, CompositeRevision } from "../src/grading/composite";
import type { EvidenceSet } from "../src/grading/evidence";
import type { QuestionDefinition } from "../src/grading/question";

export const task = "task:T1" as LogicalItemId;
export const otherTask = "task:T2" as LogicalItemId;
export const grader = "fixture-grader" as EvaluatorDefinitionId;
export const question: QuestionDefinition = { question_id: "fixture.question" as QuestionId, question_version: "1", question_text: "Does this item satisfy its obligation?",
  item_kind: "fixture-item", response_kind: "boolean", allowed_values: null, missing_evidence_policy: "abstain", abstain_semantics: "missing", unclear_semantics: "unclear", interpretation_caveats: "independent" };
export const revision = (revision_id: string, stage: string, artifact_kind = stage): CompositeRevision => ({ revision_id: revision_id as ArtifactRevisionId,
  unit_id: `unit:${revision_id}` as UnitId, stage, artifact_kind, predecessor_id: null, recorded_at: new Date(0), captured_at: new Date(0) });
export const occurrence = (occurrence_id: string, source: CompositeRevision, logical_item_id: LogicalItemId | null = null, item_path = "/items/0"): CompositeOccurrence =>
  ({ occurrence_id: occurrence_id as ItemOccurrenceId, revision_id: source.revision_id, artifact_kind: source.artifact_kind, item_kind: "fixture-item", item_path, logical_item_id, selected_value: occurrence_id });
export const edge = (source: CompositeOccurrence, target: CompositeOccurrence | LogicalItemId, type: CompositeRelation["type"] = "assesses"): CompositeRelation =>
  ({ relation_id: `${source.occurrence_id}:${typeof target === "string" ? target : target.occurrence_id}:${type}` as RelationId,
    source_occurrence_id: source.occurrence_id, target_logical_item_id: typeof target === "string" ? target : null,
    target_occurrence_id: typeof target === "string" ? null : target.occurrence_id, type, unresolved_target_ref: null, evidence_ref: `${source.item_path}/task_ids/0`, asserted_by: "producer_explicit" });
export const evidence = (item: CompositeOccurrence, task_id: LogicalItemId | null, ready = true): EvidenceSet =>
  ({ evidence_set_id: `evidence:${item.occurrence_id}:${task_id}` as EvidenceSetId, subject_occurrence_id: item.occurrence_id, task_id,
    question_id: question.question_id, question_version: question.question_version, pinned_evaluator_definition_ids: [grader],
    readiness: ready ? { state: "ready", references: [], ready_at: new Date(0) } : { state: "not_ready", reason: { code: "missing", detail: "not captured" } }, is_incomplete: false, incompleteness_reason: null });
export const answer = (set: EvidenceSet): CompositeAnswer => ({ observation_id: `answer:${set.evidence_set_id}` as GradeObservationId,
  execution_id: `execution:${set.evidence_set_id}` as ExecutionId, occurrence_id: set.subject_occurrence_id, task_id: set.task_id, evidence_set_id: set.evidence_set_id,
  question, evaluator_definition_id: grader, reviewer_id: null, answer: { state: "answered", kind: "boolean", value: true }, supersedes_observation_id: null,
  confidence: null, rationale: null, comments: null, recorded_at: new Date(0) });
export const inputs = (overrides: Partial<CompositeInputs> = {}): CompositeInputs => ({ run_id: "fixture-run" as RunId, is_grading_enabled: true,
  stages: [], pins: [], revisions: [], occurrences: [], relations: [], evidence_sets: [], answers: [], questions: [question],
  logical_items: [{ logical_item_id: task, scope: "task", producer_local_id: "T1" }, { logical_item_id: otherTask, scope: "task", producer_local_id: "T2" }],
  evaluators: [{ evaluator_definition_id: grader, kind: "code", backend_kind: "fixture", provider: "fixture", model: null }], ...overrides,
  executions: overrides.executions ?? (overrides.answers ?? []).map((answer) => ({ task_id: answer.task_id, occurrence_id: answer.occurrence_id,
    execution_id: answer.execution_id, evidence_set_id: answer.evidence_set_id, evaluator_definition_id: answer.evaluator_definition_id,
    attempt_label: "automatic", status: "completed", terminal_cause: null, error: null })) });
export const all = { limit: 200, offset: 0 };
