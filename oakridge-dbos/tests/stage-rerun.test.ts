import { expect, test } from "bun:test";

import type { WorkflowDefinitionId, WorkflowRunId } from "../src/domain/primitives";
import type { WorkflowDefinition } from "../src/domain/workflow";
import { rerunStage, type StageRerunDependencies } from "../src/runtime/stage-rerun";
import type { WorkflowAttempt } from "../src/storage/repositories";
import type { RunWorkflowInput } from "../src/workflows/production-topology";

const runId = "run-1" as WorkflowRunId;
const definition: WorkflowDefinition = { id: "definition-1" as WorkflowDefinitionId, name: "dev-flow", version: 11,
  archived: false, created_at: "2026-08-14T00:00:00Z", graph: { stages: { build: { stage_type: "delegated_session", operator_role: "build", config: {}, inputs: [], outputs: [] } }, edges: [] } };

test("whole-stage rerun starts a new DBOS attempt from artifact ancestry without an app-owned continuation plan", async () => {
  let started: { readonly workflow_id: string; readonly resume_from_stage?: string } | null = null;
  let insertedRoot: string | null = null;
  let supersededRoot: string | null = null;
  const operations: string[] = [];
  const dependencies = {
    runs: { async find_by_id() { return { id: runId, workflow_definition_id: definition.id, context: { project: "oakridge" }, archived: false }; }, async insert_launch() {} },
    definitions: { async find_by_id() { return definition; } },
    attempts: { async list_for_run() { return [{ root_workflow_id: "root-1", run_id: runId, forked_from_root_workflow_id: null, created_at: "2026-08-14T00:00:00Z" }]; },
      async find_by_root_workflow_id() { return null; }, async insert(attempt: WorkflowAttempt) { operations.push("insert"); insertedRoot = attempt.root_workflow_id; } },
    dbos: { async start_run(workflow_id: string, input: RunWorkflowInput) { operations.push("start"); started = { workflow_id, resume_from_stage: input.resume_from_stage }; } },
    now: () => "2026-08-14T01:00:00Z",
    supersede_attempt: async (root: string) => { operations.push("supersede"); supersededRoot = root; },
  } as unknown as StageRerunDependencies;
  const rerun = await rerunStage({ run_id: runId, stage_key: "build", rerun_id: "command-1" }, dependencies);
  if (!rerun.ok) throw new Error(rerun.error.kind);
  const result = rerun.value;
  expect(result.root_workflow_id).toBe("oakridge-stage-rerun:run-1:build:command-1");
  expect(started as { readonly workflow_id: string; readonly resume_from_stage?: string } | null).toEqual({ workflow_id: result.root_workflow_id, resume_from_stage: "build" });
  expect(insertedRoot as string | null).toBe(result.root_workflow_id);
  expect(supersededRoot as string | null).toBe("root-1");
  expect(operations).toEqual(["supersede", "start", "insert"]);
});

test("whole-stage rerun is idempotent by the derived DBOS root identity", async () => {
  let starts = 0;
  const root = "oakridge-stage-rerun:run-1:build:command-1";
  const dependencies = { runs: { async find_by_id() { return { id: runId, workflow_definition_id: definition.id, context: {}, archived: false }; } },
    definitions: { async find_by_id() { return definition; } }, attempts: {
      async list_for_run() { return [{ root_workflow_id: "root-1", run_id: runId, forked_from_root_workflow_id: null, created_at: "2026-08-14T00:00:00Z" }]; },
      async find_by_root_workflow_id() { return { root_workflow_id: root, run_id: runId, forked_from_root_workflow_id: "root-1", created_at: "2026-08-14T01:00:00Z" }; }, async insert() {} },
    dbos: { async start_run() { starts += 1; } }, now: () => "unused", supersede_attempt: async () => {} } as unknown as StageRerunDependencies;
  expect(await rerunStage({ run_id: runId, stage_key: "build", rerun_id: "command-1" }, dependencies)).toEqual({ ok: true, value: { root_workflow_id: root } });
  expect(starts).toBe(0);
});
