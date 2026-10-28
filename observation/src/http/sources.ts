import type { Hono } from "hono";
import { decodeCapture } from "../ingest/capture";
import { captureDelivery, deliverSourceEvent, readSourceCursor, readSourceHumanGrades, readSourceRevision, readUnmappedSourceEvents, type CaptureHooks } from "../storage/capture-store";
import { decodeSourceEventDelivery } from "../ingest/cursor";
import type { Database } from "../storage/database";
import { errorResponse } from "./errors";
import { credentialFor, type Credentials } from "./ingest-auth";
import { projectRevision } from "../storage/projection-store";

export interface SourceDependencies { readonly db: Database; readonly credentials: Credentials; readonly captureHooks?: CaptureHooks;
  readonly exportRoot?: string }
export function registerSourceRoutes(app: Hono, deps: SourceDependencies): void {
  app.get("/v1/sources/oakridge/cursor", async (c) => {
    const credential = credentialFor(c.req.header("authorization"), deps.credentials.ingest);
    if (!credential || credential.producer !== "oakridge") return errorResponse(c, 401, "unauthorized", "ingest credential required");
    return c.json(await readSourceCursor(deps.db, credential));
  });
  app.post("/v1/sources/oakridge/events", async (c) => {
    const credential = credentialFor(c.req.header("authorization"), deps.credentials.ingest);
    if (!credential || credential.producer !== "oakridge") return errorResponse(c, 401, "unauthorized", "ingest credential required");
    let input: unknown;
    try { input = await c.req.json(); } catch { return errorResponse(c, 400, "invalid_json", "valid JSON body required"); }
    const delivery = decodeSourceEventDelivery(input);
    if (!delivery) return errorResponse(c, 400, "invalid_event", "valid source event delivery required");
    if (delivery.outcome.kind === "artifact_revision") {
      const decoded = decodeCapture(delivery.outcome.revision, delivery.outcome.event_id);
      if (!decoded.ok) return errorResponse(c, 400, "invalid_capture", decoded.error.detail);
      if (decoded.value.envelope.source.producer !== credential.producer || decoded.value.envelope.source.namespace !== credential.namespace)
        return errorResponse(c, 403, "forbidden", "credential cannot ingest this source");
    }
    const result = await deliverSourceEvent(deps.db, credential, delivery);
    return c.json(result.body, result.status);
  });
  app.get("/v1/sources/oakridge/unmapped", async (c) => {
    const credential = credentialFor(c.req.header("authorization"), deps.credentials.read);
    if (!credential || credential.producer !== "oakridge") return errorResponse(c, 403, "forbidden", "read credential required");
    return c.json({ items: await readUnmappedSourceEvents(deps.db, credential) });
  });
  app.get("/v1/sources/oakridge/human-grades", async (c) => {
    const credential = credentialFor(c.req.header("authorization"), deps.credentials.read);
    if (!credential || credential.producer !== "oakridge") return errorResponse(c, 403, "forbidden", "read credential required");
    return c.json({ items: await readSourceHumanGrades(deps.db, credential) });
  });
  app.post("/v1/sources/oakridge/sync", async (c) => {
    const credential = credentialFor(c.req.header("authorization"), deps.credentials.ingest);
    if (!credential) return errorResponse(c, 401, "unauthorized", "ingest credential required");
    let input: unknown;
    try { input = await c.req.json(); }
    catch { return errorResponse(c, 400, "invalid_json", "valid JSON body required"); }
    const delivery = decodeCapture(input, c.req.header("idempotency-key") ?? null);
    if (!delivery.ok) return errorResponse(c, 400, "invalid_capture", delivery.error.detail);
    const source = delivery.value.envelope.source;
    if (source.producer !== "oakridge" || source.producer !== credential.producer || source.namespace !== credential.namespace)
      return errorResponse(c, 403, "forbidden", "credential cannot ingest this source");
    const result = await captureDelivery(deps.db, delivery.value, deps.captureHooks);
    if (result.status === 201) await projectRevision(deps.db, credential, delivery.value.local_revision_id);
    return c.json(result.body, result.status);
  });
  app.get("/v1/source-revisions/:id", async (c) => {
    const credential = credentialFor(c.req.header("authorization"), deps.credentials.read);
    if (!credential) return errorResponse(c, 403, "forbidden", "read credential required");
    const revision = await readSourceRevision(deps.db, credential, c.req.param("id"));
    if (!revision) return errorResponse(c, 404, "not_found", "source revision not found");
    return c.json(revision);
  });
}
