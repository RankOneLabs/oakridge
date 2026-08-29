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
      return result.kind === "run_not_found" ? context.json({ error: result.detail }, 404) : context.json(result, 202);
    } catch (error) {
      return context.json({ error: error instanceof Error ? error.message : "cancellation failed" }, 409);
    }
  });
  return app;
};
