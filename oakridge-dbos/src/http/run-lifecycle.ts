import { Hono } from "hono";

import { parseUuidId, type WorkflowRunId } from "../domain/primitives";
import type { RunRecordRepository } from "../storage/repositories";

export interface RunLifecycleHttpDependencies { readonly records: Pick<RunRecordRepository, "delete_run"> }

export const createRunLifecycleApp = (dependencies: RunLifecycleHttpDependencies): Hono => {
  const app = new Hono();
  app.delete("/workflow_runs/:id", async (http) => {
    const runId = parseUuidId<WorkflowRunId>(http.req.param("id"));
    if (!runId) return http.body(null, 204);
    const result = await dependencies.records.delete_run(runId);
    if (result.kind === "deleted" || result.kind === "already_deleted") return http.body(null, 204);
    return http.json(result, 409);
  });
  return app;
};
