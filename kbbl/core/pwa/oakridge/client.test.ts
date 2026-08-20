import { afterEach, describe, expect, it, vi } from "vitest";

import { confirmFinalPullRequest, createRun, fetchRun } from "./client";
import { parseRepositoryKey } from "./repository-inputs";
import type { CreateRunRequest, RepositoryKey } from "./types";

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

afterEach(() => vi.restoreAllMocks());

const createRunRequest = (): CreateRunRequest => ({
  workflow_def_id: "definition-1",
  project_id: null,
  context: {
    brief_notes: "Build it", repositories: [{ key: "repo" as RepositoryKey, path: "/repo", integration_branch: "main" }], worktree_path: "/repo",
    base_branch: "epic/x", oakridge_url: "http://oakridge", planner_runtime: "claude-code", planner_model: "sonnet", planner_effort: null,
    worker_runtime: "claude-code", worker_model: "sonnet", worker_effort: null,
  },
  epic_profile: {
    title: "Build it", slug: "build-it", final_merge_policy: "guarded",
    repositories: [{ repository_key: "repo" as RepositoryKey, repository_path: "/repo", integration_branch: "main", forge_repository: { provider: "github", owner: "acme", name: "repo" } }],
  },
});

describe("Oakridge response parsing", () => {
  it("sends the caller-owned run idempotency key", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ id: "run-1" }));
    await createRun(createRunRequest(), "launch-1");
    expect(fetch).toHaveBeenCalledWith("/oakridge/api/workflow_runs", expect.objectContaining({ headers: expect.objectContaining({ "Idempotency-Key": "launch-1" }) }));
  });

  it("reports contextual parse failures instead of leaking transform exceptions", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json({
      id: "run-1",
      workflow_name: "legacy",
      status: "running",
      stages: [{
        stage_instance_id: "stage-1",
        name: "build",
        type: "delegated_session",
        status: "pending",
        artifacts: [],
        delegated_kbbl_sid: null,
        worktree: null,
        units: [{ unit_id: "api", repository_key: "  ", sid: null, worktree: null, status: "pending", gate: null }],
      }],
      parked_count: 0,
      updated_at: "2026-08-08T00:00:00Z",
      is_stuck: false,
    }));

    await expect(fetchRun("run-1")).rejects.toThrow("oakridge /runs/run-1: parse repository key");
  });

  it("rejects unknown final reconciliation outcomes at the API boundary", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ outcome: "surprise", profile: {} }));
    const repositoryKey = parseRepositoryKey("oakridge");
    if (!repositoryKey) throw new Error("test repository key should be valid");

    await expect(confirmFinalPullRequest("run-1", repositoryKey, { idempotency_key: "confirm-1" }))
      .rejects.toThrow("response contained an unknown outcome");
  });
});
