import type { RunStageSource } from "../grading/task-stages";
import type { Hono } from "hono";
import { decodeCapture } from "../ingest/capture";
import { decodeSourceEventDelivery, type SourceEventOutcome } from "../ingest/cursor";
import type { ProducerProfile } from "../ports/producer-profile";
import { NO_CAPTURE_PINS, type CaptureConfiguration } from "../grading/evidence";
import { deliverSourceEvent, readSourceCursor, readSourceRevision, readUnmappedSourceEvents } from "../storage/capture-store";
import type { Database } from "../storage/database";
import type { EvidenceReconciler } from "../storage/evidence-pipeline";
import { errorResponse } from "./errors";
import { credentialFor, type Credentials } from "./ingest-auth";
import { pagination } from "./items";

export interface SourceDependencies {
  readonly db: Database;
  readonly stage_source?: RunStageSource;
  readonly credentials: Credentials;
  readonly profile: ProducerProfile;
  /** Absent until a configuration is composed: occurrences are captured with no pins. */
  readonly capture_configuration?: CaptureConfiguration;
  /** Reconciles a run after each accepted revision or launch: collects its waiting questions and
   * admits ready ones if its grading is on. Absent means neither. */
  readonly evidence?: EvidenceReconciler;
}

/** Whether an accepted event can change what a run has ready: a captured revision adds items or the
 * inputs they cite, and a run input supplies what its questions read. Ignored and unmapped events
 * never start a pass, so they can never cause an admission; the periodic sweep and restart still
 * revisit every waiting run. */
export const startsReconciliation = (outcome: SourceEventOutcome): boolean =>
  outcome.kind === "artifact_revision" || outcome.kind === "run_input";

/** The one ordered source feed, served under the injected producer's name. */
export function registerSourceRoutes(app: Hono, deps: SourceDependencies): void {
  const { producer } = deps.profile;
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
    const result = await deliverSourceEvent(deps.db, credential, delivery, { extraction: deps.profile.extraction, configuration: deps.capture_configuration ?? NO_CAPTURE_PINS });
    // Reconciliation reads repositories, so the acknowledgement does not wait for it; a failed pass
    // leaves its questions waiting for the next event, sweep or restart.
    if (result.status === 200 && startsReconciliation(delivery.outcome)) deps.evidence?.reconcileRun(credential, delivery.outcome.run_id)
      .catch((error: unknown) => console.error("[observation] reconciliation failed", { run_id: delivery.outcome.run_id, error }));
    return c.json(result.body, result.status);
  });
  app.get(`/v1/sources/${producer}/unmapped`, async (c) => {
    const credential = credentialFor(c.req.header("authorization"), deps.credentials.read);
    if (!credential || credential.producer !== producer) return errorResponse(c, 403, "forbidden", "read credential required");
    const page = pagination(c.req.url);
    if (!page) return errorResponse(c, 400, "invalid_pagination", "limit must be 1..200 and offset nonnegative");
    return c.json(await readUnmappedSourceEvents(deps.db, credential, page));
  });
  app.get("/v1/source-revisions/:id", async (c) => {
    const credential = credentialFor(c.req.header("authorization"), deps.credentials.read);
    if (!credential) return errorResponse(c, 403, "forbidden", "read credential required");
    const revision = await readSourceRevision(deps.db, credential, c.req.param("id"));
    if (!revision) return errorResponse(c, 404, "not_found", "source revision not found");
    return c.json(revision);
  });
}
