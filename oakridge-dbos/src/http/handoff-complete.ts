import { Hono } from "hono";

import { parseUuidId, type ArtifactId } from "../domain/primitives";
import type { ArtifactRevisionRepository, ExecutionArtifactContextRepository } from "../storage/repositories";
import type { HandoffWorkflowState } from "./gate-resume";
import type { HandoffCommand } from "../workflows/handoff";
import { handoffWorkflowId } from "../domain/workflow-ids";

export interface HandoffCompleteDependencies {
  readonly artifacts: ArtifactRevisionRepository;
  readonly contexts: ExecutionArtifactContextRepository;
  readonly get_handoff_state: (workflow_id: string) => Promise<HandoffWorkflowState | null>;
  readonly send_handoff_command: (workflow_id: string, command: HandoffCommand, idempotency_key: string) => Promise<void>;
}

interface ExternalCompletionRequest { readonly external_kind: string; readonly correlation_id: string; readonly idempotency_key: string }

const parseRequest = (value: unknown): ExternalCompletionRequest | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const body = value as { readonly [key: string]: unknown };
  if (typeof body.external_kind !== "string" || body.external_kind.trim() === "") return null;
  if (typeof body.correlation_id !== "string" || body.correlation_id.trim() === "") return null;
  if (typeof body.idempotency_key !== "string" || body.idempotency_key.trim() === "") return null;
  return { external_kind: body.external_kind.trim(), correlation_id: body.correlation_id.trim(), idempotency_key: body.idempotency_key.trim() };
};

export const createHandoffCompleteApp = (dependencies: HandoffCompleteDependencies): Hono => {
  const app = new Hono();
  app.post("/handoffs/:artifactId/external-complete", async (http) => {
    let raw: unknown;
    try { raw = await http.req.json(); } catch { return http.json({ error: "request body must be JSON" }, 400); }
    const request = parseRequest(raw);
    if (!request) return http.json({ error: "external_kind, correlation_id, and idempotency_key are required strings" }, 400);
    const artifactId = parseUuidId<ArtifactId>(http.req.param("artifactId"));
    if (!artifactId) return http.json({ error: "artifact not found" }, 404);
    const artifact = await dependencies.artifacts.find_by_id(artifactId);
    if (!artifact) return http.json({ error: "handoff artifact not found" }, 404);
    if (artifact.lifecycle.kind !== "current") return http.json({ error: "handoff artifact is not current", code: artifact.lifecycle.kind }, 409);
    const producer = await dependencies.contexts.find_for_emit(artifact.stage_instance_id, artifact.unit_id);
    const release = producer?.outputs.find((output) => output.name === artifact.output_name)?.release;
    if (!producer || release?.kind !== "handoff") return http.json({ error: "artifact is not a configured output handoff" }, 409);
    if (release.external_wait_kind !== request.external_kind) return http.json({ error: "external completion kind does not match the handoff policy" }, 409);
    const workflowId = handoffWorkflowId(producer.execution_workflow_id, artifact.id);
    const state = await dependencies.get_handoff_state(workflowId);
    if (!state || state.status !== "awaiting_external" || state.artifact_id !== artifact.id) return http.json({ error: "handoff is not awaiting this external completion" }, 409);
    await dependencies.send_handoff_command(workflowId, { kind: "external_completed", external_kind: request.external_kind, correlation_id: request.correlation_id }, request.idempotency_key);
    return http.json({ artifact_id: artifact.id, completed: true }, 202);
  });
  return app;
};
