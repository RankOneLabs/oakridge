import { createHash } from "node:crypto";

import { stageRerunStateKey, type StageRerunState } from "../domain/rerun";
import type { RetryStuckRequest, RetryStuckResult } from "../domain/runs";
import type { StageInstanceRepository, RerunTargetRepository } from "../storage/repositories";
import { describeStageRerunError, isMissingStageRerunTarget, rerunStage, type StageRerunDependencies } from "./stage-rerun";
import { rerunUnit, type RerunDbosClient } from "./unit-rerun";

export interface RetryStuckDependencies {
  readonly stages: StageInstanceRepository;
  readonly targets: RerunTargetRepository;
  readonly dbos: RerunDbosClient;
  readonly stage_rerun: StageRerunDependencies;
}

const commandIdentity = (parts: readonly string[]): string => createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 32);
const failure = (request: RetryStuckRequest, kind: "stage_not_found" | "unit_not_found" | "not_stuck" | "active_conflict", detail: string): RetryStuckResult =>
  ({ kind, stage_instance_id: request.stage_instance_id, unit_id: request.unit_id, detail });

export const retryStuck = async (request: RetryStuckRequest, dependencies: RetryStuckDependencies): Promise<RetryStuckResult> => {
  const stage = await dependencies.stages.find_by_id(request.stage_instance_id);
  if (!stage) return failure(request, "stage_not_found", `stage instance '${request.stage_instance_id}' was not found`);

  if (request.unit_id) {
    const target = await dependencies.targets.find_unit_target(request.stage_instance_id, request.unit_id);
    if (!target) return failure(request, "unit_not_found", `execution unit '${request.stage_instance_id}:${request.unit_id}' was not found`);
    const state = await dependencies.dbos.getEvent<StageRerunState>(target.stage_coordinator_workflow_id, stageRerunStateKey(request.unit_id), { timeoutSeconds: 0 });
    if (state?.status === "resumed" && state.replacement_execution_workflow_id === target.execution_workflow_id) {
      return { kind: "already_accepted", stage_instance_id: request.stage_instance_id, unit_id: request.unit_id };
    }
    if (!state || state.status !== "waiting" || state.failed_execution_workflow_id !== target.execution_workflow_id) {
      return failure(request, "not_stuck", `execution unit '${request.stage_instance_id}:${request.unit_id}' is not waiting for rerun`);
    }
    const rerunId = commandIdentity([request.stage_instance_id, request.unit_id, state.failed_execution_workflow_id]);
    try {
      await rerunUnit({ stage_instance_id: request.stage_instance_id, unit_id: request.unit_id, rerun_id: rerunId }, dependencies.targets, dependencies.dbos);
      return { kind: "accepted_unit", stage_instance_id: request.stage_instance_id, unit_id: request.unit_id };
    } catch (error) {
      return failure(request, "active_conflict", error instanceof Error ? error.message : "unit rerun conflicted");
    }
  }

  if (stage.lifecycle.kind !== "finished" || stage.lifecycle.outcome.kind !== "failed") {
    return failure(request, "not_stuck", `stage instance '${request.stage_instance_id}' is not terminal with a failed outcome`);
  }
  const rerunId = commandIdentity([request.stage_instance_id, stage.run_id, stage.stage_key]);
  const rerun = await rerunStage({ run_id: stage.run_id, stage_key: stage.stage_key, rerun_id: rerunId }, dependencies.stage_rerun);
  if (rerun.ok) return { kind: "accepted_stage", stage_instance_id: request.stage_instance_id, unit_id: null };
  return failure(request, isMissingStageRerunTarget(rerun.error) ? "not_stuck" : "active_conflict", describeStageRerunError(rerun.error));
};
