import { expect, test } from "bun:test";

import type { ArtifactRevision } from "../src/domain/artifacts";
import type { ArtifactId, ExecutionId, StageInstanceId, UnitId, WorkflowRunId } from "../src/domain/primitives";
import { createDomainReadApp } from "../src/http/domain-reads";
import type { DomainReadHttpDependencies } from "../src/http/domain-reads";

const runId = "00000000-0000-4000-8000-000000000001" as WorkflowRunId;
const stageId = "00000000-0000-4000-8000-000000000002" as StageInstanceId;
const rootId = "00000000-0000-4000-8000-000000000003" as ArtifactId;
const revisionId = "00000000-0000-4000-8000-000000000004" as ArtifactId;
const artifact: ArtifactRevision = { id: revisionId, chain_id: rootId, run_id: runId, stage_instance_id: stageId,
  execution_id: "execution" as ExecutionId, unit_id: "unit" as UnitId, output_name: "result", artifact_type: "dev.result",
  label: null, body: {}, version: 2, parent_artifact_id: rootId, lifecycle: { kind: "current" }, created_at: "2026-08-15T00:00:00Z" };

const dependencies = {
  stages: { find_by_id: async () => ({ id: stageId, run_id: runId, stage_key: "build", stage_type: "delegated_session", lifecycle: { kind: "started" as const, started_at: artifact.created_at } }) },
  artifacts: { find_by_id: async () => artifact, list_chain: async () => [artifact], list_effective_for_run: async () => [artifact] },
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
