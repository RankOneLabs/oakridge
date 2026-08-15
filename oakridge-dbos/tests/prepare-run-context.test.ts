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
  expect(prepareRunContext({ caller_context: { workdir: "/override", brief_notes: "ship it" }, project, epic_profile: null })).toEqual({
    ok: true,
    value: { project: { id: project.id, name: project.name, repo_dir: project.repo_dir }, workdir: "/override", brief_notes: "ship it" },
  });
});

test("epic configuration derives repository context without coupling it to execution", () => {
  const result = prepareRunContext({ caller_context: {}, project: null, epic_profile: {
    title: "Epic", slug: "safe-artifacts", final_merge_policy: "guarded",
    repositories: [{ repository_key: "oakridge", repository_path: "/codes/oakridge", base_branch: "main", epic_branch: null, forge_repository: null }],
  } });
  expect(result).toEqual({ ok: true, value: { repositories: [{ key: "oakridge", path: "/codes/oakridge", base_branch: "main", epic_branch: "epic/safe-artifacts" }] } });
});

test("project or Epic enrichment rejects a non-object caller context", () => {
  expect(prepareRunContext({ caller_context: [], project, epic_profile: null })).toEqual({
    ok: false,
    error: { operation: "prepare_run_context", detail: "context must be a JSON object when project or epic profile configuration is present" },
  });
});

test("Epic profile construction owns domain defaults independently of execution", () => {
  const profile = createEpicProfile({
    id: "00000000-0000-0000-0000-000000000002" as EpicWorkflowProfileId,
    workflow_run_id: "00000000-0000-0000-0000-000000000003" as WorkflowRunId,
    created_at: "2026-08-15T01:00:00Z",
    config: { title: "Epic", slug: "safe-artifacts", final_merge_policy: "guarded", repositories: [
      { repository_key: "oakridge", repository_path: "/codes/oakridge", base_branch: "main", epic_branch: null, forge_repository: null },
    ] },
  });
  expect(profile).toEqual(expect.objectContaining({ lifecycle_state: "active", repositories: [expect.objectContaining({ epic_branch: "epic/safe-artifacts", final_pull_request: null, final_merge_state: "pending" })] }));
});
