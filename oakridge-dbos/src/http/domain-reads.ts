import { Hono } from "hono";

import { parseUuidId, type ArtifactId, type StageInstanceId, type WorkflowRunId } from "../domain/primitives";
import type { ArtifactRevisionRepository, RunArtifactReadRepository, SessionHoldRepository, SessionRunLocationRepository, StageInstanceRepository } from "../storage/repositories";

export interface DomainReadHttpDependencies {
  readonly stages: StageInstanceRepository;
  readonly artifacts: ArtifactRevisionRepository & RunArtifactReadRepository;
  readonly session_holds: SessionHoldRepository;
  readonly session_run_locations: SessionRunLocationRepository;
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
  /**
   * Whether an agent session may be closed. kbbl asks before honouring an
   * operator close, because a session closed mid-stage abandons its unit: the
   * execution workflow stops waiting, a gated artifact is never released, and
   * the operator's later approval lands on a workflow that has already
   * returned. Session ids are kbbl's, not uuid-shaped domain ids, so they are
   * passed through as given.
   */
  app.get("/session_holds/:session_id", async (http) => {
    const hold = await dependencies.session_holds.find_session_hold(http.req.param("session_id"));
    return http.json({ held: hold !== null, hold });
  });
  /**
   * Where a session sits in the run graph, for navigation. Distinct from
   * `/session_holds/:session_id` above on purpose: this resolves a session
   * whose work order finished and whose cleanup completed — a case the hold
   * route correctly reports as `held: false`, because it answers whether the
   * session may be closed, not which run it came from.
   *
   * 404 rather than a null body, so the caller can tell "this session is not
   * one of ours" from "this session has no run". Session ids are kbbl's, not
   * uuid-shaped domain ids, so they pass through as given.
   */
  app.get("/sessions/:session_id/run", async (http) => {
    const location = await dependencies.session_run_locations.find_run_for_session(http.req.param("session_id"));
    return location ? http.json(location) : http.json({ error: "session belongs to no run" }, 404);
  });
  return app;
};
