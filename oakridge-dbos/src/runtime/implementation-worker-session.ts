import { parseReviewArtifact } from "../validation/review-artifacts";
import type { GitCommandRunner } from "../domain/repository-provisioning";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { ImplementationCohortInputs, ArtifactRef, PreparedImplementationRepository } from "../domain/dev-flow-v15";
import { selectAssessmentRevisionContext } from "../domain/dev-flow-artifacts";
import type { ArtifactEnvelope, ExecutionRequest, ExecutorAdapter } from "../domain/execution";
import { err, ok, type JsonValue, type UnitId, type WorkOrderId, type WorkflowRunId } from "../domain/primitives";
import type { PromptBundleEntry } from "../domain/workflow";
import type { SqlExecutor } from "../storage/sql-executor";
import type { RunRecordRepository } from "../storage/repositories";
import { renderActionPrompt, type ReferencedActionArtifact } from "./prompt-template";
import type { WorkerSessionIO } from "./run-launch-dispatch";
import type { FinalIntegrationInputs, StageKey, V15WorkerKey, AgentExecutionDefinition, V15RunInputs } from "../domain/dev-flow-v15";

const isJsonObject = (value: JsonValue): value is { readonly [key: string]: JsonValue } =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export interface ImplementationWorkerSessionDependencies {
  readonly sql: SqlExecutor;
  readonly git?: GitCommandRunner;
  readonly discover_final_pr?: (cohort_id: import("../domain/primitives").CohortId) => Promise<import("../domain/primitives").Result<
    import("../domain/dev-flow-v15").VerifiedPrObservation | null, { readonly detail: string }>>;
  readonly records: Pick<RunRecordRepository, "load_work_order_capability_seed">;
  readonly prompt_bundle: (run_id: WorkflowRunId) => Promise<readonly PromptBundleEntry[]>;
  readonly run_context: (run_id: WorkflowRunId) => Promise<JsonValue | null>;
  readonly find_executor: (executor_type: string) => ExecutorAdapter | undefined;
  readonly now: () => string;
}

interface WorkerCohortRow {
  readonly frozen_inputs: ImplementationCohortInputs | FinalIntegrationInputs;
  readonly cohort_key: string;
  readonly stage_key: StageKey;
  readonly stage_contract: { readonly cohort?: { readonly workers: Partial<Record<V15WorkerKey, {
    readonly execution: AgentExecutionDefinition;
    readonly outputs: Readonly<Record<string, { readonly type: string; readonly collection_key?: string }>>;
  }>> } };
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
      if (intent.worker === "provision") return err({ detail: "operation execution cannot create an agent session" });
      const rows = await sql.query<WorkerCohortRow>(
        `SELECT cohort.frozen_inputs,cohort.cohort_key,stage.stage_key,stage.stage_contract FROM oakridge.cohort cohort
         JOIN oakridge.stage_instance stage ON stage.id=cohort.stage_instance_id WHERE cohort.id=$1`, [intent.cohort_id]);
      const cohort = rows[0];
      if (!cohort) return err({ detail: "worker cohort is missing" });
      const context = await runContextOf(intent.run_id);
      if (!context || !isJsonObject(context) || typeof context.oakridge_url !== "string" || !context.oakridge_url)
        return err({ detail: "run publication URL is unavailable" });
      const run = context as unknown as V15RunInputs;
      const final = cohort.stage_key === "final_integration" ? cohort.frozen_inputs as FinalIntegrationInputs : null;
      const implementation = cohort.stage_key === "implementation" ? (cohort.frozen_inputs as ImplementationCohortInputs).repository : null;
      if (implementation && !implementation.worktree_base_sha) return err({ detail: "prepared implementation repository is missing" });
      const finalWorktree = final ? join(final.repository.repository_path, ".worktrees", "oakridge", intent.stage_instance_id, cohort.cohort_key) : null;
      const finalHead = finalWorktree ? await dependencies.git?.run(finalWorktree, ["rev-parse", "HEAD"]) : null;
      if (final && (!finalHead || finalHead.exit_code !== 0)) return err({ detail: "prepared final integration worktree is missing" });
      const repository: PreparedImplementationRepository | null = implementation
        ? implementation as PreparedImplementationRepository : final ? {
          refs: final.repository, canonical_branch: final.repository.base_branch,
          expected_pr_base: final.repository.integration_branch,
          worktree_path: join(final.repository.repository_path, ".worktrees", "oakridge", intent.stage_instance_id, cohort.cohort_key),
          worktree_base_sha: finalHead!.stdout.trim() as PreparedImplementationRepository["worktree_base_sha"],
        } : null;
      if (cohort.stage_key === "implementation" && !repository?.worktree_base_sha)
        return err({ detail: "prepared implementation repository is missing" });
      const bundle = await promptBundleOf(intent.run_id);
      const prompt = bundle.find((entry) => entry.path === intent.prompt);
      if (!prompt) return err({ detail: `pinned prompt ${intent.prompt} is unavailable` });
      const discovered = final && intent.action_point === "retry" ? await dependencies.discover_final_pr?.(intent.cohort_id) : undefined;
      if (final && intent.action_point === "retry" && !discovered) return err({ detail: "final PR discovery is unavailable" });
      if (discovered && !discovered.ok) return discovered;
      const source = intent.resolved_input;
      const refs = new Map<string, ArtifactRef>();
      const collect = (value: JsonValue): void => {
        if (Array.isArray(value)) { for (const member of value) collect(member); return; }
        if (!isJsonObject(value)) return;
        if (typeof value.id === "string" && typeof value.version === "number") {
          refs.set(`${value.id}@${value.version}`, { id: value.id as ArtifactRef["id"], version: value.version }); return;
        }
        for (const member of Object.values(value)) collect(member);
      };
      collect(source);
      const inputs: ArtifactEnvelope[] = [];
      const referenced: ReferencedActionArtifact[] = [];
      for (const ref of refs.values()) {
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
      if (worker.execution.yolo || worker.execution.required_tools.length || worker.execution.pre_authorized_tools.length)
        return err({ detail: "kbbl cannot honor this worker's requested tool authorization settings" });
      const declared_outputs = Object.entries(worker.outputs).map(([name, output]) => ({
        name, artifact_type: output.type, required: true,
        ...(output.collection_key ? { collection_key: output.collection_key } : {}),
      }));
      const collectionPlan = intent.worker === "brief" ? referenced.find((artifact) => artifact.artifact_type === "dev.plan") : null;
      const parsedPlan = collectionPlan ? parseReviewArtifact("dev.plan", collectionPlan.body) : null;
      if (intent.worker === "brief" && (!parsedPlan?.ok || parsedPlan.value?.type !== "dev.plan"))
        return err({ detail: "brief collection is missing its validated accepted plan" });
      const expected_artifacts = declared_outputs.flatMap((output) => output.collection_key && parsedPlan?.ok && parsedPlan.value?.type === "dev.plan"
        ? parsedPlan.value.body.cohorts.map((cohort) => ({ unit_id: cohort.id as UnitId, output_name: output.name, artifact_type: output.artifact_type }))
        : [{ unit_id: cohort.cohort_key as UnitId, output_name: output.name, artifact_type: output.artifact_type }]);
      const adapter = findExecutorAdapter("delegated_session");
      if (!adapter) return err({ detail: "delegated session integration is unavailable" });
      const base_url = context.oakridge_url;
      const discussion = intent.worker === "assessment" && isJsonObject(source)
        ? intent.action_point === "discuss" ? source
          : intent.action_point === "retry" && isJsonObject(source.work) && source.work.action_point === "discuss"
            && isJsonObject(source.work.input) ? source.work.input : null
        : null;
      const unchanged = discussion && isJsonObject(discussion.current_assessment) && isJsonObject(discussion.accepted_build)
        ? { assessment: discussion.current_assessment, build: discussion.accepted_build } : null;
      const { capabilityFor } = await import("./publication-capability");
      const request: ExecutionRequest = {
        execution_id: intent.execution_id, stage_instance_id: intent.stage_instance_id, unit_id: cohort.cohort_key as UnitId,
        executor_type: "delegated_session", inputs, declared_outputs,
        expected_artifacts,
        resolved_config: { ...intent.settings, session_name: intent.execution_id,
          workdir: repository?.worktree_path ?? run.repositories[0]?.path,
          pre_authorized_tools: worker.execution.pre_authorized_tools,
          required_tools: worker.execution.required_tools, yolo: worker.execution.yolo,
          rendered_prompt: renderActionPrompt({ template: prompt.content,
            fields: { ...(source as Readonly<Record<string, JsonValue>>),
              ...(discovered?.ok ? { existing_pull_request: discovered.value as unknown as JsonValue } : {}) }, artifacts: referenced,
            execution: { worker: intent.worker, action_point: intent.action_point, cohort_id: intent.cohort_id },
            repository }),
          publication: { base_url, work_order_id: intent.attempt_id,
            capability: capabilityFor(await runRecords.load_work_order_capability_seed(), intent.attempt_id as WorkOrderId) },
          ...(unchanged ? { assessment_unchanged: unchanged } : {}),
          session_identity: { run_id: intent.run_id, stage_instance_id: intent.stage_instance_id, unit_id: cohort.cohort_key,
            cohort_id: intent.cohort_id, operator_role: intent.worker, cohort_title: null,
            repository_key: repository?.refs.repository_key ?? null },
        },
      };
      const { executorOperationIdForWorkOrder } = await import("../domain/primitives");
      const started = await adapter.start_or_attach(request, executorOperationIdForWorkOrder(intent.attempt_id as WorkOrderId));
      if (started.kind === "executor_unavailable") throw new Error(started.detail);
      if (started.kind !== "kbbl_session") return err({ detail: "integration did not create an agent session" });
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
