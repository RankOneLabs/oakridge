import { createHash, randomUUID } from "node:crypto";

import { Hono } from "hono";

import { releaseStateForArtifact, validateArtifactEmission } from "../contracts/evaluate-artifacts";
import type { ArtifactEmission, ArtifactReleaseState } from "../domain/artifacts";
import type { ArtifactId, JsonValue, StageInstanceId, UnitId } from "../domain/primitives";
import type { ArtifactRevisionRepository, ExecutionArtifactContextRepository } from "../storage/repositories";

export interface ArtifactWorkflowMessage {
  readonly kind: "artifact_emitted";
  readonly release: ArtifactReleaseState;
}

export interface ArtifactCallbackDependencies {
  readonly contexts: ExecutionArtifactContextRepository;
  readonly artifacts: ArtifactRevisionRepository;
  send_to_workflow(workflow_id: string, message: ArtifactWorkflowMessage, idempotency_key: string): Promise<void>;
}

const isJsonValue = (value: unknown): value is JsonValue => {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  return typeof value === "object" && Object.values(value).every(isJsonValue);
};

export const createArtifactCallbackApp = (dependencies: ArtifactCallbackDependencies): Hono => {
  const app = new Hono();
  app.put("/executors/:executorType/:stageInstanceId/units/:unitId/emit/:outputName", async (context) => {
    const stageInstanceId = context.req.param("stageInstanceId") as StageInstanceId;
    const unitId = context.req.param("unitId") as UnitId;
    const execution = await dependencies.contexts.find_for_emit(stageInstanceId, unitId);
    if (!execution || execution.executor_type !== context.req.param("executorType")) return context.json({ error: "execution unit not found" }, 404);
    let body: unknown;
    try { body = await context.req.json(); } catch { return context.json({ error: "invalid json body" }, 400); }
    if (!isJsonValue(body)) return context.json({ error: "body is not JSON-compatible" }, 400);
    const payloadHash = createHash("sha256").update(JSON.stringify(body)).digest("hex");
    const declared = execution.outputs.find((output) => output.name === context.req.param("outputName"));
    if (!declared) return context.json({ error: `unknown output slot: ${context.req.param("outputName")}` }, 400);
    const emission: ArtifactEmission = {
      run_id: execution.run_id, stage_instance_id: execution.stage_instance_id, execution_id: execution.execution_id,
      unit_id: execution.unit_id, output_name: declared.name, artifact_type: declared.artifact_type, label: execution.unit_id,
      body, idempotency_key: context.req.header("idempotency-key")?.trim() || payloadHash, payload_hash: payloadHash,
    };
    const validation = validateArtifactEmission(emission, execution.outputs);
    if (!validation.ok) return context.json({ error: validation.error.detail }, 400);
    let artifact;
    try {
      artifact = await dependencies.artifacts.emit_revision(randomUUID() as ArtifactId, emission, new Date().toISOString());
    } catch (error) {
      return context.json({ error: error instanceof Error ? error.message : String(error) }, 409);
    }
    const release = releaseStateForArtifact(artifact, validation.value);
    await dependencies.send_to_workflow(execution.execution_workflow_id, { kind: "artifact_emitted", release }, `artifact:${artifact.id}:${release.kind}`);
    return context.json({ artifact_id: artifact.id, version: artifact.version, release: release.kind });
  });
  return app;
};
