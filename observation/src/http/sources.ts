import type { Hono } from "hono";
import { decodeCapture } from "../ingest/capture";
import { decodeSourceEventDelivery } from "../ingest/cursor";
import type { ProducerProfile } from "../ports/producer-profile";
import { NO_CAPTURE_PINS, type CaptureConfiguration } from "../grading/evidence";
import { deliverSourceEvent, readSourceCursor, readSourceRevision, readUnmappedSourceEvents } from "../storage/capture-store";
import type { Database } from "../storage/database";
import type { EvidenceReconciler } from "../storage/evidence-pipeline";
import { errorResponse } from "./errors";
import { credentialFor, type Credentials } from "./ingest-auth";

export interface SourceDependencies {
  readonly db: Database;
  readonly credentials: Credentials;
  readonly profile: ProducerProfile;
  /** Absent until a configuration is composed: occurrences are captured with no pins. */
  readonly capture_configuration?: CaptureConfiguration;
  /** Reconciles a run after each accepted event: collects its waiting questions and admits ready
   * ones if its grading is on. Absent means neither. */
  readonly evidence?: EvidenceReconciler;
}

/** The one ordered source feed, served under the injected producer's name. */
export function registerSourceRoutes(app: Hono, deps: SourceDependencies): void {
  const { producer, extraction } = deps.profile;
  const context = { extraction, configuration: deps.capture_configuration ?? NO_CAPTURE_PINS };
  app.get(`/v1/sources/${producer}/cursor`, async (c) => {
    const credential = credentialFor(c.req.header("authorization"), deps.credentials.ingest);
    if (!credential || credential.producer !== producer) return errorResponse(c, 401, "unauthorized", "ingest credential required");
    return c.json(await readSourceCursor(deps.db, credential));
  });
  app.post(`/v1/sources/${producer}/events`, async (c) => {
    const credential = credentialFor(c.req.header("authorization"), deps.credentials.ingest);
    if (!credential || credential.producer !== producer) return errorResponse(c, 401, "unauthorized", "ingest credential required");
    let input: unknown;
    try { input = await c.req.json(); } catch { return errorResponse(c, 400, "invalid_json", "valid JSON body required"); }
    const delivery = decodeSourceEventDelivery(input);
    if (!delivery) return errorResponse(c, 400, "invalid_event", "valid source event delivery required");
    if (delivery.outcome.kind === "artifact_revision") {
      const decoded = decodeCapture(delivery.outcome.revision);
      if (!decoded.ok) return errorResponse(c, 400, "invalid_capture", decoded.error.detail);
      if (decoded.value.envelope.source.producer !== credential.producer || decoded.value.envelope.source.namespace !== credential.namespace)
        return errorResponse(c, 403, "forbidden", "credential cannot ingest this source");
    }
    const result = await deliverSourceEvent(deps.db, credential, delivery, context);
    // Reconciliation reads repositories, so the acknowledgement does not wait for it; a failed pass
    // leaves its questions waiting for the next event, sweep or restart.
    if (result.status === 200) deps.evidence?.reconcileRun(credential, delivery.outcome.run_id)
      .catch((error: unknown) => console.error("[observation] reconciliation failed", { run_id: delivery.outcome.run_id, error }));
    return c.json(result.body, result.status);
  });
  app.get(`/v1/sources/${producer}/unmapped`, async (c) => {
    const credential = credentialFor(c.req.header("authorization"), deps.credentials.read);
    if (!credential || credential.producer !== producer) return errorResponse(c, 403, "forbidden", "read credential required");
    return c.json({ items: await readUnmappedSourceEvents(deps.db, credential) });
  });
  app.get("/v1/source-revisions/:id", async (c) => {
    const credential = credentialFor(c.req.header("authorization"), deps.credentials.read);
    if (!credential) return errorResponse(c, 403, "forbidden", "read credential required");
    const revision = await readSourceRevision(deps.db, credential, c.req.param("id"));
    if (!revision) return errorResponse(c, 404, "not_found", "source revision not found");
    return c.json(revision);
  });
}
