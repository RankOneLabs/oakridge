import { randomUUID } from "node:crypto";
import type { ImplementationCohortDefinition, ImplementationCohortInputs, ArtifactRef, PreparedImplementationRepository } from "../domain/dev-flow-v15";
import { selectAssessmentRevisionContext } from "../domain/dev-flow-artifacts";
import type { ArtifactEnvelope, ExecutionRequest, ExecutorAdapter } from "../domain/execution";
import { err, ok, type JsonValue, type UnitId, type WorkOrderId, type WorkflowRunId } from "../domain/primitives";
import type { PromptBundleEntry } from "../domain/workflow";
import type { SqlExecutor } from "../storage/sql-executor";
import type { RunRecordRepository } from "../storage/repositories";
import { renderActionPrompt, type ReferencedActionArtifact } from "./prompt-template";
import type { WorkerSessionIO } from "./run-launch-dispatch";

const isJsonObject = (value: JsonValue): value is { readonly [key: string]: JsonValue } =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export interface ImplementationWorkerSessionDependencies {
  readonly sql: SqlExecutor;
  readonly records: Pick<RunRecordRepository, "load_work_order_capability_seed">;
  readonly prompt_bundle: (run_id: WorkflowRunId) => Promise<readonly PromptBundleEntry[]>;
  readonly run_context: (run_id: WorkflowRunId) => Promise<JsonValue | null>;
  readonly find_executor: (executor_type: string) => ExecutorAdapter | undefined;
  readonly now: () => string;
}

interface WorkerCohortRow {
  readonly frozen_inputs: ImplementationCohortInputs;
  readonly cohort_key: string;
  readonly stage_contract: { readonly cohort?: ImplementationCohortDefinition };
}
interface PinnedActionArtifactRow {
  readonly id: string;
  readonly artifact_type: string;
  readonly body: JsonValue;
}

/** The application session boundary: resolve pinned inputs, render, then attach through kbbl. */
export const createImplementationWorkerSessionIO = (dependencies: ImplementationWorkerSessionDependencies): WorkerSessionIO => {
  const { sql, records: runRecords, prompt_bundle: promptBundleOf, run_context: runContextOf,
    find_executor: findExecutorAdapter, now } = dependencies;
  return {
    now,
    create_session: async (intent) => {
      const rows = await sql.query<WorkerCohortRow>(
        `SELECT cohort.frozen_inputs,cohort.cohort_key,stage.stage_contract FROM oakridge.cohort cohort
         JOIN oakridge.stage_instance stage ON stage.id=cohort.stage_instance_id WHERE cohort.id=$1`, [intent.cohort_id]);
      const cohort = rows[0];
      const repository = cohort?.frozen_inputs.repository;
      if (!repository?.worktree_base_sha)
        return err({ detail: "prepared implementation repository is missing" });
      const bundle = await promptBundleOf(intent.run_id);
      const prompt = bundle.find((entry) => entry.template_path === intent.prompt);
      if (!prompt) return err({ detail: `pinned prompt ${intent.prompt} is unavailable` });
      const source = intent.resolved_input;
      const refs: ArtifactRef[] = [];
      const collect = (value: JsonValue): void => {
        if (Array.isArray(value)) { for (const member of value) collect(member); return; }
        if (!isJsonObject(value)) return;
        if (typeof value.id === "string" && typeof value.version === "number") {
          refs.push({ id: value.id as ArtifactRef["id"], version: value.version }); return;
        }
        for (const member of Object.values(value)) collect(member);
      };
      collect(source);
      const inputs: ArtifactEnvelope[] = [];
      const referenced: ReferencedActionArtifact[] = [];
      for (const ref of refs) {
        const artifacts = await sql.query<PinnedActionArtifactRow>(
          `SELECT artifact.id::text,artifact.artifact_type,artifact.body FROM oakridge.artifact artifact
           JOIN oakridge.artifact_owner owner ON owner.artifact_id=artifact.id
           WHERE artifact.chain_id=$1 AND artifact.revision=$2 AND owner.run_id=$3`, [ref.id, ref.version, intent.run_id]);
        const artifact = artifacts[0];
        if (!artifact) return err({ detail: `pinned input ${ref.id}@${ref.version} is unavailable` });
        inputs.push({ artifact_id: artifact.id as ArtifactEnvelope["artifact_id"], artifact_type: artifact.artifact_type,
          output_name: artifact.artifact_type, unit_id: cohort.cohort_key as UnitId, body: artifact.body, chain_id: ref.id });
        const revision_context = selectAssessmentRevisionContext(artifact.artifact_type, artifact.body);
        referenced.push({ ref, artifact_type: artifact.artifact_type, body: artifact.body,
          ...(revision_context ? { revision_context: revision_context as unknown as JsonValue } : {}) });
      }
      const worker = cohort.stage_contract.cohort?.workers[intent.worker];
      if (!worker) return err({ detail: "implementation worker output contract is missing" });
      const declared_outputs = Object.entries(worker.outputs).map(([name, output]) => ({
        name, artifact_type: output.type, required: true,
      }));
      const adapter = findExecutorAdapter("delegated_session");
      if (!adapter) return err({ detail: "delegated session integration is unavailable" });
      const context = await runContextOf(intent.run_id);
      if (!context || !isJsonObject(context) || typeof context.oakridge_url !== "string" || !context.oakridge_url)
        return err({ detail: "run publication URL is unavailable" });
      const base_url = context.oakridge_url;
      const discussion = intent.worker === "assessment" && isJsonObject(source)
        ? intent.action_point === "discuss" ? source
          : intent.action_point === "retry" && isJsonObject(source.work) && source.work.action_point === "discuss"
            && isJsonObject(source.work.input) ? source.work.input : null
        : null;
      const unchanged = discussion && isJsonObject(discussion.current_assessment) && isJsonObject(discussion.accepted_build)
        ? { assessment: discussion.current_assessment, build: discussion.accepted_build } : null;
      const { capabilityFor } = await import("./resolve-work-order");
      const request: ExecutionRequest = {
        execution_id: intent.execution_id, stage_instance_id: intent.stage_instance_id, unit_id: cohort.cohort_key as UnitId,
        executor_type: "delegated_session", inputs, declared_outputs,
        expected_artifacts: declared_outputs.map((output) => ({ unit_id: cohort.cohort_key as UnitId,
          output_name: output.name, artifact_type: output.artifact_type })),
        resolved_config: { ...intent.settings, session_name: intent.execution_id, workdir: repository.worktree_path,
          rendered_prompt: renderActionPrompt({ template: prompt.content,
            fields: source as Readonly<Record<string, JsonValue>>, artifacts: referenced,
            execution: { worker: intent.worker, action_point: intent.action_point, cohort_id: intent.cohort_id },
            repository: repository as PreparedImplementationRepository }),
          publication: { base_url, work_order_id: intent.attempt_id,
            capability: capabilityFor(await runRecords.load_work_order_capability_seed(), intent.attempt_id as WorkOrderId) },
          ...(unchanged ? { assessment_unchanged: unchanged } : {}),
          session_identity: { run_id: intent.run_id, stage_instance_id: intent.stage_instance_id, unit_id: cohort.cohort_key,
            cohort_id: intent.cohort_id, operator_role: intent.worker, cohort_title: null,
            repository_key: repository.refs.repository_key },
        },
      };
      const { executorOperationIdForWorkOrder } = await import("../domain/primitives");
      const started = await adapter.start_or_attach(request, executorOperationIdForWorkOrder(intent.attempt_id as WorkOrderId));
      if (started.kind !== "kbbl_session") return err({ detail: started.kind === "executor_unavailable" ? started.detail : "integration did not create an agent session" });
      return ok({ execution_id: intent.execution_id, session_id: randomUUID() as import("../domain/primitives").SessionId,
        kbbl_session_id: started.session_id });
    },
    stop_session: async (session) => {
      const adapter = findExecutorAdapter("delegated_session");
      if (!adapter) return err({ detail: "delegated session integration is unavailable" });
      const stopped = await adapter.cancel_or_fence(session.execution_id,
        { kind: "kbbl_session", session_id: session.kbbl_session_id });
      return stopped?.kind === "executor_unavailable" ? err({ detail: stopped.detail }) : ok(undefined);
    },
  };
};
