import type { EvidenceSet } from "../grading/evidence";
import type { EvaluationExecution } from "../grading/execution";
import type { QuestionDefinition } from "../grading/question";
import type { ProjectionInput, ProjectionPolicy } from "../ports/evaluation-backend";
import { withTenant, type Database, type TenantScope } from "./database";

export interface ProjectionRequest {
  readonly execution_id: string;
  readonly question_text: string;
  readonly projection_version: string;
  readonly policy: ProjectionPolicy;
}

/** Loads the frozen execution, evidence, question and source revision a projection encodes. */
export function loadProjectionInput(db: Database, tenant: TenantScope, request: ProjectionRequest)
  : Promise<ProjectionInput | null> {
  return withTenant(db, tenant, async (trx) => {
    const execution = await trx.selectFrom("observation.evaluation_execution").selectAll()
      .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
      .where("execution_id", "=", request.execution_id).executeTakeFirst();
    if (!execution) return null;
    const evidence = await trx.selectFrom("observation.evidence_set").selectAll()
      .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
      .where("evidence_set_id", "=", execution.evidence_set_id).executeTakeFirst();
    const question = await trx.selectFrom("observation.question_definition").selectAll()
      .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
      .where("question_id", "=", execution.question_id).where("question_version", "=", execution.question_version)
      .executeTakeFirst();
    const occurrence = await trx.selectFrom("observation.item_occurrence").selectAll()
      .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
      .where("occurrence_id", "=", execution.subject_occurrence_id).executeTakeFirst();
    const revision = occurrence ? await trx.selectFrom("observation.source_revision").selectAll()
      .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
      .where("revision_id", "=", occurrence.revision_id).executeTakeFirst() : null;
    if (!evidence || !question || !occurrence || !revision) return null;
    return { execution: execution as unknown as EvaluationExecution,
      evidence: { evidence_set_id: evidence.evidence_set_id,
        references: evidence.evidence_refs as unknown as EvidenceSet["references"],
        is_incomplete: evidence.is_incomplete, incompleteness_reason: evidence.incompleteness_reason } as EvidenceSet,
      question: { ...question, question_id: question.question_id as QuestionDefinition["question_id"],
        target_item_kinds: question.target_item_kinds as string[],
        input_recipe: question.input_recipe as QuestionDefinition["input_recipe"],
        response_kind: question.response_kind as QuestionDefinition["response_kind"],
        allowed_values: question.allowed_values as QuestionDefinition["allowed_values"],
        missing_evidence_policy: question.missing_evidence_policy as QuestionDefinition["missing_evidence_policy"] },
      question_text: request.question_text,
      source: { producer: tenant.producer, namespace: tenant.namespace,
        run_id: occurrence.run_id as ProjectionInput["source"]["run_id"],
        unit_id: revision.unit_id as ProjectionInput["source"]["unit_id"],
        artifact_kind: revision.artifact_kind,
        revision_id: revision.revision_id as ProjectionInput["source"]["revision_id"],
        revision_digest: revision.body_digest as ProjectionInput["source"]["revision_digest"],
        logical_item_id: occurrence.logical_item_id as ProjectionInput["source"]["logical_item_id"],
        extractor_version: occurrence.extractor_version },
      policy: request.policy, projection_version: request.projection_version };
  });
}
