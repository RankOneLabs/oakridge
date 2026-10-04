import type * as V15 from "../domain/dev-flow-v15";
import { artifactRefFromRevision } from "../domain/dev-flow-v15";
import type { PlanBody, BuildBriefBody } from "../domain/dev-flow-artifacts";
import type { RepositoryRefsBody } from "../domain/dev-flow-v15";
import { materializeStage, type StageMaterializationSource, type StageMaterializationError } from "../decision/materialize-stage";
import { err, ok, type ArtifactId, type CohortId, type StageInstanceId, type WorkflowRunId, type JsonValue, type Result } from "../domain/primitives";
import type { TransactionalSqlExecutor } from "./sql-executor";
import { loadImplementationCohortSnapshot } from "./load-run-snapshot";

interface StageRow {
  readonly run_id: WorkflowRunId;
  readonly stage_key: V15.StageKey;
  readonly status: string;
  readonly initialized_at: string | null;
  readonly context: V15.V15RunInputs;
  readonly stage_contract: V15.StageDefinition<unknown> & { readonly dependency_stage_instance_ids: readonly StageInstanceId[] };
}
interface AcceptedOutput {
  readonly stage_key: V15.StageKey;
  readonly output_name: string;
  readonly chain_id: ArtifactId;
  readonly revision: number;
  readonly body: JsonValue;
}
export type MaterializedStage = { readonly kind: "opened"; readonly cohort_ids: readonly CohortId[] }
  | { readonly kind: "stage_not_active"; readonly detail: string };

/** Stage lock serializes freezing the complete membership and its input refs. */
export const materializeStageInStorage = async (sql: TransactionalSqlExecutor,
  input: { readonly stage_instance_id: StageInstanceId; readonly at: string }):
  Promise<Result<MaterializedStage, StageMaterializationError>> => sql.transaction(async (tx) => {
  const rows = await tx.query<StageRow>(
    `SELECT stage.run_id::text,stage.stage_key,stage.status,stage.initialized_at::text,stage.stage_contract,run.context
     FROM oakridge.stage_instance stage JOIN oakridge.workflow_run run ON run.id=stage.run_id
     WHERE stage.id=$1 AND run.status='active' FOR UPDATE OF stage`, [input.stage_instance_id]);
  const stage = rows[0];
  if (!stage || stage.status !== "active") return ok({ kind: "stage_not_active", detail: "run or stage is stopped" });
  const readIds = async () => (await tx.query<{ readonly id: CohortId }>(
    "SELECT id::text FROM oakridge.cohort WHERE stage_instance_id=$1 ORDER BY materialization_position,cohort_key", [input.stage_instance_id])).map((row) => row.id);
  if (stage.initialized_at) return ok({ kind: "opened", cohort_ids: await readIds() });
  const prerequisites = await tx.query<{ readonly id: StageInstanceId; readonly status: string }>(
    "SELECT id::text,status FROM oakridge.stage_instance WHERE id=ANY($1::uuid[]) FOR SHARE", [stage.stage_contract.dependency_stage_instance_ids ?? []]);
  if (prerequisites.length !== stage.stage_contract.prerequisites.length || prerequisites.some((row) => row.status !== "complete"))
    return err({ operation: "materialize_stage", stage_instance_id: input.stage_instance_id,
      kind: "upstream_unavailable", detail: "stage prerequisites are not complete" });
  const outputs = await tx.query<AcceptedOutput>(
    `SELECT stage.stage_key,output.output_name,artifact.chain_id::text,artifact.revision,artifact.body
     FROM oakridge.worker_output output JOIN oakridge.cohort cohort ON cohort.id=output.cohort_id
     JOIN oakridge.stage_instance stage ON stage.id=cohort.stage_instance_id
     JOIN oakridge.artifact artifact ON artifact.id=output.artifact_id
     WHERE stage.run_id=$1 AND output.acceptance_state='accepted' ORDER BY cohort.created_at,output.collection_key`, [stage.run_id]);
  const analysis = outputs.find((output) => output.stage_key === "spec_analysis" && output.output_name === "spec_analysis");
  const plan = outputs.find((output) => output.stage_key === "planning" && output.output_name === "plan");
  const completed: V15.CompletedImplementation[] = [];
  if (stage.stage_key === "final_integration") {
    const implementations = await tx.query<{ readonly id: CohortId }>(
      `SELECT cohort.id::text FROM oakridge.cohort cohort JOIN oakridge.stage_instance stage ON stage.id=cohort.stage_instance_id
       WHERE stage.run_id=$1 AND stage.stage_key='implementation' ORDER BY cohort.created_at,cohort.cohort_key`, [stage.run_id]);
    for (const implementation of implementations) {
      const loaded = await loadImplementationCohortSnapshot(tx, implementation.id);
      if (!loaded.ok || loaded.value.state !== "complete" || !loaded.value.accepted_build || !loaded.value.assessment.outputs.assessment)
        return err({ operation: "materialize_stage", stage_instance_id: input.stage_instance_id,
          kind: "upstream_unavailable", detail: "implementation has no completed accepted build and assessment" });
      const cohort = loaded.value;
      completed.push({ cohort_key: cohort.key, repository_key: cohort.inputs.repository.refs.repository_key as V15.CompletedImplementation["repository_key"],
        brief: cohort.inputs.brief, build: cohort.accepted_build!, assessment: {
          id: cohort.assessment.outputs.assessment!.id, version: cohort.assessment.outputs.assessment!.version } });
    }
  }
  const source: StageMaterializationSource = { stage_instance_id: input.stage_instance_id, run: stage.context,
    repositories: outputs.filter((output) => output.stage_key === "repository_preparation" && output.output_name === "repository_refs")
      .map((output) => ({ ref: artifactRefFromRevision(output), body: output.body as unknown as RepositoryRefsBody })),
    analysis: analysis ? artifactRefFromRevision(analysis) : null,
    plan: plan ? { ref: artifactRefFromRevision(plan), body: plan.body as unknown as PlanBody } : null,
    briefs: outputs.filter((output) => output.stage_key === "brief_writing" && output.output_name === "briefs")
      .map((output) => ({ ref: artifactRefFromRevision(output), body: output.body as unknown as BuildBriefBody })), completed };
  const selected = materializeStage(stage.stage_key, source);
  if (!selected.ok) return selected;
  for (const [position, cohort] of selected.value.entries()) {
    await tx.query(`INSERT INTO oakridge.cohort
      (id,run_id,stage_instance_id,cohort_key,state,depends_on,frozen_inputs,created_at,materialization_position)
      VALUES ($1,$2,$3,$4,'pending',$5::text[],$6::jsonb,$7::timestamptz,$8)`,
      [cohort.id, stage.run_id, input.stage_instance_id, cohort.cohort_key, cohort.depends_on, JSON.stringify(cohort.frozen_inputs), input.at, position]);
    for (const worker of cohort.workers) await tx.query(
      "INSERT INTO oakridge.cohort_worker (cohort_id,worker) VALUES ($1,$2)", [cohort.id, worker]);
  }
  await tx.query("UPDATE oakridge.stage_instance SET initialized_at=$2::timestamptz,durable_version=durable_version+1 WHERE id=$1", [input.stage_instance_id, input.at]);
  return ok({ kind: "opened", cohort_ids: selected.value.map((cohort) => cohort.id) });
});
