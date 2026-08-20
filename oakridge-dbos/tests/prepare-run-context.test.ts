import { expect, test } from "bun:test";

import type { EpicWorkflowProfileId } from "../src/domain/epic";
import type { ProjectId, WorkflowRunId } from "../src/domain/primitives";
import { createEpicProfile, prepareRunContext } from "../src/runtime/prepare-run-context";

const project = {
  id: "00000000-0000-0000-0000-000000000001" as ProjectId,
  name: "Oakridge",
  repo_dir: "/codes/oakridge",
  created_at: "2026-08-15T00:00:00Z",
  forge_repository: null,
  base_branch: null,
};

test("project context is injected before caller keys override it", () => {
  expect(prepareRunContext({ caller_context: { workdir: "/override", brief_notes: "ship it" }, project, epic_profile: null })).toEqual(
    { project: { id: project.id, name: project.name, repo_dir: project.repo_dir }, workdir: "/override", brief_notes: "ship it" },
  );
});

test("epic configuration derives repository context without coupling it to execution", () => {
  const result = prepareRunContext({ caller_context: {}, project: null, epic_profile: {
    title: "Epic", slug: "safe-artifacts", final_merge_policy: "guarded",
    base_branch: null,
    repositories: [{ repository_key: "oakridge", repository_path: "/codes/oakridge", integration_branch: "main", forge_repository: null }],
  } });
  expect(result).toEqual({ base_branch: "epic/safe-artifacts", repositories: [{ key: "oakridge", path: "/codes/oakridge", integration_branch: "main" }] });
});

// A non-object caller context used to be refused here, and only when a project
// or epic profile happened to be configured. It is refused by the request schema
// now, for every launch — see launch-run.test.ts.
test("a context with no project and no epic profile passes through untouched", () => {
  const caller = { brief_notes: "ship it", oakridge_url: "http://oakridge" };
  expect(prepareRunContext({ caller_context: caller, project: null, epic_profile: null })).toEqual(caller);
});

test("Epic profile construction owns domain defaults independently of execution", () => {
  const profile = createEpicProfile({
    id: "00000000-0000-0000-0000-000000000002" as EpicWorkflowProfileId,
    workflow_run_id: "00000000-0000-0000-0000-000000000003" as WorkflowRunId,
    created_at: "2026-08-15T01:00:00Z",
    config: { title: "Epic", slug: "safe-artifacts", final_merge_policy: "guarded", base_branch: null, repositories: [
      { repository_key: "oakridge", repository_path: "/codes/oakridge", integration_branch: "main", forge_repository: null },
    ] },
  });
  expect(profile).toEqual(expect.objectContaining({ lifecycle_state: "active", base_branch: "epic/safe-artifacts",
    repositories: [expect.objectContaining({ integration_branch: "main", final_pull_request: null, final_merge_state: "pending" })] }));
});
