import { Hono } from "hono";

import { parseUuidId, type ArtifactId } from "../domain/primitives";
import type { ArtifactRevisionRepository, ExecutionArtifactContextRepository } from "../storage/repositories";

export interface ArtifactWithdrawDependencies {
  readonly artifacts: ArtifactRevisionRepository;
  readonly contexts: ExecutionArtifactContextRepository;
  dispatch_notifications(): Promise<number>;
  readonly now?: () => string;
}

interface WithdrawBody { readonly actor: string; readonly reason: string }

const parseWithdrawBody = (value: unknown): WithdrawBody | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const body = value as { readonly [key: string]: unknown };
  if (typeof body.actor !== "string" || body.actor.trim() === "") return null;
  if (typeof body.reason !== "string" || body.reason.trim() === "") return null;
  return { actor: body.actor.trim(), reason: body.reason.trim() };
};

export const createArtifactWithdrawApp = (dependencies: ArtifactWithdrawDependencies): Hono => {
  const app = new Hono();
  app.post("/artifacts/:id/withdraw", async (http) => {
    let raw: unknown;
    try { raw = await http.req.json(); } catch { return http.json({ error: { code: "invalid_json", message: "request body must be JSON" } }, 400); }
    const body = parseWithdrawBody(raw);
    if (!body) return http.json({ error: { code: "invalid_withdrawal", message: "actor and reason are required strings" } }, 400);
    const artifactId = parseUuidId<ArtifactId>(http.req.param("id"));
    if (!artifactId) return http.json({ error: "artifact not found" }, 404);
    const before = await dependencies.artifacts.find_by_id(artifactId);
    if (!before) return http.json({ kind: "not_found", artifact_id: artifactId }, 404);
    const execution = await dependencies.contexts.find_for_emit(before.stage_instance_id, before.unit_id);
    if (!execution || execution.execution_id !== before.execution_id) return http.json({ kind: "not_found", artifact_id: artifactId }, 404);
    const result = await dependencies.artifacts.withdraw({ artifact_id: artifactId, actor: body.actor, reason: body.reason, withdrawn_at: (dependencies.now ?? (() => new Date().toISOString()))(), target_workflow_id: execution.execution_workflow_id });
    if (result.kind === "not_found") return http.json(result, 404);
    if (result.kind === "not_current" || result.kind === "release_conflict") return http.json(result, 409);
    await dependencies.dispatch_notifications();
    const withdrawnAt = result.artifact.lifecycle.kind === "withdrawn" ? result.artifact.lifecycle.withdrawn_at : null;
    return http.json({ kind: result.kind, artifact_id: artifactId, withdrawn_at: withdrawnAt });
  });
  return app;
};
