import { expect, test } from "bun:test";

import type { WorkflowDefinitionId, WorkflowRunId } from "../src/domain/primitives";
import type { WorkflowDefinition } from "../src/domain/workflow";
import { launchRun, type LaunchRunDependencies } from "../src/runtime/launch-run";

test("initial launch durably enqueues DBOS with the domain checkpoint input", async () => {
  const calls: string[] = [];
  const runId = "0d9ac045-f7e4-48a0-9b86-bd7cd2cf5f93" as WorkflowRunId;
  const definition = { id: "ef2b47a4-d1bd-44ee-840a-e4f7b27570db" as WorkflowDefinitionId, name: "flow", version: 11, graph: { stages: {}, edges: [] }, archived: false, created_at: "now" } as WorkflowDefinition;
  const dependencies = { definitions: { async find_by_id() { return definition; } },
    dbos: { async start_run(_id: string, input: { created_at?: string }) { calls.push(`dbos:${input.created_at}`); } }, now: () => "2026-08-14T00:00:00Z" } as unknown as LaunchRunDependencies;
  const result = await launchRun({ run_id: runId, workflow_definition_id: definition.id, context: {} }, dependencies);
  expect(result.root_workflow_id).toBe(`oakridge-run:${runId}:attempt:initial`);
  expect(calls).toEqual(["dbos:2026-08-14T00:00:00Z"]);
});
