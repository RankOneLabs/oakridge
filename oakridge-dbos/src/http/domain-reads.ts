import { Hono } from "hono";

import { parseUuidId, type ArtifactId, type StageInstanceId, type WorkflowRunId } from "../domain/primitives";
import type { ArtifactRevisionRepository, RunArtifactReadRepository, StageInstanceRepository } from "../storage/repositories";

export interface DomainReadHttpDependencies {
  readonly stages: StageInstanceRepository;
  readonly artifacts: ArtifactRevisionRepository & RunArtifactReadRepository;
}

export const createDomainReadApp = (dependencies: DomainReadHttpDependencies): Hono => {
  const app = new Hono();
  app.get("/stage_instances/:id", async (http) => {
    const stageId = parseUuidId<StageInstanceId>(http.req.param("id"));
    const stage = stageId && await dependencies.stages.find_by_id(stageId);
    return stage ? http.json(stage) : http.json({ error: "stage instance not found" }, 404);
  });
  app.get("/workflow_runs/:id/artifacts", async (http) => {
    const runId = parseUuidId<WorkflowRunId>(http.req.param("id"));
    return http.json(runId ? await dependencies.artifacts.list_effective_for_run(runId) : []);
  });
  app.get("/artifacts/:id", async (http) => {
    const artifactId = parseUuidId<ArtifactId>(http.req.param("id"));
    const artifact = artifactId && await dependencies.artifacts.find_by_id(artifactId);
    if (!artifact) return http.json({ error: "artifact not found" }, 404);
    return http.json(await dependencies.artifacts.list_chain(artifact.chain_id));
  });
  return app;
};
