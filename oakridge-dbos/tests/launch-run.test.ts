import { expect, test } from "bun:test";

import type { ProjectId, WorkflowDefinitionId } from "../src/domain/primitives";
import type { WorkflowDefinition } from "../src/domain/workflow";
import type { PersistWorkflowRunLaunch } from "../src/domain/runs";
import { createRunLaunchApp } from "../src/http/run-launch";
import { deterministicRunId, launchRun, type LaunchRunDependencies } from "../src/runtime/launch-run";
import { dispatchRunLaunches } from "../src/runtime/run-launch-notifications";
import type { WorkflowRunRepository } from "../src/storage/repositories";

// A definition that reads the context, because a definition that reads nothing
// cannot show whether the launch gate checks anything.
const graph = { stages: { analyze: { stage_type: "delegated_session", operator_role: null, inputs: [], outputs: [],
  config: { runtime: { from: "context", path: "/planner_runtime" }, effort: { from: "context", path: "/planner_effort" },
    slot_bindings: { NOTES: { from: "context", path: "/brief_notes" }, URL: { from: "context", path: "/oakridge_url" } } } } }, edges: [] };
const definition = { id: "ef2b47a4-d1bd-44ee-840a-e4f7b27570db" as WorkflowDefinitionId, name: "flow", version: 11,
  graph, archived: false, created_at: "2026-08-15T00:00:00Z" } as unknown as WorkflowDefinition;
const project = { id: "af2b47a4-d1bd-44ee-840a-e4f7b27570db" as ProjectId, name: "Oakridge", repo_dir: "/workspace/oakridge",
  forge_repository: null, base_branch: null, created_at: "2026-08-15T00:00:00Z" };
// `planner_effort: null` is what the launcher sends for "the runtime's default".
const context = { brief_notes: "Replace orchestration", oakridge_url: "http://oakridge", planner_runtime: "claude-code", planner_effort: null };
const body = { workflow_def_id: definition.id, project_id: project.id, context, epic_profile: null };

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
  return { app: createRunLaunchApp(dependencies), dependencies, stored: () => stored, dispatches: () => dispatches };
};

const request = (app: ReturnType<typeof createRunLaunchApp>, value: unknown = body) => app.request("/workflow_runs", {
  method: "POST", headers: { "content-type": "application/json", "idempotency-key": "launch-1" }, body: JSON.stringify(value),
});

test("workflow run POST persists, dispatches, and returns the operator RunSummary", async () => {
  const subject = mountedFixture();
  const response = await request(subject.app);
  expect(response.status).toBe(201);
  expect(await response.json()).toEqual(expect.objectContaining({ id: deterministicRunId("launch-1"), workflow_name: "flow", status: "running" }));
  expect(subject.stored()).toEqual(expect.objectContaining({ workflow_definition_version: 11, application_version: "pr2",
    run: expect.objectContaining({ project_id: project.id, context: expect.objectContaining({ workdir: project.repo_dir }) }) }));
  expect(subject.dispatches()).toBe(1);
});

test("workflow run POST replays the same idempotent launch without a second logical run", async () => {
  const subject = mountedFixture();
  expect((await request(subject.app)).status).toBe(201);
  const replay = await request(subject.app);
  expect(replay.status).toBe(201);
  expect((await replay.json()).id).toBe(deterministicRunId("launch-1"));
  expect(subject.dispatches()).toBe(2);
});

test("workflow run POST reports an immutable replay conflict", async () => {
  const subject = mountedFixture();
  expect((await request(subject.app)).status).toBe(201);
  const conflict = await request(subject.app, { ...body, context: { ...context, brief_notes: "different" } });
  expect(conflict.status).toBe(409);
  expect(await conflict.json()).toEqual({ error: "conflicting replay", code: "idempotency_conflict" });
});

test("workflow run POST blocks an archived definition before persistence", async () => {
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
  const count = await dispatchRunLaunches(repository, { async start_v2_run(request) { calls.push(`dbos:${request.workflow_id}:${request.run_id}:${request.application_version}`); return { ok: true, value: undefined }; } }, () => "2026-08-15T00:00:00Z");
  expect(count).toBe(1);
  expect(calls).toEqual(["claim", `dbos:root-1:${command.run_id}:pr2`, "delivered"]);
});

test("v2 launch dispatcher addresses only the run-record workflow", async () => {
  const calls: string[] = [];
  const command = { kind: "launch_run" as const, run_id: deterministicRunId("v2-launch"), workflow_definition_id: definition.id,
    workflow_definition_version: definition.version, root_workflow_id: `v2-run:${deterministicRunId("v2-launch")}`, context: {}, created_at: "2026-08-15T00:00:00Z", application_version: "v2" };
  let claims = 0;
  const repository = { async claim_pending_launches() { claims += 1; return claims === 1 ? [{ id: "outbox-v2", target_workflow_id: command.root_workflow_id, command, idempotency_key: "v2" }] : []; },
    async mark_launch_delivered() { calls.push("delivered"); }, async mark_launch_failed() { calls.push("failed"); } } as unknown as WorkflowRunRepository;
  expect(await dispatchRunLaunches(repository, { async start_v2_run(request) { calls.push(`${request.workflow_id}:${request.run_id}:${request.application_version}`); return { ok: true, value: undefined }; } })).toBe(1);
  expect(calls).toEqual([`${command.root_workflow_id}:${command.run_id}:v2`, "delivered"]);
});

test("v2 launch identity cannot collide with a legacy root history", async () => {
  const subject = mountedFixture();
  const launched = await launchRun({ ...body, idempotency_key: "launch-1" }, subject.dependencies);
  expect(launched.ok).toBe(true);
  expect(subject.stored()?.run.root_workflow_id).toBe(`v2-run:${deterministicRunId("launch-1")}`);
});

const epicBody = {
  ...body,
  epic_profile: {
    title: "Tiers page", slug: "tiers-page", final_merge_policy: "guarded" as const,
    repositories: [{ repository_key: "pipefitter", repository_path: "/repos/pipefitter", integration_branch: "main" }],
  },
};

/**
 * Launch does not inspect the repositories any more.
 *
 * It used to refuse a run whose epic branch did not exist yet — the only thing
 * it could do, since nothing created one. The `provision_repository_refs` stage
 * creates it now, and it is the build stage's declared input, so a repository
 * that cannot supply it fails as a stage outcome the operator can see and
 * retry. Refusing at launch as well would give one requirement two owners, and
 * the owner that can only say no is the one that runs first.
 */
test("a launch declaring repositories proceeds without checking their branches", async () => {
  const subject = mountedFixture();
  const response = await request(subject.app, epicBody);
  expect(response.status).toBe(201);
  expect(subject.stored()?.run.context).toEqual(expect.objectContaining({
    // One base branch for the epic, defaulted from its slug, beside the
    // repositories rather than repeated inside each of them.
    base_branch: "epic/tiers-page",
    repositories: [{ key: "pipefitter", path: "/repos/pipefitter", integration_branch: "main" }],
  }));
  expect(subject.dispatches()).toBe(1);
});

/**
 * The launch gate, which is the whole point of naming what a definition reads.
 *
 * A context missing a key the definition dereferences used to be accepted: the
 * run started, stages ran, and the one holding the pointer failed with
 * `context pointer '/oakridge_url' not found` — one missing key per run,
 * discovered in flight. The refusal names all of them at once, before anything
 * has started.
 */
test("a launch whose context the definition cannot read is refused, naming every missing pointer", async () => {
  const subject = mountedFixture();
  const response = await request(subject.app, { ...body, context: { brief_notes: "only the notes" } });
  expect(response.status).toBe(400);
  const failure = await response.json() as { readonly error: string; readonly code: string };
  expect(failure.code).toBe("context_requirements_unmet");
  expect(failure.error).toContain("/planner_runtime (analyze)");
  expect(failure.error).toContain("/oakridge_url (analyze)");
  expect(failure.error).toContain("'flow' v11");
  // Refused means refused: nothing was persisted and nothing was dispatched.
  expect(subject.stored()).toBeNull();
  expect(subject.dispatches()).toBe(0);
});

test("a context carrying keys no stage reads is still launched", async () => {
  const subject = mountedFixture();
  const response = await request(subject.app, { ...body, context: { ...context, some_authored_key: { nested: true } } });
  expect(response.status).toBe(201);
  expect(subject.stored()?.run.context).toEqual(expect.objectContaining({ some_authored_key: { nested: true } }));
});

/**
 * Moved here from `prepareRunContext`, which could only refuse a non-object when
 * a project or epic profile happened to be configured — so the same bad context
 * sailed through a plain launch.
 */
test("a context that is not a JSON object is refused before anything reads it", async () => {
  const subject = mountedFixture();
  for (const notAnObject of [[], "context", 42, null]) {
    const response = await request(subject.app, { ...body, context: notAnObject });
    expect(response.status).toBe(400);
  }
  expect(subject.stored()).toBeNull();
});

test("a runtime the executor could never run is refused at the request, naming the field", async () => {
  const subject = mountedFixture();
  const response = await request(subject.app, { ...body, context: { ...context, planner_runtime: "gpt-5" } });
  expect(response.status).toBe(400);
  expect((await response.json() as { readonly error: string }).error).toContain("context.planner_runtime");
});

/**
 * `planner_effort: null` means "the runtime's default" and the binding resolver
 * accepts it, so the launch gate must too — a presence test, not a truthiness
 * one.
 */
test("a null value satisfies the pointer that reads it", async () => {
  const subject = mountedFixture();
  expect((await request(subject.app)).status).toBe(201);
  expect(subject.stored()?.run.context).toEqual(expect.objectContaining({ planner_effort: null }));
});

test("dropping that null key entirely is a different thing, and is refused", async () => {
  const subject = mountedFixture();
  const { planner_effort: _omitted, ...withoutEffort } = context;
  const response = await request(subject.app, { ...body, context: withoutEffort });
  expect(response.status).toBe(400);
  expect((await response.json() as { readonly error: string }).error).toContain("/planner_effort (analyze)");
});

/**
 * The launch gate checks that a pointer *resolves*, and `null` resolves — that
 * is deliberate, because `planner_effort: null` means the runtime's default.
 * A branch name has no such reading: `base_branch: null` satisfied the gate and
 * reached the `git push` that creates the branch, which then made one literally
 * named "null". So the key is named at the boundary and typed there.
 */
test("a base branch that is not a branch name is refused at the request", async () => {
  const subject = mountedFixture();
  for (const notABranch of [null, 42, { name: "epic/x" }, ""]) {
    const response = await request(subject.app, { ...body, context: { ...context, base_branch: notABranch } });
    expect(response.status).toBe(400);
    expect((await response.json() as { readonly error: string }).error).toContain("context.base_branch");
  }
  expect(subject.stored()).toBeNull();
});

test("a base branch that is a branch name is launched", async () => {
  const subject = mountedFixture();
  const response = await request(subject.app, { ...body, context: { ...context, base_branch: "epic/tiers-page" } });
  expect(response.status).toBe(201);
  expect(subject.stored()?.run.context).toEqual(expect.objectContaining({ base_branch: "epic/tiers-page" }));
});

test("a padded base branch is refused at the request too, not only at the stage", async () => {
  const subject = mountedFixture();
  const response = await request(subject.app, { ...body, context: { ...context, base_branch: " epic/tiers-page " } });
  expect(response.status).toBe(400);
  expect((await response.json() as { readonly error: string }).error).toContain("leading or trailing whitespace");
});
