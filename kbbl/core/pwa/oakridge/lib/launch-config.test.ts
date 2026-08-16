import { describe, expect, it } from "vitest";

import { buildEpicProfile, buildRunExecutionContext } from "./launch-config";
import type { RepositoryKey } from "../types";

describe("buildEpicProfile", () => {
  it("builds the durable forge repository contract expected by CreateWorkflowRun", () => {
    expect(buildEpicProfile(" Full parity! ", "guarded", [{
      key: "oakridge" as RepositoryKey,
      path: "/code/oakridge",
      forge_owner: "acme",
      forge_name: "oakridge",
      base_branch: "main",
    }])).toEqual({
      title: "Full parity!",
      slug: "full-parity",
      final_merge_policy: "guarded",
      repositories: [{
        repository_key: "oakridge",
        repository_path: "/code/oakridge",
        base_branch: "main",
        forge_repository: { provider: "github", owner: "acme", name: "oakridge" },
      }],
    });
  });

  it("rejects a title that cannot produce a durable slug", () => {
    expect(buildEpicProfile("!!!", "guarded", [])).toBeNull();
  });

  it("preserves external confirmation as an explicit operator choice", () => {
    const profile = buildEpicProfile("External integration", "external_confirmation", [{
      key: "oakridge" as RepositoryKey,
      path: "/code/oakridge",
      forge_owner: "acme",
      forge_name: "oakridge",
      base_branch: "main",
    }]);
    expect(profile?.final_merge_policy).toBe("external_confirmation");
  });
});

describe("buildRunExecutionContext", () => {
  it("preserves default runtime effort as explicit null context bindings", () => {
    expect(buildRunExecutionContext({
      brief_notes: "Build it",
      repositories: [{ key: "oakridge" as RepositoryKey, path: "/code/oakridge" }],
      oakridge_url: "http://oakridge",
      planner: { runtime: "claude-code", model: "opus" },
      worker: { runtime: "claude-code", model: "sonnet" },
    })).toEqual({ ok: true, value: expect.objectContaining({ planner_effort: null, worker_effort: null }) });
  });

  it("rejects an empty repository list instead of creating an empty worktree path", () => {
    expect(buildRunExecutionContext({
      brief_notes: "Build it",
      repositories: [],
      oakridge_url: "http://oakridge",
      planner: { runtime: "claude-code", model: "opus" },
      worker: { runtime: "claude-code", model: "sonnet" },
    })).toEqual({
      ok: false,
      error: { operation: "build_run_execution_context", detail: "At least one repository with a worktree path is required." },
    });
  });
});
