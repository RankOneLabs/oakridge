import type * as V15 from "../domain/dev-flow-v15";
import { artifactRefFromRevision } from "../domain/dev-flow-v15";
import type { V15FactContext, V15EvaluationInput, V15CompiledCohortDefinition } from "../decision/stage-machine";
import { err, ok, type CohortId, type CohortKey, type ArtifactId, type ExecutionId, type SessionId, type Result } from "../domain/primitives";
import type { SqlExecutor } from "./sql-executor";
import { loadImplementationCohortSnapshot } from "./load-run-snapshot";
import type { PlanBody } from "../domain/dev-flow-artifacts";
import type { ProvisionExecution } from "../domain/repository-provisioning";

type StageWorker = V15.SpecWorkerRecord | V15.PlanWorkerRecord | V15.BriefWorkerRecord | V15.FinalWorkerRecord | V15.ProvisionWorkerRecord;
interface CohortRow {
  readonly id: CohortId;
  readonly cohort_key: V15.StageCohortKey;
  readonly durable_version: string;
  readonly state: V15.CohortState;
  readonly depends_on: readonly CohortId[];
  readonly frozen_inputs: V15.RepositoryPreparationInputs | V15.SpecAnalysisInputs | V15.PlanningInputs | V15.BriefWritingInputs | V15.FinalIntegrationInputs;
}
interface WorkerRow {
  readonly worker: V15.V15WorkerKey;
  readonly state: V15.WorkerState;
  readonly active_execution_id: ExecutionId | null;
  readonly work: V15.SpecWorkInput | V15.PlanWorkInput | V15.BriefWorkInput | V15.FinalWorkInput | null;
  readonly response: StageWorker["response"];
  readonly interrupted: StageWorker["interrupted"];
}
type StoredArtifact = V15.SpecAnalysisArtifact | V15.PlanArtifact | V15.BuildBriefArtifact | V15.PrSummaryArtifact | V15.RepositoryRefsArtifact;
interface OutputRow {
  readonly collection_key: CohortKey | null;
  readonly output_name: string;
  readonly chain_id: ArtifactId;
  readonly revision: number;
  readonly artifact_type: StoredArtifact["type"];
  readonly acceptance_state: V15.ArtifactState;
  readonly body: StoredArtifact["body"];
  readonly execution_id: ExecutionId;
  readonly session_id: SessionId | null;
}
interface SessionRow {
  readonly id: SessionId;
  readonly execution_id: ExecutionId;
  readonly action_point: "initial" | "revise" | "retry";
  readonly status: string;
}
interface OperationRow {
  readonly id: ExecutionId;
  readonly action_point: "initial" | "retry";
  readonly status: string;
  readonly operation_outcome: ProvisionExecution["outcome"];
}
export interface StageCohortSnapshotError {
  readonly kind: "cohort_not_found" | "invalid_snapshot";
  readonly cohort_id: CohortId;
  readonly detail: string;
}
const executionState = (status: string): V15.SessionState =>
  status === "failed" || status === "interrupted" ? "interrupted" : status === "cancelled" ? "cancelled"
    : status === "complete" ? "finished" : "running";

/** SQL ownership and frozen input columns are the source of each stage record. */
export const loadStageCohortContext = async (tx: SqlExecutor, cohort_id: CohortId, stage: V15.StageKey):
  Promise<Result<V15FactContext, StageCohortSnapshotError>> => {
  if (stage === "implementation") {
    const snapshot = await loadImplementationCohortSnapshot(tx, cohort_id);
    return snapshot.ok ? ok({ stage, cohort: snapshot.value, pr: null }) : snapshot;
  }
  const rows = await tx.query<CohortRow>(
    `SELECT id::text,cohort_key,durable_version::text,state,depends_on,frozen_inputs FROM oakridge.cohort WHERE id=$1`, [cohort_id]);
  const row = rows[0];
  if (!row) return err({ kind: "cohort_not_found", cohort_id, detail: "cohort was not found" });
  const workers = await tx.query<WorkerRow>(
    "SELECT worker,state,active_execution_id,work,response,interrupted FROM oakridge.cohort_worker WHERE cohort_id=$1", [cohort_id]);
  const key = { repository_preparation: "provision", spec_analysis: "spec", planning: "plan", brief_writing: "brief", final_integration: "final_integration" }[stage];
  const worker = workers.find((candidate) => candidate.worker === key);
  if (!worker) return err({ kind: "invalid_snapshot", cohort_id, detail: `missing ${key} owner` });
  const outputs = await tx.query<OutputRow>(
    `SELECT output.collection_key,output.output_name,artifact.chain_id::text,artifact.revision,artifact.artifact_type,
      output.acceptance_state,artifact.body,intent.id AS execution_id,provenance.session_id::text
     FROM oakridge.worker_output output JOIN oakridge.artifact artifact ON artifact.id=output.artifact_id
     JOIN oakridge.artifact_provenance provenance ON provenance.artifact_id=artifact.id
     JOIN oakridge.execution_intent intent ON intent.attempt_id=provenance.attempt_id
     WHERE output.cohort_id=$1 AND output.worker=$2 ORDER BY output.collection_key NULLS FIRST`, [cohort_id, key]);
  const artifact = (output: OutputRow): StoredArtifact => ({
    ...artifactRefFromRevision({ chain_id: output.chain_id, revision: output.revision }),
    type: output.artifact_type, state: output.acceptance_state, body: output.body,
    provenance: { execution_id: output.execution_id, session_id: output.session_id },
  } as StoredArtifact);
  const output = (name: string) => {
    const found = outputs.find((candidate) => candidate.output_name === name);
    return found ? artifact(found) : null;
  };
  const sessions = await tx.query<SessionRow>(
    `SELECT session.id::text,intent.id AS execution_id,intent.action_point,session.status
     FROM oakridge.execution_intent intent JOIN oakridge.session session ON session.id=intent.session_id
     WHERE intent.cohort_id=$1 AND intent.worker=$2 ORDER BY session.created_at`, [cohort_id, key]);
  const owner = { ...worker, sessions: sessions.map((session) => ({
    id: session.id, execution_id: session.execution_id, action_point: session.action_point, state: executionState(session.status),
  })) };
  const base = { id: row.id, key: row.cohort_key, version: Number(row.durable_version), state: row.state, depends_on: row.depends_on };
  switch (stage) {
    case "repository_preparation": {
      const executions = await tx.query<OperationRow>(
        "SELECT id,action_point,status,operation_outcome FROM oakridge.execution_intent WHERE cohort_id=$1 AND worker='provision' ORDER BY created_at", [cohort_id]);
      return ok({ stage, cohort: { ...base, inputs: row.frozen_inputs as V15.RepositoryPreparationInputs,
        provision: { state: worker.state, active_execution_id: worker.active_execution_id,
          response: worker.response as V15.ProvisionResponse | null,
          interrupted: worker.interrupted as V15.ProvisionWorkerRecord["interrupted"],
          outputs: { repository_refs: output("repository_refs") as V15.RepositoryRefsArtifact | null },
          executions: executions.map((execution) => ({ execution_id: execution.id, action_point: execution.action_point,
            state: execution.operation_outcome ? "finished" : executionState(execution.status), outcome: execution.operation_outcome })) } } });
    }
    case "spec_analysis": return ok({ stage, cohort: { ...base, inputs: row.frozen_inputs as V15.SpecAnalysisInputs,
      spec: { ...owner, outputs: { spec_analysis: output("spec_analysis") } } as V15.SpecWorkerRecord } });
    case "planning": return ok({ stage, cohort: { ...base, inputs: row.frozen_inputs as V15.PlanningInputs,
      plan: { ...owner, outputs: { plan: output("plan") } } as V15.PlanWorkerRecord } });
    case "brief_writing": {
      const inputs = row.frozen_inputs as V15.BriefWritingInputs;
      const plans = await tx.query<{ readonly body: PlanBody }>(
        `SELECT artifact.body FROM oakridge.artifact artifact JOIN oakridge.artifact_owner upstream ON upstream.artifact_id=artifact.id
         JOIN oakridge.cohort cohort ON cohort.run_id=upstream.run_id
         WHERE cohort.id=$3 AND artifact.chain_id=$1 AND artifact.revision=$2`, [inputs.plan.id, inputs.plan.version, cohort_id]);
      if (!plans[0]) return err({ kind: "invalid_snapshot", cohort_id, detail: "pinned accepted plan is unavailable" });
      return ok({ stage, accepted_plan: plans[0].body, cohort: { ...base, inputs,
        brief: { ...owner, outputs: { briefs: outputs.map((stored) => ({ cohort_key: stored.collection_key,
          artifact: artifact(stored) })) } } as V15.BriefWorkerRecord } });
    }
    case "final_integration": return ok({ stage, pr: null, reviewed_target: null,
      cohort: { ...base, inputs: row.frozen_inputs as V15.FinalIntegrationInputs,
        final_integration: { ...owner, outputs: { pr_summary: output("pr_summary") } } as V15.FinalWorkerRecord } });
  }
};

/** Operator actions use the same pinned definition and artifact ledger as ingress. */
export const loadStageCohortEvaluation = async (tx: SqlExecutor, context: V15FactContext):
  Promise<Result<Omit<V15EvaluationInput, "request">, StageCohortSnapshotError>> => {
  const rows = await tx.query<{ readonly definition: V15CompiledCohortDefinition }>(
    `SELECT stage.stage_contract->'cohort' AS definition FROM oakridge.cohort cohort
     JOIN oakridge.stage_instance stage ON stage.id=cohort.stage_instance_id WHERE cohort.id=$1`, [context.cohort.id]);
  if (!rows[0]?.definition) return err({ kind: "invalid_snapshot", cohort_id: context.cohort.id,
    detail: "cohort has no pinned decision tree" });
  const artifacts = await tx.query<{ readonly chain_id: ArtifactId; readonly revision: number }>(
    `SELECT artifact.chain_id::text,artifact.revision FROM oakridge.artifact artifact
     JOIN oakridge.artifact_owner owner ON owner.artifact_id=artifact.id
     JOIN oakridge.cohort cohort ON cohort.run_id=owner.run_id WHERE cohort.id=$1`, [context.cohort.id]);
  return ok({ context, definition: rows[0].definition, available_artifacts: artifacts.map(artifactRefFromRevision) });
};
