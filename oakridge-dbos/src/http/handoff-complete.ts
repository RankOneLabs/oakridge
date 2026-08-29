import { Hono } from "hono";

import { parseUuidId, type ArtifactId, type WaitId } from "../domain/primitives";
import type { ArtifactRevisionRepository, ExecutionArtifactContextRepository, RunRecordRepository } from "../storage/repositories";
import type { HandoffWorkflowState } from "../domain/wait";
import type { HandoffCommand } from "../workflows/handoff";

export interface HandoffCompleteDependencies {
  readonly artifacts: ArtifactRevisionRepository;
  readonly contexts: ExecutionArtifactContextRepository;
  readonly get_handoff_state: (artifact_id: ArtifactId, execution_workflow_id: string) => Promise<HandoffWorkflowState | null>;
  readonly send_handoff_command: (workflow_id: string, command: HandoffCommand, idempotency_key: string) => Promise<void>;
  /** Present only where a v2 handoff wait may need resolving; see `records` on `GateResumeDependencies`. */
  readonly records?: Pick<RunRecordRepository, "close_output_wait"> & Partial<Pick<RunRecordRepository, "complete_handoff_artifact">>;
  readonly now?: () => string;
  /** Wakes the run's root workflow sooner than its bounded recheck; absent is fine — the recheck still happens. */
  readonly send_run_wake?: (run_id: string, idempotency_key: string) => Promise<void>;
}

interface V2ExternalCompletionRequest { readonly correlation_id: string; readonly actor: string }

const parseV2Request = (value: unknown): V2ExternalCompletionRequest | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const body = value as { readonly [key: string]: unknown };
  if (typeof body.correlation_id !== "string" || body.correlation_id.trim() === "") return null;
  if (typeof body.actor !== "string" || body.actor.trim() === "") return null;
  return { correlation_id: body.correlation_id.trim(), actor: body.actor.trim() };
};

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
    if (dependencies.records?.complete_handoff_artifact) {
      const result = await dependencies.records.complete_handoff_artifact({ artifact_id: artifactId, external_kind: request.external_kind,
        actor: `external:${request.external_kind}`, correlation_id: request.correlation_id,
        decided_at: (dependencies.now ?? (() => new Date().toISOString()))() });
      if (result.kind !== "wait_not_found") {
        if (result.kind === "wait_conflict") return http.json({ error: result.detail }, 409);
        await dependencies.send_run_wake?.(result.run_id, `${result.kind}:${result.run_id}:${result.record_version}`).catch(() => undefined);
        return http.json({ artifact_id: artifact.id, completed: true }, 202);
      }
    }
    const producer = await dependencies.contexts.find_for_emit(artifact.stage_instance_id, artifact.unit_id);
    const release = producer?.outputs.find((output) => output.name === artifact.output_name)?.release;
    if (!producer || release?.kind !== "handoff") return http.json({ error: "artifact is not a configured output handoff" }, 409);
    if (release.external_wait_kind !== request.external_kind) return http.json({ error: "external completion kind does not match the handoff policy" }, 409);
    const state = await dependencies.get_handoff_state(artifact.id, producer.execution_workflow_id);
    if (!state || state.status !== "awaiting_external" || state.artifact_id !== artifact.id) return http.json({ error: "handoff is not awaiting this external completion" }, 409);
    await dependencies.send_handoff_command(state.command_workflow_id, { kind: "external_completed", external_kind: request.external_kind, correlation_id: request.correlation_id }, request.idempotency_key);
    return http.json({ artifact_id: artifact.id, completed: true }, 202);
  });

  /**
   * The v2 external-completion command: releases the run-owned slot a
   * `handoff` output parked, atomically with closing its wait. As with the v2
   * gate route, there is no DBOS handoff workflow in the loop — the wait row
   * and the slot transition are the whole fact.
   */
  app.post("/v2/waits/:waitId/external-complete", async (http) => {
    if (!dependencies.records) return http.json({ error: "v2 handoff completion is not configured" }, 501);
    const waitId = parseUuidId<WaitId>(http.req.param("waitId"));
    if (!waitId) return http.json({ error: "wait not found" }, 404);
    let raw: unknown;
    try { raw = await http.req.json(); } catch { return http.json({ error: "request body must be JSON" }, 400); }
    const request = parseV2Request(raw);
    if (!request) return http.json({ error: "correlation_id and actor are required strings" }, 400);
    const decided_at = (dependencies.now ?? (() => new Date().toISOString()))();
    const result = await dependencies.records.close_output_wait({ wait_id: waitId, disposition: "release", actor: request.actor, detail: request.correlation_id, decided_at });
    if (result.kind === "wait_not_found") return http.json({ error: result.detail }, 404);
    if (result.kind === "wait_conflict") return http.json({ error: result.detail }, 409);
    // A hint only ever tells the root "ask again" — sent fire-and-forget,
    // never on the response's critical path.
    await dependencies.send_run_wake?.(result.run_id, `${result.kind}:${result.run_id}:${result.record_version}`).catch(() => undefined);
    if (result.kind === "released") return http.json({ wait_id: waitId, state: "released", artifact_id: result.artifact_id, record_version: result.record_version }, 202);
    return http.json({ wait_id: waitId, state: "already_applied", record_version: result.record_version }, 202);
  });

  return app;
};
