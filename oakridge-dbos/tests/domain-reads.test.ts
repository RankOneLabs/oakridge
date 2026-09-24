import { expect, test } from "bun:test";

import type { ArtifactRevision } from "../src/domain/artifacts";
import type { ArtifactId, ExecutionId, StageInstanceId, UnitId, WorkflowRunId, WorkOrderId } from "../src/domain/primitives";
import type { OperatorSessionRunLocation } from "../src/domain/operator-projections";
import { createDomainReadApp } from "../src/http/domain-reads";
import type { DomainReadHttpDependencies } from "../src/http/domain-reads";

const runId = "00000000-0000-4000-8000-000000000001" as WorkflowRunId;
const stageId = "00000000-0000-4000-8000-000000000002" as StageInstanceId;
const rootId = "00000000-0000-4000-8000-000000000003" as ArtifactId;
const revisionId = "00000000-0000-4000-8000-000000000004" as ArtifactId;
const artifact: ArtifactRevision = { id: revisionId, chain_id: rootId, run_id: runId, stage_instance_id: stageId,
  execution_id: "execution" as ExecutionId, unit_id: "unit" as UnitId, output_name: "result", artifact_type: "dev.result",
  label: null, body: {}, version: 2, parent_artifact_id: rootId, lifecycle: { kind: "current" }, created_at: "2026-08-15T00:00:00Z" };

const location: OperatorSessionRunLocation = { run_id: runId, stage_instance_id: stageId, stage_key: "build",
  unit_id: "unit" as UnitId, work_order_id: "00000000-0000-4000-8000-000000000005" as WorkOrderId };

const dependencies = {
  stages: { find_by_id: async () => ({ id: stageId, run_id: runId, stage_key: "build", stage_type: "delegated_session", lifecycle: { kind: "started" as const, started_at: artifact.created_at } }) },
  artifacts: { find_by_id: async () => artifact, list_chain: async () => [artifact], list_effective_for_run: async () => [artifact] },
  session_run_locations: { find_run_for_session: async (id: string) => (id === "session-1" ? location : null) },
} as unknown as DomainReadHttpDependencies;

test("domain reads expose StageInstance without coupling it to execution", async () => {
  const response = await createDomainReadApp(dependencies).request(`/stage_instances/${stageId}`);
  expect(await response.json()).toEqual(expect.objectContaining({ id: stageId, stage_key: "build", lifecycle: { kind: "started", started_at: artifact.created_at } }));
});

test("domain reads expose effective run artifacts and immutable chain history", async () => {
  const app = createDomainReadApp(dependencies);
  expect(await (await app.request(`/workflow_runs/${runId}/artifacts`)).json()).toEqual([artifact]);
  expect(await (await app.request(`/artifacts/${revisionId}`)).json()).toEqual([artifact]);
});

test("a session resolves to the run, stage and unit it belongs to", async () => {
  const response = await createDomainReadApp(dependencies).request("/sessions/session-1/run");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(location);
});

/** 404 rather than a null body, so a caller can tell "not one of ours" from "no run". */
test("a session that belongs to no run is a 404", async () => {
  const response = await createDomainReadApp(dependencies).request("/sessions/unknown-session/run");
  expect(response.status).toBe(404);
});

/** Session ids are kbbl's, not uuid-shaped domain ids — the route must not validate them as such. */
test("a non-uuid session id reaches the repository as given", async () => {
  let asked = "";
  const app = createDomainReadApp({ ...dependencies,
    session_run_locations: { async find_run_for_session(id: string) { asked = id; return null; } } });
  await app.request("/sessions/not-a-uuid/run");
  expect(asked).toBe("not-a-uuid");
});
