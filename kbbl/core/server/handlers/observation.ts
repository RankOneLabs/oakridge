import type { Hono } from "hono";
import { z } from "zod";
import { makeObservationAuthMiddleware, type AuthPolicy } from "../auth";
import type { ObservationClient } from "../observation/client";

const summaryRequest = z.object({ run_id: z.string().min(1), unit_id: z.string().min(1),
  artifact_key: z.string().min(1), publication_ordinal: z.number().int().positive(),
  item_id_or_path: z.string().min(1), namespace: z.string().min(1) });

export function mountObservationRoutes(app: Hono, deps: {
  readonly authPolicy: AuthPolicy; readonly client: ObservationClient | null;
  readonly namespace: string | null;
}): void {
  app.use("/observation/*", makeObservationAuthMiddleware(deps.authPolicy));
  app.post("/observation/item-summary", async (c) => {
    if (!deps.client || !deps.namespace) return c.json({ error: "unavailable" }, 503, { "cache-control": "no-store" });
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ error: "invalid_json" }, 400); }
    const parsed = summaryRequest.safeParse(body);
    if (!parsed.success || parsed.data.namespace !== deps.namespace) return c.json({ error: "invalid_address" }, 400);
    const { item_id_or_path, ...artifact } = parsed.data;
    const result = await deps.client.getArtifactItemSummary({ artifact, item_id_or_path });
    return result.ok ? c.json(result.value, 200, { "cache-control": "no-store" })
      : c.json({ error: result.error.operation, detail: result.error.detail }, 502, { "cache-control": "no-store" });
  });
  app.get("/observation/items/:id/lineage", async (c) => {
    if (!deps.client) return c.json({ error: "unavailable" }, 503);
    const result = await deps.client.getLineage(c.req.param("id"));
    return result.ok ? c.json(result.value, 200, { "cache-control": "no-store" })
      : c.json({ error: result.error.operation, detail: result.error.detail }, 502);
  });
  app.get("/observation/evidence/:id", async (c) => {
    if (!deps.client) return c.json({ error: "unavailable" }, 503, { "cache-control": "no-store" });
    const result = await deps.client.getEvidence(c.req.param("id"));
    return result.ok ? c.json(result.value, 200, { "cache-control": "no-store" })
      : c.json({ error: result.error.operation, detail: result.error.detail }, 502, { "cache-control": "no-store" });
  });
  app.post("/observation/blind/assignments", async (c) => {
    if (!deps.client) return c.json({ error: "unavailable" }, 503, { "cache-control": "no-store" });
    const result = await deps.client.listBlindAssignments();
    return result.ok ? c.json(result.value, 200, { "cache-control": "no-store" })
      : c.json({ error: result.error.operation, detail: result.error.detail }, 502, { "cache-control": "no-store" });
  });
  app.post("/observation/blind/assignments/:id", async (c) => {
    if (!deps.client) return c.json({ error: "unavailable" }, 503, { "cache-control": "no-store" });
    const result = await deps.client.getBlindAssignment(c.req.param("id"));
    return result.ok ? c.json(result.value, 200, { "cache-control": "no-store" })
      : c.json({ error: result.error.operation, detail: result.error.detail }, 502, { "cache-control": "no-store" });
  });
}
