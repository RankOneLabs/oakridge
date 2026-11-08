import type { Hono } from "hono";
import type { ItemOccurrenceId } from "../domain/identity";
import { readOccurrenceEvidence } from "../storage/captured-evidence-store";
import { readEvidenceSetRecord, readQuestionRecord } from "../storage/grading-record-store";
import { readItemMeasurements, readRunSpend } from "../storage/execution-store";
import { readItem } from "../storage/projection-store";
import { credentialFor } from "./ingest-auth";
import { errorResponse } from "./errors";
import type { SourceDependencies } from "./sources";

export function registerGradingRecordRoutes(app: Hono, deps: SourceDependencies): void {
  app.get("/v1/questions/:id/versions/:version", async (c) => {
    const tenant = credentialFor(c.req.header("authorization"), deps.credentials.read);
    if (!tenant) return errorResponse(c, 403, "forbidden", "read credential required");
    const record = await readQuestionRecord(deps.db, tenant, {
      question_id: c.req.param("id"), question_version: c.req.param("version"),
    });
    return record ? c.json(record) : errorResponse(c, 404, "not_found", "question version not found");
  });
  /** Each question pinned to an item at capture: its version, evaluator set and own readiness. */
  app.get("/v1/items/:id/evidence", async (c) => {
    const tenant = credentialFor(c.req.header("authorization"), deps.credentials.read);
    if (!tenant) return errorResponse(c, 403, "forbidden", "read credential required");
    const item = await readItem(deps.db, tenant, c.req.param("id"));
    if (!item) return errorResponse(c, 404, "not_found", "item not found");
    return c.json({ items: await readOccurrenceEvidence(deps.db, tenant, item.occurrence_id as ItemOccurrenceId) });
  });
  /** Each pinned question's readiness and every pinned machine evaluator's distinct status:
   * not ready, grading off, awaiting admission, pending, budget deferred, failed or answered. */
  app.get("/v1/items/:id/measurements", async (c) => {
    const tenant = credentialFor(c.req.header("authorization"), deps.credentials.read);
    if (!tenant) return errorResponse(c, 403, "forbidden", "read credential required");
    const measurements = await readItemMeasurements(deps.db, tenant, c.req.param("id"));
    return measurements ? c.json(measurements) : errorResponse(c, 404, "not_found", "item not found");
  });
  /** A run's automatic-grading spend in configured estimates, its request count and execution statuses. */
  app.get("/v1/runs/:run_id/grading-spend", async (c) => {
    const tenant = credentialFor(c.req.header("authorization"), deps.credentials.read);
    if (!tenant) return errorResponse(c, 403, "forbidden", "read credential required");
    return c.json(await readRunSpend(deps.db, tenant, c.req.param("run_id")));
  });
  app.get("/v1/evidence-sets/:id", async (c) => {
    const tenant = credentialFor(c.req.header("authorization"), deps.credentials.read);
    if (!tenant) return errorResponse(c, 403, "forbidden", "read credential required");
    const record = await readEvidenceSetRecord(deps.db, tenant, c.req.param("id"));
    return record ? c.json(record) : errorResponse(c, 404, "not_found", "evidence set not found");
  });
}
