import { expect, test } from "bun:test";

import type { ProjectId, WorkflowDefinitionId } from "../src/domain/primitives";
import type { WorkflowDefinition } from "../src/domain/workflow";
import type { PersistWorkflowRunLaunch } from "../src/domain/runs";
import { createRunLaunchApp } from "../src/http/run-launch";
import { deterministicRunId, type LaunchRunDependencies } from "../src/runtime/launch-run";
import { dispatchRunLaunches } from "../src/runtime/run-launch-notifications";
import type { WorkflowRunRepository } from "../src/storage/repositories";

const definition = { id: "ef2b47a4-d1bd-44ee-840a-e4f7b27570db" as WorkflowDefinitionId, name: "flow", version: 11,
  graph: { stages: {}, edges: [] }, archived: false, created_at: "2026-08-15T00:00:00Z" } as WorkflowDefinition;
const project = { id: "af2b47a4-d1bd-44ee-840a-e4f7b27570db" as ProjectId, name: "Oakridge", repo_dir: "/workspace/oakridge",
  forge_repository: null, base_branch: null, created_at: "2026-08-15T00:00:00Z" };
const body = { workflow_def_id: definition.id, project_id: project.id, context: { brief_notes: "Replace orchestration" }, epic_profile: null };

const mountedFixture = (options: { readonly archived?: boolean } = {}) => {
  let stored: PersistWorkflowRunLaunch | null = null;
  let dispatches = 0;
  const summary = { id: deterministicRunId("launch-1"), workflow_name: "flow", status: "running" as const,
    current_attempt_root_workflow_id: "root", current_stage: null, parked_count: 0, updated_at: "2026-08-15T00:00:00Z",
    is_stuck: false, is_failed: false, archived: false };
  const dependencies = {
    definitions: { async find_by_id() { return { ...definition, archived: options.archived ?? false }; } },
    projects: { async find_by_id() { return project; } },
    runs: {
      async find_launch_by_id() { return stored?.run ?? null; },
      async create_with_initial_attempt(input: PersistWorkflowRunLaunch) {
        if (!stored) { stored = input; return { ok: true as const, value: { kind: "created" as const, run: input.run, epic_profile: input.epic_profile } }; }
        const matches = JSON.stringify(stored) === JSON.stringify(input);
        return matches
          ? { ok: true as const, value: { kind: "replayed" as const, run: input.run, epic_profile: input.epic_profile } }
          : { ok: false as const, error: { operation: "create_workflow_run" as const, kind: "idempotency_conflict" as const, detail: "conflicting replay" } };
      },
    },
    projections: { async list_runs() { return [{ ...summary, id: stored?.run.id ?? summary.id }]; } },
    async dispatch_launches() { dispatches += 1; return 1; },
    application_version: "pr2", now: () => "2026-08-15T00:00:00Z",
  } as unknown as LaunchRunDependencies;
  return { app: createRunLaunchApp(dependencies), stored: () => stored, dispatches: () => dispatches };
};

const request = (app: ReturnType<typeof createRunLaunchApp>, value: unknown = body) => app.request("/workflow_runs", {
  method: "POST", headers: { "content-type": "application/json", "idempotency-key": "launch-1" }, body: JSON.stringify(value),
});

test("compatible workflow run POST persists, dispatches, and returns the operator RunSummary", async () => {
  const subject = mountedFixture();
  const response = await request(subject.app);
  expect(response.status).toBe(201);
  expect(await response.json()).toEqual(expect.objectContaining({ id: deterministicRunId("launch-1"), workflow_name: "flow", status: "running" }));
  expect(subject.stored()).toEqual(expect.objectContaining({ workflow_definition_version: 11, application_version: "pr2",
    run: expect.objectContaining({ project_id: project.id, context: expect.objectContaining({ workdir: project.repo_dir }) }) }));
  expect(subject.dispatches()).toBe(1);
});

test("compatible workflow run POST replays the same idempotent launch without a second logical run", async () => {
  const subject = mountedFixture();
  expect((await request(subject.app)).status).toBe(201);
  const replay = await request(subject.app);
  expect(replay.status).toBe(201);
  expect((await replay.json()).id).toBe(deterministicRunId("launch-1"));
  expect(subject.dispatches()).toBe(2);
});

test("compatible workflow run POST reports an immutable replay conflict", async () => {
  const subject = mountedFixture();
  expect((await request(subject.app)).status).toBe(201);
  const conflict = await request(subject.app, { ...body, context: { brief_notes: "different" } });
  expect(conflict.status).toBe(409);
  expect(await conflict.json()).toEqual({ error: "conflicting replay", code: "idempotency_conflict" });
});

test("compatible workflow run POST blocks an archived definition before persistence", async () => {
  const subject = mountedFixture({ archived: true });
  const response = await request(subject.app);
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual(expect.objectContaining({ code: "definition_archived" }));
  expect(subject.stored()).toBeNull();
});

test("run launch outbox worker starts DBOS before acknowledging its lease", async () => {
  const calls: string[] = [];
  const command = { kind: "launch_run" as const, run_id: deterministicRunId("launch-1"), workflow_definition_id: definition.id,
    workflow_definition_version: definition.version, root_workflow_id: "root-1", context: {}, created_at: "2026-08-15T00:00:00Z", application_version: "pr2" };
  const repository = {
    async claim_pending_launches() { calls.push("claim"); return [{ id: "outbox-1", target_workflow_id: "root-1", command, idempotency_key: "launch" }]; },
    async mark_launch_delivered() { calls.push("delivered"); }, async mark_launch_failed() { calls.push("failed"); },
  } as unknown as WorkflowRunRepository;
  let claims = 0;
  repository.claim_pending_launches = async () => { claims += 1; calls.push("claim"); return claims === 1 ? [{ id: "outbox-1", target_workflow_id: "root-1", command, idempotency_key: "launch" }] : []; };
  const count = await dispatchRunLaunches(repository, { async start_run(id, input, version) { calls.push(`dbos:${id}:${input.workflow_definition_version}:${version}`); } }, () => "2026-08-15T00:00:00Z");
  expect(count).toBe(1);
  expect(calls).toEqual(["claim", "dbos:root-1:11:pr2", "delivered"]);
});
