import { describe, expect, it } from "vitest";

import type { CreateRunRequest, RepositoryKey } from "../types";
import { selectRequestIdentity } from "./request-identity";

const launchRequest = (notes: string): CreateRunRequest => ({
  workflow_def_id: "definition-1", project_id: null,
  context: {
    brief_notes: notes, repositories: [{ key: "repo" as RepositoryKey, path: "/repo", integration_branch: "main" }], worktree_path: "/repo",
    base_branch: "epic/x", oakridge_url: "http://oakridge", planner_runtime: "claude-code", planner_model: "sonnet", planner_effort: null,
    worker_runtime: "claude-code", worker_model: "sonnet", worker_effort: null,
  },
  epic_profile: {
    title: "Build it", slug: "build-it", final_merge_policy: "guarded",
    repositories: [{ repository_key: "repo" as RepositoryKey, repository_path: "/repo", integration_branch: "main", forge_repository: { provider: "github", owner: "acme", name: "repo" } }],
  },
});

describe("request identity", () => {
  it("retains one identity when the same request is retried after an unknown response", () => {
    const first = selectRequestIdentity(null, "thread-1", () => "ping-1");
    expect(selectRequestIdentity(first, "thread-1", () => "ping-2")).toBe(first);
  });

  it("creates a different identity for a different request", () => {
    const first = selectRequestIdentity(null, "thread-1", () => "ping-1");
    expect(selectRequestIdentity(first, "thread-2", () => "ping-2").idempotency_key).toBe("ping-2");
  });

  it("treats a whole run-launch body as the identity, so an unchanged resubmission replays", () => {
    let sequence = 0;
    const first = selectRequestIdentity(null, JSON.stringify(launchRequest("Build it")), () => `launch-${++sequence}`);
    const retry = selectRequestIdentity(first, JSON.stringify(launchRequest("Build it")), () => `launch-${++sequence}`);
    expect(retry).toBe(first);
  });

  it("mints a new key once the operator edits the run they are launching", () => {
    let sequence = 0;
    const first = selectRequestIdentity(null, JSON.stringify(launchRequest("Build it")), () => `launch-${++sequence}`);
    const changed = selectRequestIdentity(first, JSON.stringify(launchRequest("Build it differently")), () => `launch-${++sequence}`);
    expect(changed.idempotency_key).toBe("launch-2");
  });

  it("keys admission retries by stage and unit, so two units never share a key", () => {
    const foundation = selectRequestIdentity(null, "stage-1:foundation", () => "admit-1");
    const web = selectRequestIdentity(null, "stage-1:web", () => "admit-2");
    expect(foundation.idempotency_key).not.toBe(web.idempotency_key);
  });
});
