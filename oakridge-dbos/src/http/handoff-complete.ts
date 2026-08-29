import { Hono } from "hono";

import { parseUuidId, type ArtifactId } from "../domain/primitives";
import type { RunRecordRepository } from "../storage/repositories";

export interface HandoffCompleteDependencies {
  readonly records: Pick<RunRecordRepository, "complete_handoff_artifact">;
  readonly now?: () => string;
  readonly send_run_wake?: (run_id: string, idempotency_key: string) => Promise<void>;
}

interface ExternalCompletionRequest { readonly external_kind: string; readonly correlation_id: string }

const parseRequest = (value: unknown): ExternalCompletionRequest | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const body = value as { readonly [key: string]: unknown };
  if (typeof body.external_kind !== "string" || body.external_kind.trim() === "") return null;
  if (typeof body.correlation_id !== "string" || body.correlation_id.trim() === "") return null;
  return { external_kind: body.external_kind.trim(), correlation_id: body.correlation_id.trim() };
};

export const createHandoffCompleteApp = (dependencies: HandoffCompleteDependencies): Hono => {
  const app = new Hono();
  app.post("/handoffs/:artifactId/external-complete", async (http) => {
    const artifactId = parseUuidId<ArtifactId>(http.req.param("artifactId"));
    if (!artifactId) return http.json({ error: "handoff artifact was not found" }, 404);
    const request = parseRequest(await http.req.json().catch(() => null));
    if (!request) return http.json({ error: "external_kind and correlation_id are required strings" }, 400);
    const result = await dependencies.records.complete_handoff_artifact({ artifact_id: artifactId,
      external_kind: request.external_kind, actor: `external:${request.external_kind}`,
      correlation_id: request.correlation_id, decided_at: (dependencies.now ?? (() => new Date().toISOString()))() });
    if (result.kind === "wait_not_found") return http.json({ error: result.detail }, 404);
    if (result.kind === "wait_conflict") return http.json({ error: result.detail }, 409);
    await dependencies.send_run_wake?.(result.run_id, `${result.kind}:${result.run_id}:${result.record_version}`).catch(() => undefined);
    return http.json({ artifact_id: artifactId, completed: true }, 202);
  });
  return app;
};
