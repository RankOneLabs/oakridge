import { Hono } from "hono";

import { parseUuidId, type WorkflowRunId } from "../domain/primitives";
import { cancelV2Run, type CancelV2RunDependencies } from "../runtime/cancel-v2-run";

export interface RerunHttpDependencies {
  readonly v2_cancellation: CancelV2RunDependencies;
}

/** Run cancellation remains under the historical router mount, but is v2-only. */
export const createRerunApp = (dependencies: RerunHttpDependencies): Hono => {
  const app = new Hono();
  app.post("/workflow_runs/:run_id/cancel", async (context) => {
    try {
      const runId = parseUuidId<WorkflowRunId>(context.req.param("run_id"));
      if (!runId) return context.json({ error: "workflow run was not found" }, 404);
      const result = await cancelV2Run(runId, dependencies.v2_cancellation);
      if (result.kind === "run_not_found") return context.json({ error: result.detail }, 404);
      // `run_busy` cancelled nothing: the run kept moving under the attempt. 202
      // would tell the operator their cancellation was accepted, so it is the
      // conflict it is, and asking again is the answer.
      if (result.kind === "run_busy") return context.json({ error: result.detail }, 409);
      return context.json(result, 202);
    } catch (error) {
      return context.json({ error: error instanceof Error ? error.message : "cancellation failed" }, 409);
    }
  });
  return app;
};
