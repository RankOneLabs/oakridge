import { Hono } from "hono";

import type { WorkflowRunId } from "../domain/primitives";
import type { WorkflowRunRepository } from "../storage/repositories";

export interface RunLifecycleHttpDependencies { readonly runs: WorkflowRunRepository }

export const createRunLifecycleApp = (dependencies: RunLifecycleHttpDependencies): Hono => {
  const app = new Hono();
  app.delete("/workflow_runs/:id", async (http) => {
    const result = await dependencies.runs.delete_terminal(http.req.param("id") as WorkflowRunId);
    if (result.kind === "deleted" || result.kind === "already_deleted") return http.body(null, 204);
    return http.json(result, 409);
  });
  return app;
};
