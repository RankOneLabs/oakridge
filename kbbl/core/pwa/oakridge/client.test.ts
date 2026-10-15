import { afterEach, describe, expect, it, vi } from "vitest";
import sample from "./__fixtures__/v2-adapter-sample.json";
import { createRun, fetchArtifact, fetchReviewInbox, fetchRun, fetchRuns, invalidateCachedRunUnits, refreshReviewInboxRun, resumeGate } from "./client";
import { compositeId } from "./adapters/core";
import type { CreateRunRequest, RepositoryKey } from "./types";

const runId = sample.run.run_id;
const cohort = sample.units[1];
const json = (body: unknown): Response => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
const calls = (respond: (path: string, init?: RequestInit) => unknown) => vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
  const body = respond(String(input), init);
  if (body instanceof Response) return body;
  return json(body);
});
afterEach(() => { vi.restoreAllMocks(); invalidateCachedRunUnits(null); });

const createRunRequest = (): CreateRunRequest => ({
  workflow_def_id: "development-v2", project_id: null,
  context: { brief_notes: "Build it", repositories: [{ key: "api" as RepositoryKey, path: "/repo", integration_branch: "main" }],
    worktree_path: "/repo", base_branch: "epic/x", oakridge_url: "http://oakridge", planner_runtime: "claude-code",
    planner_model: "sonnet", planner_effort: null, worker_runtime: "claude-code", worker_model: "sonnet", worker_effort: null },
  epic_profile: { title: "Build it", slug: "build-it", final_merge_policy: "guarded",
    repositories: [{ repository_key: "api" as RepositoryKey, repository_path: "/repo", integration_branch: "main",
      forge_repository: { provider: "github", owner: "acme", name: "api" } }] },
});

describe("v2 Oakridge client", () => {
  it("shares parked status between list and detail", async () => {
    calls((path) => path.includes("/units") ? sample.units : path.includes("/api/runs?") ? { items: [sample.run], next_cursor: null } : sample.run);
    const list = await fetchRuns();
    const detail = await fetchRun(runId);
    expect([list[0].status, detail.status]).toEqual(["parked", "parked"]);
  });

  it("launches with the definition digest and all six stage roles, then reads back", async () => {
    const fetch = calls((path) => path.includes("/api/definitions") ? { items: [{ bundle_id: "development-v2", digest: "sha256:development" }], next_cursor: null }
      : path.endsWith("/api/runs") ? { kind: "committed", run_id: runId, event_id: "event-2" }
      : path.includes("/units") ? sample.units : sample.run);
    const result = await createRun(createRunRequest(), "launch-1");
    const launch = fetch.mock.calls.find(([path]) => String(path).endsWith("/api/runs"));
    const body = JSON.parse(String(launch?.[1]?.body));
    expect([result.id, body.request_id, body.digest, Object.keys(body.config.sessions).sort()]).toEqual([
      runId, "launch-1", "sha256:development", ["analysis", "brief", "cohort", "integration", "planning", "prepare"],
    ]);
  });

  it("opens an artifact through its self-describing id with no snapshot read", async () => {
    const fetch = calls((path) => { expect(path).toContain(`/api/runs/${runId}/units/${cohort.unit_id}/artifacts/build_result`); return sample.artifact; });
    const id = compositeId({ kind: "artifact", runId, unitId: cohort.unit_id, name: "build_result:revision-build" });
    expect((await fetchArtifact(id)).component_id).toBe("dev-build-result-viewer");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("sends collected feedback to the decision's declared field and target revision", async () => {
    const fetch = calls((path) => path.endsWith("/decide") ? { kind: "committed", run_id: runId, event_id: "event-3" } : cohort);
    const gateId = compositeId({ kind: "gate", runId, unitId: cohort.unit_id, name: "assessment_review" });
    await resumeGate(gateId, { idempotency_key: "decide-1", artifact_revision_id: "stale", gate_step: "assessment_review",
      action: "request_revision", operator_comment: "", feedback: "Fix the API" });
    const decision = fetch.mock.calls.find(([path]) => String(path).endsWith("/decide"));
    expect(JSON.parse(String(decision?.[1]?.body))).toEqual({ request_id: "decide-1", decision: "request_build_changes",
      target: "revision-build", payload: { feedback: "Fix the API" } });
  });

  it("submits an accept-effect decision without feedback", async () => {
    const fetch = calls((path) => path.endsWith("/decide") ? { kind: "committed", run_id: runId, event_id: "event-4" } : cohort);
    const gateId = compositeId({ kind: "gate", runId, unitId: cohort.unit_id, name: "assessment_review" });
    await resumeGate(gateId, { idempotency_key: "decide-2", artifact_revision_id: "stale", gate_step: "assessment_review",
      action: "accept", operator_comment: "", feedback: "" });
    const decision = fetch.mock.calls.find(([path]) => String(path).endsWith("/decide"));
    expect(JSON.parse(String(decision?.[1]?.body)).payload).toEqual({});
  });

  it("maps replace_pr by its request_changes effect and submits feedback", async () => {
    const replacement = { ...cohort, decisions: [{ key: "replace_pr", label: "Replace PR", payload_schema: "{feedback: text}",
      fields: [{ key: "feedback", label: "Why replace?" }],
      submit: { kind: "review", review: "pr_closed", decision: "replace_pr", effect: "request_changes", target_revision_id: "revision-pr" } }] };
    const fetch = calls((path) => path.endsWith("/decide") ? { kind: "committed", run_id: runId, event_id: "event-5" } : replacement);
    const gateId = compositeId({ kind: "gate", runId, unitId: cohort.unit_id, name: "pr_closed" });
    await resumeGate(gateId, { idempotency_key: "decide-3", artifact_revision_id: "stale", gate_step: "pr_closed",
      action: "request_revision", operator_comment: "", feedback: "Open a replacement" });
    const decision = fetch.mock.calls.find(([path]) => String(path).endsWith("/decide"));
    expect(JSON.parse(String(decision?.[1]?.body))).toEqual({ request_id: "decide-3", decision: "replace_pr",
      target: "revision-pr", payload: { feedback: "Open a replacement" } });
  });

  it.each([sample.units[1], sample.units[2]])("confirms merged for unit $unit_key at its named revision", async (unit) => {
    const fetch = calls((path) => path.endsWith("/decide") ? { kind: "committed", run_id: runId, event_id: "event-6" } : unit);
    const gateId = compositeId({ kind: "gate", runId, unitId: unit.unit_id, name: "merge_confirmation" });
    await resumeGate(gateId, { idempotency_key: "merge-1", artifact_revision_id: "stale", gate_step: "merge_confirmation",
      action: "confirm_merged", operator_comment: "", feedback: "" });
    const posted = fetch.mock.calls.find(([path]) => String(path).endsWith("/decide"));
    const body = JSON.parse(String(posted?.[1]?.body));
    expect([String(posted?.[0]).includes(`/units/${unit.unit_id}/reviews/merge_confirmation/decide`), body.target])
      .toEqual([true, unit.stage === "cohort" ? "revision-pr" : "revision-integration-pr"]);
  });

  it("uses a batched inbox and one cached units read per run, then refreshes only that run", async () => {
    const fetch = calls((path) => path.includes("/run-inboxes") ? { items: [sample.inbox] }
      : path.includes("/api/runs?") ? { items: [sample.run], next_cursor: null }
      : path.includes("/inbox") ? { items: [] } : sample.units);
    const inbox = await fetchReviewInbox();
    await refreshReviewInboxRun(runId, inbox);
    expect(fetch.mock.calls.filter(([path]) => String(path).endsWith("/units"))).toHaveLength(1);
    invalidateCachedRunUnits(runId);
    await refreshReviewInboxRun(runId, inbox);
    expect(fetch.mock.calls.filter(([path]) => String(path).endsWith("/units"))).toHaveLength(2);
    expect(fetch.mock.calls.filter(([path]) => String(path).includes("/run-inboxes"))).toHaveLength(1);
  });
});
