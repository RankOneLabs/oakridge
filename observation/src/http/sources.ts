import type { Hono } from "hono";
import { decodeCapture } from "../ingest/capture";
import { captureDelivery, deliverSourceEvent, readSourceCursor, readSourceEventIssues, readSourceHumanGrades, readSourceRevision,
  readUnmappedSourceEvents, reconcileSourceEventIssuesInTransaction, resolveRunMismatchIssue,
  type CaptureHooks } from "../storage/capture-store";
import { decodeSourceEventDelivery } from "../ingest/cursor";
import type { Database } from "../storage/database";
import { errorResponse } from "./errors";
import { boundReviewer, credentialFor, type Credentials } from "./ingest-auth";
import { projectRevision } from "../storage/projection-store";
import { sql } from "kysely";
import { withTenant } from "../storage/database";
import { handleOperatorEvent, type OperatorEventDelivery } from "../purge/trigger";
import { deliverBackfill, readBackfillCheckpoint, type BackfillDelivery, type BackfillPosition } from "../storage/backfill-store";
import type { GradingLimits } from "../grading/jobs/budget";

export interface SourceDependencies { readonly db: Database; readonly credentials: Credentials; readonly captureHooks?: CaptureHooks;
  readonly exportRoot?: string; readonly gradingLimits?: GradingLimits }
interface OperatorCursor { readonly commit_txid: string; readonly id: string }
interface OperatorDelivery { readonly previous: OperatorCursor; readonly cursor: OperatorCursor; readonly event: OperatorEventDelivery }
const isRecord = (value: unknown): value is { readonly [key: string]: unknown } =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isCursor = (value: unknown): value is OperatorCursor => isRecord(value)
  && typeof value.commit_txid === "string" && /^(0|[1-9][0-9]*)$/.test(value.commit_txid)
  && typeof value.id === "string";
function decodeOperatorDelivery(value: unknown): OperatorDelivery | null {
  if (!isRecord(value) || !isCursor(value.previous) || !isCursor(value.cursor) || !isRecord(value.event)) return null;
  const event = value.event;
  if (typeof event.id !== "string" || event.id !== value.cursor.id || typeof event.run_key !== "string"
    || !isRecord(event.payload) || typeof event.payload.kind !== "string"
    || typeof event.run_exists !== "boolean" || typeof event.operator_override !== "boolean") return null;
  if (event.payload.kind === "invalidate" && (!isRecord(event.payload.data)
    || typeof event.payload.data.target !== "string"
    || !(typeof event.payload.data.run_id === "string" || event.payload.data.run_id === null))) return null;
  return value as unknown as OperatorDelivery;
}
function isBackfillPosition(value: unknown): value is BackfillPosition {
  if (!isRecord(value)) return false;
  if (value.source === "done") return true;
  return (value.source === "review_decision" || value.source === "collaboration_thread")
    && typeof value.created_at === "string" && !Number.isNaN(Date.parse(value.created_at)) && typeof value.id === "string";
}
function decodeBackfillDelivery(value: unknown): BackfillDelivery | null {
  if (!isRecord(value) || !isBackfillPosition(value.previous) || !isBackfillPosition(value.position)
    || !isRecord(value.counts)) return null;
  if (value.replay !== undefined && typeof value.replay !== "boolean") return null;
  for (const source of ["review_decision", "collaboration_thread"]) {
    const counts = value.counts[source];
    if (!isRecord(counts) || !Number.isSafeInteger(counts.active) || !Number.isSafeInteger(counts.archived)
      || Number(counts.active) < 0 || Number(counts.archived) < 0) return null;
  }
  const outcome = value.outcome;
  if (outcome !== null && (!isRecord(outcome) || typeof outcome.event_id !== "string"
    || typeof outcome.run_id !== "string" || outcome.format !== "observation.source-event/v1")) return null;
  if (isRecord(outcome) && outcome.kind === "human_grade" && (!isRecord(outcome.evaluator)
    || outcome.evaluator.kind !== "human" || typeof outcome.target !== "string"
    || typeof outcome.decided_at !== "string"
    || !(outcome.decision_id === null || typeof outcome.decision_id === "string"))) return null;
  if (isRecord(outcome) && outcome.kind === "collaboration_thread" && (!isRecord(outcome.context)
    || typeof outcome.context.title !== "string" || !(outcome.context.anchor === null || typeof outcome.context.anchor === "string")
    || !Array.isArray(outcome.messages))) return null;
  if (isRecord(outcome) && !["human_grade", "collaboration_thread"].includes(String(outcome.kind))) return null;
  return value as unknown as BackfillDelivery;
}
async function readOperatorCursor(db: Database, tenant: { readonly producer: string; readonly namespace: string }): Promise<OperatorCursor> {
  return withTenant(db, tenant, async (trx) => {
    const result = await sql<OperatorCursor>`SELECT commit_txid::text AS commit_txid, event_id AS id
      FROM observation.source_operator_cursor WHERE producer = ${tenant.producer} AND namespace = ${tenant.namespace}`.execute(trx);
    return result.rows[0] ?? { commit_txid: "0", id: "" };
  });
}
export function registerSourceRoutes(app: Hono, deps: SourceDependencies): void {
  app.get("/v1/sources/oakridge/backfill", async (c) => {
    const credential = credentialFor(c.req.header("authorization"), deps.credentials.ingest);
    if (!credential || credential.producer !== "oakridge") return errorResponse(c, 401, "unauthorized", "ingest credential required");
    return c.json(await readBackfillCheckpoint(deps.db, credential));
  });
  app.post("/v1/sources/oakridge/backfill", async (c) => {
    const credential = credentialFor(c.req.header("authorization"), deps.credentials.ingest);
    if (!credential || credential.producer !== "oakridge") return errorResponse(c, 401, "unauthorized", "ingest credential required");
    let input: unknown;
    try { input = await c.req.json(); } catch { return errorResponse(c, 400, "invalid_json", "valid JSON body required"); }
    const delivery = decodeBackfillDelivery(input);
    if (!delivery) return errorResponse(c, 400, "invalid_backfill", "valid backfill delivery required");
    try {
      const result = await deliverBackfill(deps.db, credential, delivery);
      return result === "accepted" ? c.json({ position: delivery.position, counts: delivery.counts })
        : errorResponse(c, 409, "position_conflict", "backfill position changed");
    } catch (cause) { return errorResponse(c, 409, "backfill_refused", String(cause)); }
  });
  app.get("/v1/sources/oakridge/operator-cursor", async (c) => {
    const credential = credentialFor(c.req.header("authorization"), deps.credentials.ingest);
    if (!credential || credential.producer !== "oakridge") return errorResponse(c, 401, "unauthorized", "ingest credential required");
    return c.json({ cursor: await readOperatorCursor(deps.db, credential) });
  });
  app.post("/v1/sources/oakridge/operator-events", async (c) => {
    const credential = credentialFor(c.req.header("authorization"), deps.credentials.ingest);
    if (!credential || credential.producer !== "oakridge") return errorResponse(c, 401, "unauthorized", "ingest credential required");
    let input: unknown;
    try { input = await c.req.json(); } catch { return errorResponse(c, 400, "invalid_json", "valid JSON body required"); }
    const delivery = decodeOperatorDelivery(input);
    if (!delivery) return errorResponse(c, 400, "invalid_event", "valid operator event delivery required");
    const current = await readOperatorCursor(deps.db, credential);
    if (current.commit_txid !== delivery.previous.commit_txid || current.id !== delivery.previous.id)
      return errorResponse(c, 409, "cursor_conflict", "operator cursor changed");
    if (BigInt(delivery.cursor.commit_txid) < BigInt(current.commit_txid)
      || delivery.cursor.commit_txid === current.commit_txid && delivery.cursor.id <= current.id)
      return errorResponse(c, 409, "cursor_conflict", "operator event is not after cursor");
    const handled = await handleOperatorEvent(deps.db, credential, delivery.event);
    if (!handled.ok) return errorResponse(c, handled.error.code === "frozen_export" ? 409 : 500,
      handled.error.code, handled.error.detail);
    await withTenant(deps.db, credential, async (trx) => {
      await sql`INSERT INTO observation.source_operator_cursor (producer, namespace, commit_txid, event_id)
        VALUES (${credential.producer}, ${credential.namespace}, ${delivery.cursor.commit_txid}::bigint, ${delivery.cursor.id})
        ON CONFLICT (producer, namespace) DO UPDATE SET commit_txid = excluded.commit_txid, event_id = excluded.event_id
        WHERE (observation.source_operator_cursor.commit_txid, observation.source_operator_cursor.event_id)
          = (${current.commit_txid}::bigint, ${current.id})`.execute(trx);
    });
    return c.json({ cursor: delivery.cursor, purge: handled.value });
  });
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
    try {
      const result = await deliverSourceEvent(deps.db, credential, delivery);
      return c.json(result.body, result.status);
    } catch (cause) {
      console.error("[observation] source event delivery failed", cause);
      return errorResponse(c, 500, "delivery_failed", "source event delivery failed; retry after operator review");
    }
  });
  app.get("/v1/sources/oakridge/issues", async (c) => {
    const credential = credentialFor(c.req.header("authorization"), deps.credentials.read);
    if (!credential || credential.producer !== "oakridge") return errorResponse(c, 403, "forbidden", "read credential required");
    const offset = Number(new URL(c.req.url).searchParams.get("offset") ?? "0");
    if (!Number.isSafeInteger(offset) || offset < 0) return errorResponse(c, 400, "invalid_offset", "offset must be nonnegative");
    return c.json({ items: await readSourceEventIssues(deps.db, credential, offset), offset, limit: 500 });
  });
  app.post("/v1/sources/oakridge/issues/resolve", async (c) => {
    const credential = credentialFor(c.req.header("authorization"), deps.credentials.grade ?? []);
    if (!credential || credential.producer !== "oakridge") return errorResponse(c, 403, "forbidden", "operator credential required");
    let input: unknown;
    try { input = await c.req.json(); } catch { return errorResponse(c, 400, "invalid_json", "valid JSON body required"); }
    if (!isRecord(input) || typeof input.issue_id !== "string" || input.issue_id.length === 0
      || typeof input.detail !== "string" || input.detail.trim().length === 0
      || input.detail.length > 500) return errorResponse(c, 400, "invalid_resolution", "bounded resolution detail required");
    const resolved = await resolveRunMismatchIssue(deps.db, credential, input.issue_id, boundReviewer(credential), input.detail.trim());
    return resolved ? c.json({ issue_id: input.issue_id, resolution_state: "resolved" })
      : errorResponse(c, 404, "not_found", "unresolved run mismatch issue not found");
  });
  app.get("/v1/sources/oakridge/issue-health", async (c) => {
    const credential = credentialFor(c.req.header("authorization"), deps.credentials.read);
    if (!credential || credential.producer !== "oakridge") return errorResponse(c, 403, "forbidden", "read credential required");
    const counts = await withTenant(deps.db, credential, (trx) => sql<{ unresolved: number; resolved: number }>`
      SELECT count(*) FILTER (WHERE resolution_state = 'unresolved')::integer AS unresolved,
        count(*) FILTER (WHERE resolution_state = 'resolved')::integer AS resolved
      FROM observation.source_event_issue WHERE producer = ${credential.producer} AND namespace = ${credential.namespace}`.execute(trx));
    return c.json(counts.rows[0] ?? { unresolved: 0, resolved: 0 });
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
  app.get("/v1/sources/oakridge/collaboration-comments", async (c) => {
    const credential = credentialFor(c.req.header("authorization"), deps.credentials.read);
    if (!credential || credential.producer !== "oakridge") return errorResponse(c, 403, "forbidden", "read credential required");
    const run_id = new URL(c.req.url).searchParams.get("run_id");
    if (!run_id) return errorResponse(c, 400, "invalid_run", "run_id is required");
    const items = await withTenant(deps.db, credential, (trx) => trx.selectFrom("observation.source_collaboration_comment")
      .selectAll().where("producer", "=", credential.producer).where("namespace", "=", credential.namespace)
      .where("run_id", "=", run_id).orderBy("recorded_at").orderBy("message_id").limit(200).execute());
    return c.json({ items });
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
    if (result.status === 201) {
      await projectRevision(deps.db, credential, delivery.value.local_revision_id);
      await withTenant(deps.db, credential, (trx) => reconcileSourceEventIssuesInTransaction(trx, credential, delivery.value.local_revision_id));
    }
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
