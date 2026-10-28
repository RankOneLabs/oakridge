import type { Hono } from "hono";
import { decodeCapture } from "../ingest/capture";
import { captureDelivery, readSourceRevision, type CaptureHooks } from "../storage/capture-store";
import type { Database } from "../storage/database";
import { errorResponse } from "./errors";
import { credentialFor, type Credentials } from "./ingest-auth";

export interface SourceDependencies { readonly db: Database; readonly credentials: Credentials; readonly captureHooks?: CaptureHooks }
export function registerSourceRoutes(app: Hono, deps: SourceDependencies): void {
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
