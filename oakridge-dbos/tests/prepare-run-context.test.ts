import { expect, test } from "bun:test";

import type { ProjectId } from "../src/domain/primitives";
import { prepareRunContext } from "../src/runtime/prepare-run-context";

const project = {
  id: "00000000-0000-0000-0000-000000000001" as ProjectId,
  name: "Oakridge",
  repo_dir: "/codes/oakridge",
  created_at: "2026-08-15T00:00:00Z",
  forge_repository: null,
  integration_branch: null,
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
  expect(result).toEqual({ title: "Epic", slug: "safe-artifacts", final_merge_policy: "guarded",
    base_branch: "epic/safe-artifacts",
    repositories: [{ key: "oakridge", path: "/codes/oakridge", integration_branch: "main", forge_repository: null }] });
});

// A non-object caller context used to be refused here, and only when a project
// or epic profile happened to be configured. It is refused by the request schema
// now, for every launch — see launch-run.test.ts.
test("a context with no project and no epic profile passes through untouched", () => {
  const caller = { brief_notes: "ship it", oakridge_url: "http://oakridge" };
  expect(prepareRunContext({ caller_context: caller, project: null, epic_profile: null })).toEqual(caller);
});

/**
 * Epic configuration is folded into the run context rather than persisted as a
 * profile row: v15 has no `epic_workflow_profile`, and every field of it is read
 * from the context every other stage already reads. `forge_repository` and
 * `final_merge_policy` are the two that had nowhere else to go.
 */
test("epic configuration becomes run context, forge identity and merge policy included", () => {
  const context = prepareRunContext({ caller_context: {}, project: null, epic_profile: {
    title: "Epic", slug: "safe-artifacts", final_merge_policy: "external_confirmation", base_branch: null,
    repositories: [{ repository_key: "oakridge", repository_path: "/codes/oakridge", integration_branch: "main",
      forge_repository: { provider: "github", owner: "RankOneLabs", name: "oakridge" } }],
  } });
  expect(context).toEqual({
    title: "Epic", slug: "safe-artifacts", final_merge_policy: "external_confirmation",
    base_branch: "epic/safe-artifacts",
    repositories: [{ key: "oakridge", path: "/codes/oakridge", integration_branch: "main",
      forge_repository: { provider: "github", owner: "RankOneLabs", name: "oakridge" } }],
  });
});

test("a repository with no configured forge carries a null identity rather than an absent key", () => {
  const context = prepareRunContext({ caller_context: {}, project: null, epic_profile: {
    title: "Epic", slug: "safe-artifacts", final_merge_policy: "guarded", base_branch: "epic/custom",
    repositories: [{ repository_key: "oakridge", repository_path: "/codes/oakridge", integration_branch: "main", forge_repository: null }],
  } });
  expect(context.base_branch).toBe("epic/custom");
  expect(context.repositories).toEqual([{ key: "oakridge", path: "/codes/oakridge", integration_branch: "main", forge_repository: null }]);
});
