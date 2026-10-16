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
      integration_branch: "main",
    }])).toEqual({
      title: "Full parity!",
      slug: "full-parity",
      final_merge_policy: "guarded",
      repositories: [{
        repository_key: "oakridge",
        repository_path: "/code/oakridge",
        integration_branch: "main",
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
      integration_branch: "main",
    }]);
    expect(profile?.final_merge_policy).toBe("external_confirmation");
  });
});

describe("buildRunExecutionContext", () => {
  it("preserves the exact agent worker settings in the context", () => {
    expect(buildRunExecutionContext({
      brief_notes: "Build it",
      base_branch: "epic/build-it",
      repositories: [{ key: "oakridge" as RepositoryKey, path: "/code/oakridge", integration_branch: "main" }],
      oakridge_url: "http://oakridge",
      session_settings: { cohort: { assessor: { harness: "claude-code", model: "opus", effort: null },
        builder: { harness: "codex", model: "gpt-6-sol", effort: "high" } } },
    })).toEqual({ ok: true, value: expect.objectContaining({ session_settings: {
      cohort: { assessor: { harness: "claude-code", model: "opus", effort: null },
        builder: { harness: "codex", model: "gpt-6-sol", effort: "high" } },
    } }) });
  });

  it("rejects an empty repository list instead of creating an empty worktree path", () => {
    expect(buildRunExecutionContext({
      brief_notes: "Build it",
      base_branch: "epic/build-it",
      repositories: [],
      oakridge_url: "http://oakridge",
      session_settings: {},
    })).toEqual({
      ok: false,
      error: { operation: "build_run_execution_context", detail: "At least one repository with a worktree path is required." },
    });
  });
});
