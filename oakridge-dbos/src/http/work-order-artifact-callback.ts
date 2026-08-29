import { createHash, randomUUID } from "node:crypto";
import { Hono, type Context } from "hono";

import { isJsonValue, parseUuidId, type ArtifactId, type WorkOrderId } from "../domain/primitives";
import type { PublishWorkOrderArtifactResult } from "../domain/run-record";
import type { RunRecordRepository } from "../storage/repositories";

export interface WorkOrderArtifactCallbackDependencies {
  readonly records: Pick<RunRecordRepository, "publish_artifact">;
  now(): string;
  /** Wakes the run's root workflow sooner than its bounded recheck; absent is fine — the recheck still happens. */
  readonly send_run_wake?: (run_id: string, idempotency_key: string) => Promise<void>;
}

const statusOf = (result: PublishWorkOrderArtifactResult): 200 | 201 | 202 | 401 | 404 | 409 => {
  if (result.kind === "published") return 201;
  if (result.kind === "pending") return 202;
  if (result.kind === "already_applied") return 200;
  if (result.kind === "invalid_capability") return 401;
  if (result.kind === "work_not_found" || result.kind === "slot_not_found") return 404;
  return 409;
};

export const createWorkOrderArtifactCallbackApp = (dependencies: WorkOrderArtifactCallbackDependencies): Hono => {
  const app = new Hono();
  const publish = async (context: Context) => {
    const workOrderId = parseUuidId<WorkOrderId>(context.req.param("workOrderId"));
    if (!workOrderId) return context.json({ error: "work order not found" }, 404);
    const capability = context.req.header("work-order-capability")?.trim();
    if (!capability) return context.json({ error: "work-order capability is required" }, 401);
    let body: unknown;
    try { body = await context.req.json(); } catch { return context.json({ error: "invalid json body" }, 400); }
    if (!isJsonValue(body)) return context.json({ error: "body is not JSON-compatible" }, 400);
    const payloadHash = createHash("sha256").update(JSON.stringify(body)).digest("hex");
    const result = await dependencies.records.publish_artifact({ artifact_id: randomUUID() as ArtifactId, work_order_id: workOrderId,
      capability_hash: createHash("sha256").update(capability).digest("hex"), output_name: context.req.param("outputName") ?? "", body,
      idempotency_key: context.req.header("idempotency-key")?.trim() || payloadHash, payload_hash: payloadHash, published_at: dependencies.now() });
    const status = statusOf(result);
    if (result.kind === "published" || result.kind === "already_applied" || result.kind === "pending") {
      // A hint only ever tells the root "ask again" — sent fire-and-forget,
      // never on the response's critical path, and never required for the
      // publication itself to be correct.
      await dependencies.send_run_wake?.(result.run_id, `${result.kind}:${result.run_id}:${result.record_version}`).catch(() => undefined);
    }
    if (result.kind === "published" || result.kind === "already_applied") return context.json({ artifact_id: result.artifact_id, state: "released", record_version: result.record_version }, status);
    if (result.kind === "pending") return context.json({ artifact_id: result.artifact_id, state: "pending", wait_id: result.wait_id, record_version: result.record_version }, status);
    const failure = result;
    return context.json({ error: failure.detail, code: failure.kind,
      ...(failure.kind === "slot_already_released" || failure.kind === "idempotency_conflict" ? { artifact_id: failure.artifact_id } : {}),
      ...(failure.kind === "slot_pending" ? { wait_id: failure.wait_id } : {}) }, status);
  };
  app.put("/work-orders/:workOrderId/emit/:outputName", publish);
  return app;
};
