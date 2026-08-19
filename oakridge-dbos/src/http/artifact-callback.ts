import { Hono, type Context } from "hono";

import type { ArtifactLifecycleNotification } from "../domain/artifacts";
import { parseUuidId, isJsonValue, type StageInstanceId, type UnitId } from "../domain/primitives";
import { emitExecutionArtifact, type EmitExecutionArtifactDependencies, type EmitExecutionArtifactFailure } from "../runtime/emit-artifact";

export type ArtifactWorkflowMessage = ArtifactLifecycleNotification;

export type ArtifactCallbackDependencies = EmitExecutionArtifactDependencies;

/** The HTTP reading of an emission failure — one place, exhaustive over the union. */
const selectEmissionStatus = (failure: EmitExecutionArtifactFailure): 400 | 404 | 409 | 500 => {
  if (failure.kind === "execution_not_found") return 404;
  if (failure.kind === "unknown_output" || failure.kind === "contract_violation") return 400;
  if (failure.kind === "persistence_failed") return 500;
  return failure.conflict === "invariant_conflict" ? 500 : 409;
};

export const createArtifactCallbackApp = (dependencies: ArtifactCallbackDependencies): Hono => {
  const app = new Hono();
  const emit = async (context: Context) => {
    const stageInstanceId = parseUuidId<StageInstanceId>(context.req.param("stageInstanceId"));
    if (!stageInstanceId) return context.json({ error: "execution unit not found" }, 404);
    let body: unknown;
    try { body = await context.req.json(); } catch { return context.json({ error: "invalid json body" }, 400); }
    if (!isJsonValue(body)) return context.json({ error: "body is not JSON-compatible" }, 400);
    const emitted = await emitExecutionArtifact(dependencies, {
      stage_instance_id: stageInstanceId,
      unit_id: context.req.param("unitId") as UnitId,
      executor_type: context.req.param("executorType") ?? "",
      output_name: context.req.param("outputName") ?? "",
      body,
      idempotency_key: context.req.header("idempotency-key")?.trim() || null,
    });
    if (!emitted.ok) {
      const failure = emitted.error;
      return context.json({ error: failure.detail,
        ...(failure.kind === "emission_conflict" ? { code: failure.conflict, artifact_id: failure.artifact_id } : {}) },
        selectEmissionStatus(failure));
    }
    const { artifact, release, superseded_artifact_id } = emitted.value;
    return context.json({ artifact_id: artifact.id, chain_id: artifact.chain_id, version: artifact.version,
      state: artifact.lifecycle.kind, release: release.kind, replaced_artifact_id: superseded_artifact_id });
  };
  app.put("/executors/:executorType/:stageInstanceId/units/:unitId/emit/:outputName", emit);
  app.post("/executors/:executorType/:stageInstanceId/units/:unitId/emit/:outputName", emit);
  return app;
};
