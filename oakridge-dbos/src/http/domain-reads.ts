import { Hono } from "hono";

import type { ArtifactId, StageInstanceId, WorkflowRunId } from "../domain/primitives";
import type { ArtifactRevisionRepository, RunArtifactReadRepository, StageInstanceRepository } from "../storage/repositories";

export interface DomainReadHttpDependencies {
  readonly stages: StageInstanceRepository;
  readonly artifacts: ArtifactRevisionRepository & RunArtifactReadRepository;
}

export const createDomainReadApp = (dependencies: DomainReadHttpDependencies): Hono => {
  const app = new Hono();
  app.get("/stage_instances/:id", async (http) => {
    const stage = await dependencies.stages.find_by_id(http.req.param("id") as StageInstanceId);
    return stage ? http.json(stage) : http.json({ error: "stage instance not found" }, 404);
  });
  app.get("/workflow_runs/:id/artifacts", async (http) =>
    http.json(await dependencies.artifacts.list_effective_for_run(http.req.param("id") as WorkflowRunId)));
  app.get("/artifacts/:id", async (http) => {
    const artifact = await dependencies.artifacts.find_by_id(http.req.param("id") as ArtifactId);
    if (!artifact) return http.json({ error: "artifact not found" }, 404);
    return http.json(await dependencies.artifacts.list_chain(artifact.chain_id));
  });
  return app;
};
