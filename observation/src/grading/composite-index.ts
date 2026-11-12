import type { EvaluatorDefinitionId, EvidenceSetId, ExecutionId, ItemOccurrenceId } from "../domain/identity";
import { AUTOMATIC_ATTEMPT_LABEL } from "./execution";
import type { QuestionDefinition, QuestionKey } from "./question";
import type { CompositeAnswer, CompositeEvaluator, CompositeExecution, CompositeInputs, CompositeRelation } from "./composite";
import type { EvidenceSet } from "./evidence";

/** Read-local lookups derived from one captured snapshot; never cached across database reads. */
export interface CompositeIndexes {
  readonly relations: ReadonlyMap<ItemOccurrenceId, readonly CompositeRelation[]>;
  readonly evidence: ReadonlyMap<string, readonly EvidenceSet[]>;
  readonly evaluators: ReadonlyMap<EvaluatorDefinitionId, CompositeEvaluator>;
  readonly machines: ReadonlySet<EvaluatorDefinitionId>;
  readonly executions: ReadonlyMap<EvidenceSetId, ReadonlyMap<EvaluatorDefinitionId, CompositeExecution>>;
  readonly answers_by_execution: ReadonlyMap<ExecutionId, CompositeAnswer>;
  readonly current_answers: ReadonlyMap<string, readonly CompositeAnswer[]>;
  readonly superseded_answers: ReadonlyMap<string, readonly CompositeAnswer[]>;
  readonly questions: ReadonlyMap<string, QuestionDefinition>;
}

export function groupRows<Row, Key>(rows: readonly Row[], keyOf: (row: Row) => Key): ReadonlyMap<Key, readonly Row[]> {
  const groups = new Map<Key, Row[]>();
  for (const row of rows) {
    const key = keyOf(row);
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }
  return groups;
}
export const subjectIndexKey = (occurrence_id: ItemOccurrenceId, task_id: string | null): string => JSON.stringify([occurrence_id, task_id]);
export const questionIndexKey = (question: QuestionKey): string => JSON.stringify([question.question_id, question.question_version]);

export function indexCompositeInputs(inputs: CompositeInputs): CompositeIndexes {
  const executions = new Map<EvidenceSetId, Map<EvaluatorDefinitionId, CompositeExecution>>();
  for (const execution of inputs.executions) {
    if (execution.attempt_label !== AUTOMATIC_ATTEMPT_LABEL) continue;
    const byEvaluator = executions.get(execution.evidence_set_id) ?? new Map<EvaluatorDefinitionId, CompositeExecution>();
    if (!byEvaluator.has(execution.evaluator_definition_id)) byEvaluator.set(execution.evaluator_definition_id, execution);
    executions.set(execution.evidence_set_id, byEvaluator);
  }
  const answers = new Map<ExecutionId, CompositeAnswer>();
  for (const answer of inputs.answers) if (!answers.has(answer.execution_id)) answers.set(answer.execution_id, answer);
  const replaced = new Set(inputs.answers.flatMap((answer) => answer.supersedes_observation_id ? [answer.supersedes_observation_id] : []));
  const current: CompositeAnswer[] = [];
  const superseded: CompositeAnswer[] = [];
  for (const answer of inputs.answers) (replaced.has(answer.observation_id) ? superseded : current).push(answer);
  const questions = new Map<string, QuestionDefinition>();
  for (const question of inputs.questions) if (!questions.has(questionIndexKey(question))) questions.set(questionIndexKey(question), question);
  return {
    relations: groupRows(inputs.relations, (relation) => relation.source_occurrence_id),
    evidence: groupRows(inputs.evidence_sets, (evidence) => subjectIndexKey(evidence.subject_occurrence_id, evidence.task_id)),
    evaluators: new Map(inputs.evaluators.map((evaluator) => [evaluator.evaluator_definition_id, evaluator])),
    machines: new Set(inputs.evaluators.filter((evaluator) => evaluator.kind !== "human").map((evaluator) => evaluator.evaluator_definition_id)),
    executions, answers_by_execution: answers,
    current_answers: groupRows(current, (answer) => subjectIndexKey(answer.occurrence_id, answer.task_id)),
    superseded_answers: groupRows(superseded, (answer) => subjectIndexKey(answer.occurrence_id, answer.task_id)), questions,
  };
}
