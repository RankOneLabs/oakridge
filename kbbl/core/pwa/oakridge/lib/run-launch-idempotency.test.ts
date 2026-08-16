import { describe, expect, it } from "vitest";

import type { CreateRunRequest, RepositoryKey } from "../types";
import { selectRunLaunchIdentity } from "./run-launch-idempotency";

const request = (notes: string): CreateRunRequest => ({
  workflow_def_id: "definition-1", project_id: null,
  context: {
    brief_notes: notes, repositories: [{ key: "repo" as RepositoryKey, path: "/repo" }], worktree_path: "/repo",
    oakridge_url: "http://oakridge", planner_runtime: "claude-code", planner_model: "sonnet", planner_effort: null,
    worker_runtime: "claude-code", worker_model: "sonnet", worker_effort: null,
  },
  epic_profile: {
    title: "Build it", slug: "build-it", final_merge_policy: "guarded",
    repositories: [{ repository_key: "repo" as RepositoryKey, repository_path: "/repo", base_branch: "main", forge_repository: { provider: "github", owner: "acme", name: "repo" } }],
  },
});

describe("run launch idempotency", () => {
  it("reuses one identity for an unchanged submission after an unknown response", () => {
    let sequence = 0;
    const first = selectRunLaunchIdentity(null, request("Build it"), () => `launch-${++sequence}`);
    const retry = selectRunLaunchIdentity(first, request("Build it"), () => `launch-${++sequence}`);
    expect(retry).toBe(first);
  });

  it("creates a new identity when the operator changes the submission", () => {
    let sequence = 0;
    const first = selectRunLaunchIdentity(null, request("Build it"), () => `launch-${++sequence}`);
    const changed = selectRunLaunchIdentity(first, request("Build it differently"), () => `launch-${++sequence}`);
    expect(changed.idempotency_key).toBe("launch-2");
  });
});
