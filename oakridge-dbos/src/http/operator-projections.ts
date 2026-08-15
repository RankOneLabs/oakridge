import { Hono } from "hono";
import type { WorkflowRunId } from "../domain/primitives";
import type { OperatorProjectionRepository } from "../storage/postgres-operators";

export const createOperatorProjectionApp = (projections: OperatorProjectionRepository): Hono => {
  const app = new Hono();
  app.get("/gates", async (http) => http.json(await projections.list_pending_gates()));
  app.get("/runs", async (http) => {
    const requested = http.req.query("filter");
    const filter = requested === "all" || requested === "archived" ? requested : "active";
    return http.json(await projections.list_runs(filter));
  });
  app.get("/runs/:id", async (http) => {
    const run = await projections.get_run(http.req.param("id") as WorkflowRunId);
    return run ? http.json(run) : http.json({ error: "run not found" }, 404);
  });
  app.get("/review_inbox", async (http) => http.json(await projections.get_review_inbox()));
  app.get("/application_versions", async (http) => http.json(await projections.list_application_versions()));
  app.get("/runs/:id/gates", async (http) => http.json(await projections.list_pending_gates(http.req.param("id") as WorkflowRunId)));
  app.post("/workflow_runs/:id/archive", async (http) => {
    const updated = await projections.set_run_archived(http.req.param("id") as WorkflowRunId, true);
    return updated ? http.body(null, 204) : http.json({ error: "run not found" }, 404);
  });
  app.post("/workflow_runs/:id/unarchive", async (http) => {
    const updated = await projections.set_run_archived(http.req.param("id") as WorkflowRunId, false);
    return updated ? http.body(null, 204) : http.json({ error: "run not found" }, 404);
  });
  return app;
};
