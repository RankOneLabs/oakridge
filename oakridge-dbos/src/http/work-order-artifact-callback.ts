import { Hono, type Context } from "hono";

import { isJsonValue, parseUuidId, type AttemptId, type JsonValue, type OutputCollectionKey, type Result, type WorkflowRunId } from "../domain/primitives";
import type { PublishWorkOrderArtifactResult } from "../domain/run-record";
import { publishWorkOrderArtifact } from "../runtime/publish-work-order-artifact";
import type { RunRecordRepository } from "../storage/repositories";

export interface WorkOrderArtifactCallbackDependencies {
  readonly records: Pick<RunRecordRepository, "publish_artifact">;
  readonly enrich?: (input: { readonly attempt_id: AttemptId; readonly output_name: string; readonly body: JsonValue }) =>
    Promise<Result<JsonValue | null, { readonly code: string; readonly detail: string }>>;
  now(): string;
  /** Wakes the run's root workflow sooner than its bounded recheck; absent is fine — the recheck still happens. */
  readonly send_run_wake?: (run_id: WorkflowRunId, idempotency_key: string) => Promise<void>;
  /** Wakes the publishing cohort's machine, which is what acts on a new artifact. */
}

const statusOf = (result: PublishWorkOrderArtifactResult): 200 | 201 | 202 | 401 | 404 | 409 | 503 => {
  if (result.kind === "published") return 201;
  if (result.kind === "pending") return 202;
  if (result.kind === "already_applied") return 200;
  if (result.kind === "invalid_capability") return 401;
  if (result.kind === "enrichment_unavailable") return 503;
  if (result.kind === "work_not_found" || result.kind === "slot_not_found") return 404;
  return 409;
};

export const createWorkOrderArtifactCallbackApp = (dependencies: WorkOrderArtifactCallbackDependencies): Hono => {
  const app = new Hono();
  const publish = async (context: Context) => {
    // The path segment is still `work-orders/:workOrderId`: it carries the id
    // the executor was handed in `publication.work_order_id`, which in v15 is
    // its attempt. The wire contract the agent adapter calls is unchanged.
    const attemptId = parseUuidId<AttemptId>(context.req.param("workOrderId"));
    if (!attemptId) return context.json({ error: "work order not found" }, 404);
    const capability = context.req.header("work-order-capability")?.trim();
    if (!capability) return context.json({ error: "work-order capability is required" }, 401);
    let body: unknown;
    try { body = await context.req.json(); } catch { return context.json({ error: "invalid json body" }, 400); }
    if (!isJsonValue(body)) return context.json({ error: "body is not JSON-compatible" }, 400);
    const collectionKey = context.req.header("output-collection-key")?.trim() || null;
    const result = await publishWorkOrderArtifact({ attempt_id: attemptId, capability, output_name: context.req.param("outputName") ?? "",
      collection_key: collectionKey as OutputCollectionKey | null, body, idempotency_key: context.req.header("idempotency-key")?.trim() || null }, dependencies);
    const status = statusOf(result);
    if (result.kind === "published" || result.kind === "already_applied" || result.kind === "pending") {
      // A hint only ever tells a machine "ask again" — sent fire-and-forget,
      // never on the response's critical path, and never required for the
      // publication itself to be correct.
      const key = `${result.kind}:${result.artifact_id}:${result.record_version}`;
      await dependencies.send_run_wake?.(result.run_id, key).catch(() => undefined);
    }
    if (result.kind === "published" || result.kind === "already_applied") return context.json({ artifact_id: result.artifact_id, state: "released", record_version: result.record_version }, status);
    if (result.kind === "pending") return context.json({ artifact_id: result.artifact_id, state: "pending", wait_id: result.wait_id, record_version: result.record_version }, status);
    const failure = result;
    return context.json({ error: failure.detail, code: failure.kind === "refused" ? failure.code : failure.kind,
      ...(failure.kind === "slot_already_released" || failure.kind === "idempotency_conflict" ? { artifact_id: failure.artifact_id } : {}),
      ...(failure.kind === "slot_pending" ? { wait_id: failure.wait_id } : {}) }, status);
  };
  app.put("/work-orders/:workOrderId/emit/:outputName", publish);
  return app;
};
