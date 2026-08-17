import { Hono } from "hono";
import type { WorkflowRunId } from "../domain/primitives";
import type { OperatorProjectionRepository } from "../storage/postgres-operators";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const parseRunId = (raw: string): WorkflowRunId | null => UUID.test(raw) ? raw as WorkflowRunId : null;

export const createOperatorProjectionApp = (projections: OperatorProjectionRepository): Hono => {
  const app = new Hono();
  app.get("/gates", async (http) => http.json(await projections.list_pending_gates()));
  app.get("/runs", async (http) => {
    const requested = http.req.query("filter");
    const filter = requested === "all" || requested === "archived" ? requested : "active";
    return http.json(await projections.list_runs(filter));
  });
  app.get("/runs/:id", async (http) => {
    // The summary query binds this as $3::uuid, so a malformed id reaches
    // Postgres as a cast error and surfaces as a 500. A run id that cannot
    // exist is a 404 like any other.
    const id = parseRunId(http.req.param("id"));
    if (!id) return http.json({ error: "run not found" }, 404);
    const run = await projections.get_run(id);
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
