import { Hono } from "hono";
import { z } from "zod";

import { parseUuidId, type StageInstanceId, type UnitId } from "../domain/primitives";
import type { RerunDbosClient } from "../runtime/unit-rerun";
import { rerunUnit } from "../runtime/unit-rerun";
import type { RerunTargetRepository, StageInstanceRepository } from "../storage/repositories";
import { describeStageRerunError, isMissingStageRerunTarget, rerunStage, type StageRerunDependencies } from "../runtime/stage-rerun";
import type { WorkflowRunId } from "../domain/primitives";
import { cancelRun, type CancelRunDependencies } from "../runtime/cancel-run";
import { retryStuck } from "../runtime/retry-stuck";
import { cancelV2Run, type CancelV2RunDependencies } from "../runtime/cancel-v2-run";

export interface RerunHttpDependencies { readonly stages: StageInstanceRepository; readonly targets: RerunTargetRepository; readonly dbos: RerunDbosClient; readonly stage_rerun: StageRerunDependencies; readonly cancellation: CancelRunDependencies; readonly v2_cancellation?: CancelV2RunDependencies }
const bodySchema = z.object({ rerun_id: z.string().min(1), application_version: z.string().min(1).optional() });

export const createRerunApp = (dependencies: RerunHttpDependencies): Hono => {
  const app = new Hono();
  app.post("/stage_instances/:stage_instance_id/retry_stuck", async (context) => {
    const parsed = z.object({ unit_id: z.string().min(1).nullable().optional() }).safeParse(await context.req.json().catch(() => ({})));
    if (!parsed.success) return context.json({ error: "unit_id must be a non-empty string or null" }, 400);
    const stageInstanceId = parseUuidId<StageInstanceId>(context.req.param("stage_instance_id"));
    if (!stageInstanceId) return context.json({ error: "stage instance was not found" }, 404);
    const result = await retryStuck({ stage_instance_id: stageInstanceId,
      unit_id: (parsed.data.unit_id ?? null) as UnitId | null }, dependencies);
    if (result.kind === "stage_not_found" || result.kind === "unit_not_found") return context.json(result, 404);
    if (result.kind === "not_stuck" || result.kind === "active_conflict") return context.json(result, 409);
    return context.json(result, 202);
  });
  app.post("/stage_instances/:stage_instance_id/units/:unit_id/rerun", async (context) => {
    const parsed = bodySchema.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) return context.json({ error: "invalid rerun request" }, 400);
    try {
      const stageInstanceId = parseUuidId<StageInstanceId>(context.req.param("stage_instance_id"));
      if (!stageInstanceId) return context.json({ error: "execution unit was not found" }, 404);
      const result = await rerunUnit({ stage_instance_id: stageInstanceId,
        unit_id: context.req.param("unit_id") as UnitId, ...parsed.data }, dependencies.targets, dependencies.dbos);
      return context.json(result, 202);
    } catch (error) {
      return context.json({ error: error instanceof Error ? error.message : "rerun failed" }, 409);
    }
  });
  app.post("/workflow_runs/:run_id/stages/:stage_key/rerun", async (context) => {
    const parsed = bodySchema.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) return context.json({ error: "invalid rerun request" }, 400);
    const runId = parseUuidId<WorkflowRunId>(context.req.param("run_id"));
    if (!runId) return context.json({ error: "workflow run was not found" }, 404);
    const result = await rerunStage({ run_id: runId,
      stage_key: context.req.param("stage_key"), ...parsed.data }, dependencies.stage_rerun);
    if (result.ok) return context.json(result.value, 202);
    return context.json({ error: describeStageRerunError(result.error), code: result.error.kind },
      isMissingStageRerunTarget(result.error) ? 404 : 409);
  });
  app.post("/workflow_runs/:run_id/cancel", async (context) => {
    try {
      const runId = parseUuidId<WorkflowRunId>(context.req.param("run_id"));
      if (!runId) return context.json({ error: "workflow run was not found" }, 404);
      return context.json(dependencies.v2_cancellation
        ? await cancelV2Run(runId, dependencies.v2_cancellation)
        : await cancelRun(runId, dependencies.cancellation), 202);
    } catch (error) {
      return context.json({ error: error instanceof Error ? error.message : "cancellation failed" }, 409);
    }
  });
  return app;
};
