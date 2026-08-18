import { createHash, randomUUID } from "node:crypto";

import { Hono, type Context } from "hono";

import { releaseStateForArtifact, validateArtifactEmission } from "../contracts/evaluate-artifacts";
import type { ArtifactEmission, ArtifactLifecycleNotification } from "../domain/artifacts";
import { parseUuidId, isJsonValue, type ArtifactId, type StageInstanceId, type UnitId } from "../domain/primitives";
import type { ArtifactRevisionRepository, ExecutionArtifactContextRepository } from "../storage/repositories";

export type ArtifactWorkflowMessage = ArtifactLifecycleNotification;

export interface ArtifactCallbackDependencies {
  readonly contexts: ExecutionArtifactContextRepository;
  readonly artifacts: ArtifactRevisionRepository;
  dispatch_notifications(): Promise<number>;
}

export const createArtifactCallbackApp = (dependencies: ArtifactCallbackDependencies): Hono => {
  const app = new Hono();
  const emit = async (context: Context) => {
    const stageInstanceId = parseUuidId<StageInstanceId>(context.req.param("stageInstanceId"));
    if (!stageInstanceId) return context.json({ error: "execution unit not found" }, 404);
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
    let result;
    try {
      result = await dependencies.artifacts.emit_revision(randomUUID() as ArtifactId, emission, new Date().toISOString(), { target_workflow_id: execution.execution_workflow_id, release: validation.value.release });
    } catch (error) {
      return context.json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
    if (!result.ok) return context.json({ error: result.error.detail, code: result.error.kind, artifact_id: result.error.artifact_id }, result.error.kind === "invariant_conflict" ? 500 : 409);
    const artifact = result.value.artifact;
    const release = releaseStateForArtifact(artifact, validation.value.release);
    await dependencies.dispatch_notifications();
    return context.json({ artifact_id: artifact.id, chain_id: artifact.chain_id, version: artifact.version, state: artifact.lifecycle.kind, release: release.kind, replaced_artifact_id: result.value.superseded_artifact_id });
  };
  app.put("/executors/:executorType/:stageInstanceId/units/:unitId/emit/:outputName", emit);
  app.post("/executors/:executorType/:stageInstanceId/units/:unitId/emit/:outputName", emit);
  return app;
};
