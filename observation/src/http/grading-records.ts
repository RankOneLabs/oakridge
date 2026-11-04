import type { Hono } from "hono";
import { readCriterionComposite, readEvidenceSetRecord, readQuestionRecord } from "../storage/grading-record-store";
import { credentialFor } from "./ingest-auth";
import { errorResponse } from "./errors";
import type { SourceDependencies } from "./sources";

export function registerGradingRecordRoutes(app: Hono, deps: SourceDependencies): void {
  app.get("/v1/items/:id/criterion-composite/v1", async (c) => {
    const tenant = credentialFor(c.req.header("authorization"), deps.credentials.read);
    if (!tenant) return errorResponse(c, 403, "forbidden", "read credential required");
    const raw = new URL(c.req.url).searchParams.get("as_of");
    const as_of = raw ? new Date(raw) : new Date();
    if (!Number.isFinite(as_of.getTime())) return errorResponse(c, 400, "invalid_selection", "as_of must be an ISO timestamp");
    const composite = await readCriterionComposite(deps.db, tenant, { occurrence_id: c.req.param("id"), as_of });
    return composite ? c.json(composite) : errorResponse(c, 404, "not_found", "criterion not found in as-of scope");
  });
  app.get("/v1/questions/:id/versions/:version", async (c) => {
    const tenant = credentialFor(c.req.header("authorization"), deps.credentials.read);
    if (!tenant) return errorResponse(c, 403, "forbidden", "read credential required");
    const record = await readQuestionRecord(deps.db, tenant, {
      question_id: c.req.param("id"), question_version: c.req.param("version"),
    });
    return record ? c.json(record) : errorResponse(c, 404, "not_found", "question version not found");
  });
  app.get("/v1/evidence-sets/:id", async (c) => {
    const tenant = credentialFor(c.req.header("authorization"), deps.credentials.read);
    if (!tenant) return errorResponse(c, 403, "forbidden", "read credential required");
    const record = await readEvidenceSetRecord(deps.db, tenant, c.req.param("id"));
    return record ? c.json(record) : errorResponse(c, 404, "not_found", "evidence set not found");
  });
}
