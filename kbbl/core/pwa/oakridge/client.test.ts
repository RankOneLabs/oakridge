import { afterEach, describe, expect, it, vi } from "vitest";
import sample from "./__fixtures__/v2-adapter-sample.json";
import planningRevise from "./__fixtures__/v2-planning-revise.json";
import cohortMerge from "./__fixtures__/v2-cohort-merge.json";
import integrationMerge from "./__fixtures__/v2-integration-merge.json";
import definitionFixture from "./__fixtures__/v2-definition-detail.json";
import { cancelRun, confirmFinalPullRequest, createRun, fetchArtifact, fetchReviewInbox, fetchRun, fetchRunSessions, fetchRuns, invalidateCachedRunUnits, postAtomEdit, refreshReviewInboxRun, resumeGate, retryRunUnit } from "./client";
import { compositeId } from "./adapters/core";
import type { OperatorDefinitionDetail, OperatorUnitView } from "./operator-contracts";
import { selectAgentSessionTargets, selectLaunchSessionSettings } from "./lib/agent-session-targets";
import type { CreateRunRequest, RepositoryKey } from "./types";

const runId = sample.run.run_id;
const definition = { ...definitionFixture.definition, bundle: { key: "development" }, archived_at: null, graph: {},
  bundle_id: sample.run.definition_bundle_id, digest: sample.run.definition_digest } as unknown as OperatorDefinitionDetail;
const sessionTargets = selectAgentSessionTargets(definition.workflow);
const selectedSettings = selectLaunchSessionSettings(sessionTargets, Object.fromEntries(sessionTargets.map((target) =>
  [target.key, { runtime: "claude-code" as const, model: "sonnet" }])));
if (!selectedSettings.ok) throw new Error(selectedSettings.error.detail);
const sessionSettings = selectedSettings.value;
const cohort = (sample.units as unknown as OperatorUnitView[]).find((unit) => unit.stage === "cohort" && unit.decisions.some((decision) => decision.submit.kind === "review" && decision.submit.review === "assessment_review"));
if (!cohort) throw new Error("captured fixture lacks an assessment review");
const changeDecision = cohort.decisions.find((decision) => decision.key === "request_build_changes");
const acceptDecision = cohort.decisions.find((decision) => decision.key === "accept");
const changeTarget = changeDecision?.submit.kind === "review" ? changeDecision.submit.target_revision_id : null;
const acceptTarget = acceptDecision?.submit.kind === "review" ? acceptDecision.submit.target_revision_id : null;
if (!changeTarget || !acceptTarget) throw new Error("captured fixture lacks assessment decisions");
const json = (body: unknown): Response => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
const calls = (respond: (path: string, init?: RequestInit) => unknown) => vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
  const body = respond(String(input), init);
  if (body instanceof Response) return body;
  return json(body);
});
afterEach(() => { vi.restoreAllMocks(); invalidateCachedRunUnits(null); });

const createRunRequest = (): CreateRunRequest => ({
  workflow_def_id: sample.run.definition_bundle_id, project_id: null,
  context: { brief_notes: "Build it", repositories: [{ key: "api" as RepositoryKey, path: "/repo", integration_branch: "main" }],
    worktree_path: "/repo", base_branch: "epic/x", oakridge_url: "http://oakridge", session_settings: sessionSettings },
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

  it("refreshes a run after its next poll even when an invalidate frame is missed", async () => {
    let now = 1;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    let units: readonly OperatorUnitView[] = sample.units as unknown as OperatorUnitView[];
    let unitReads = 0;
    calls((path) => {
      if (path.endsWith("/units")) { unitReads += 1; return units; }
      return sample.run;
    });
    const before = await fetchRun(runId);
    units = units.map((unit) => unit.stage === "cohort" ? { ...unit, attention: null, decisions: [] } : unit);
    now += 10_000;
    const after = await fetchRun(runId);
    expect([before.status, after.status, unitReads]).toEqual(["parked", "running", 2]);
  });

  it("lists one Planning session after feedback reuses it for a revision", async () => {
    const planning = sample.units.find((unit) => unit.stage === "planning");
    if (!planning) throw new Error("captured fixture lacks planning unit");
    calls(() => [{ ...planning, run_id: planningRevise.run_id, unit_id: planningRevise.unit_id, attempts: planningRevise.attempts }]);
    const sessions = await fetchRunSessions(planningRevise.run_id);
    expect(sessions.map((session) => [session.session_id, session.reason, session.work_order_state]))
      .toEqual([[planningRevise.attempts[0]?.kbbl_session_id, "input_revision", "completed"]]);
  });

  it("lists one Brief session when two brief units share its sid", async () => {
    const first = sample.units.find((unit) => unit.stage === "brief" && unit.attempts.length > 0);
    if (!first) throw new Error("captured fixture lacks a brief attempt");
    const second = { ...first, unit_id: `${first.unit_id}-other`, attempts: first.attempts.map((attempt) => ({ ...attempt,
      id: `${attempt.id}-other`, unit_id: `${first.unit_id}-other`, created_at: "9999-01-01T00:00:00Z" })) };
    calls(() => [first, second]);
    const sessions = await fetchRunSessions(first.run_id);
    expect(sessions.map((session) => [session.session_id, session.work_order_id])).toEqual([[first.attempts[0]?.kbbl_session_id,
      `${first.attempts[0]?.id}-other`]]);
  });

  it("refreshes cached units after cancelling a parked run", async () => {
    let isCancelled = false;
    let unitReads = 0;
    calls((path) => {
      if (path.endsWith("/cancel")) {
        isCancelled = true;
        return { kind: "committed", run_id: runId, event_id: "event-cancel" };
      }
      if (path.endsWith("/units")) {
        unitReads += 1;
        return isCancelled ? sample.units.map((unit) => ({ ...unit, status: { kind: "cancelled" }, attention: null, decisions: [] })) : sample.units;
      }
      return isCancelled ? { ...sample.run, status: { kind: "cancelled" } } : sample.run;
    });
    await fetchRun(runId);
    await cancelRun(runId);
    expect([(await fetchRun(runId)).status, unitReads]).toEqual(["cancelled", 2]);
  });

  it("launches with a separate setting for each declared agent worker, then reads back", async () => {
    const fetch = calls((path) => path.includes("/api/definitions/") ? definition
      : path.endsWith("/api/runs") ? { kind: "committed", run_id: runId, event_id: "event-2" }
      : path.includes("/units") ? sample.units : sample.run);
    const request = createRunRequest();
    const result = await createRun({ ...request, context: { ...request.context,
      session_settings: { ...sessionSettings, cohort: { ...sessionSettings.cohort,
        builder: { harness: "codex", model: "gpt-6-sol", effort: null } } } } }, "launch-1");
    const launch = fetch.mock.calls.find(([path]) => String(path).endsWith("/api/runs"));
    const body = JSON.parse(String(launch?.[1]?.body));
    expect([result.id, body.request_id, body.digest, Object.hasOwn(body.input, "admission"), Object.keys(body.config.sessions).sort(),
      body.config.sessions.cohort.assessor, body.config.sessions.cohort.builder]).toEqual([
      runId, "launch-1", sample.run.definition_digest, false,
      ["analysis", "brief", "cohort", "integration", "planning"],
      { harness: "claude-code", model: "sonnet", effort: null },
      { harness: "codex", model: "gpt-6-sol", effort: null },
    ]);
  });

  it("accepts settings for an agent declared through a worker template", async () => {
    const templated = {
      ...definition,
      workflow: {
        ...definitionFixture.definition.workflow,
        workers: { author_template: { kind: "agent" }, watch_template: { kind: "code" } },
        stages: { ...definitionFixture.definition.workflow.stages,
          analysis: { workers: { author: { template: "author_template" }, watch: { template: "watch_template" } } } },
      },
    } as unknown as OperatorDefinitionDetail;
    const fetch = calls((path) => path.includes("/api/definitions/") ? templated
      : path.endsWith("/api/runs") ? { kind: "committed", run_id: runId, event_id: "event-template" }
      : path.includes("/units") ? sample.units : sample.run);
    await createRun(createRunRequest(), "launch-template");
    const launch = fetch.mock.calls.find(([path]) => String(path).endsWith("/api/runs"));
    expect(JSON.parse(String(launch?.[1]?.body)).config.sessions.analysis.author)
      .toEqual(sessionSettings.analysis.author);
  });

  it("opens an artifact through its self-describing id without a prior run snapshot", async () => {
    const fetch = calls((path) => path.endsWith("/units") ? sample.units : sample.artifact);
    const id = compositeId({ kind: "artifact", runId, unitId: cohort.unit_id, name: `build_result:${changeTarget}` });
    const artifact = await fetchArtifact(id);
    expect([artifact.component_id, artifact.label]).toEqual(["dev-build-result-viewer", "a"]);
    expect(fetch.mock.calls.map(([path]) => String(path))).toEqual([
      `/oakridge/api/api/runs/${runId}/units/${encodeURIComponent(cohort.unit_id)}/artifacts/build_result`,
      `/oakridge/api/api/runs/${runId}/units`,
    ]);
  });

  it("identifies a browser artifact edit as an operator publication", async () => {
    const fetch = calls((_path, init) => init?.method === "PUT"
      ? { kind: "committed", run_id: runId, event_id: "event-edit" } : sample.artifact);
    const id = compositeId({ kind: "artifact", runId, unitId: cohort.unit_id,
      name: `build_result:${sample.artifact.revisions[0].id}` });
    await postAtomEdit(id, { anchor: "/summary", prev_value: "Built a.", new_value: "Built b.", author: "operator" });
    const put = fetch.mock.calls.find(([, init]) => init?.method === "PUT");
    expect((put?.[1]?.headers as Record<string, string>)["X-Oakridge-Publisher"]).toBe("operator");
  });

  it("resolves an opaque revision id by a one-time run and unit search", async () => {
    const fetch = calls((path) => path.includes("/api/runs?") ? { items: [sample.run], next_cursor: null }
      : path.endsWith("/units") ? sample.units : sample.artifact);
    expect((await fetchArtifact(changeTarget)).component_id).toBe("dev-build-result-viewer");
    expect(fetch.mock.calls.some(([path]) => String(path).includes(`/units/${encodeURIComponent(cohort.unit_id)}/artifacts/build_result`))).toBe(true);
  });

  it("retries the cohort unit, not the brief that shares its collection key", async () => {
    const retry = { key: "retry:builder", label: "Retry builder", payload_schema: "{}", fields: [], submit: { kind: "retry", worker: "builder" } };
    const units = (sample.units as unknown as OperatorUnitView[]).map((unit) => unit.stage === "cohort" && unit.collection_key === "b"
      ? { ...unit, decisions: [retry] } : unit);
    const stalled = units.find((unit) => unit.stage === "cohort" && unit.collection_key === "b")!;
    const fetch = calls((path) => path.endsWith("/retry") ? { kind: "committed", run_id: runId, event_id: "event-retry" } : units);
    await retryRunUnit(compositeId({ kind: "stage", runId, unitId: stalled.unit_id, name: "cohort" }), "b");
    const posted = fetch.mock.calls.find(([path]) => String(path).endsWith("/retry"));
    expect(String(posted?.[0])).toContain(`/units/${encodeURIComponent(stalled.unit_id)}/workers/builder/retry`);
  });

  it("resolves an opaque gate id from the revision and action before deciding", async () => {
    const fetch = calls((path) => path.endsWith("/decide") ? { kind: "committed", run_id: runId, event_id: "event-opaque" }
      : path.includes("/api/runs?") ? { items: [sample.run], next_cursor: null }
      : path.endsWith("/units") ? sample.units : cohort);
    await resumeGate("legacy-gate", { idempotency_key: "opaque-1", artifact_revision_id: acceptTarget, gate_step: "artifact_approval",
      action: "request_build_changes", operator_comment: "", feedback: "Improve it" });
    const posted = fetch.mock.calls.find(([path]) => String(path).endsWith("/decide"));
    expect(String(posted?.[0])).toContain(`/units/${encodeURIComponent(cohort.unit_id)}/reviews/assessment_review/decide`);
    expect(JSON.parse(String(posted?.[1]?.body)).target).toBe(changeTarget);
  });

  it("sends collected feedback to the decision's declared field and target revision", async () => {
    const fetch = calls((path) => path.endsWith("/decide") ? { kind: "committed", run_id: runId, event_id: "event-3" } : cohort);
    const gateId = compositeId({ kind: "gate", runId, unitId: cohort.unit_id, name: "assessment_review" });
    await resumeGate(gateId, { idempotency_key: "decide-1", artifact_revision_id: acceptTarget, gate_step: "assessment_review",
      action: "request_build_changes", operator_comment: "", feedback: "Fix the API" });
    const decision = fetch.mock.calls.find(([path]) => String(path).endsWith("/decide"));
    expect(JSON.parse(String(decision?.[1]?.body))).toEqual({ request_id: "decide-1", decision: "request_build_changes",
      target: changeTarget, payload: { feedback: "Fix the API" } });
  });

  it("submits the v1 approve action as the v2 decision key it maps from, without feedback", async () => {
    const fetch = calls((path) => path.endsWith("/decide") ? { kind: "committed", run_id: runId, event_id: "event-4" } : cohort);
    const gateId = compositeId({ kind: "gate", runId, unitId: cohort.unit_id, name: "assessment_review" });
    await resumeGate(gateId, { idempotency_key: "decide-2", artifact_revision_id: acceptTarget, gate_step: "assessment_review",
      action: "approve", operator_comment: "", feedback: "" });
    const decision = fetch.mock.calls.find(([path]) => String(path).endsWith("/decide"));
    const body = JSON.parse(String(decision?.[1]?.body)) as { decision: string; payload: unknown };
    expect([body.decision, body.payload]).toEqual(["accept", {}]);
  });

  it("refuses a decision when the displayed artifact revision is stale", async () => {
    const fetch = calls((path) => path.endsWith("/decide") ? { kind: "committed", run_id: runId, event_id: "event-ignored" } : cohort);
    const gateId = compositeId({ kind: "gate", runId, unitId: cohort.unit_id, name: "assessment_review" });
    await expect(resumeGate(gateId, { idempotency_key: "stale-review", artifact_revision_id: "old-assessment",
      gate_step: "assessment_review", action: "approve", operator_comment: "", feedback: "" }))
      .rejects.toThrow("review artifact changed; refresh before deciding");
    expect(fetch.mock.calls.some(([path]) => String(path).endsWith("/decide"))).toBe(false);
  });

  it("maps replace_pr by its request_changes effect and submits feedback", async () => {
    const replacement = { ...cohort, decisions: [{ key: "replace_pr", label: "Replace PR", payload_schema: "{feedback: text}",
      fields: [{ key: "feedback", label: "Why replace?" }],
      submit: { kind: "review", review: "pr_closed", decision: "replace_pr", effect: "request_changes", target_revision_id: "revision-pr" } }] };
    const fetch = calls((path) => path.endsWith("/decide") ? { kind: "committed", run_id: runId, event_id: "event-5" } : replacement);
    const gateId = compositeId({ kind: "gate", runId, unitId: cohort.unit_id, name: "pr_closed" });
    await resumeGate(gateId, { idempotency_key: "decide-3", artifact_revision_id: "revision-pr", gate_step: "pr_closed",
      action: "request_revision", operator_comment: "", feedback: "Open a replacement" });
    const decision = fetch.mock.calls.find(([path]) => String(path).endsWith("/decide"));
    expect(JSON.parse(String(decision?.[1]?.body))).toEqual({ request_id: "decide-3", decision: "replace_pr",
      target: "revision-pr", payload: { feedback: "Open a replacement" } });
  });

  it.each([cohortMerge, integrationMerge])("confirms merged for unit at its named revision", async (fixture) => {
    const unit = (fixture.units as unknown as OperatorUnitView[]).find((candidate) => candidate.decisions.some((decision) => decision.key === "confirm_merged"));
    if (!unit) throw new Error("captured fixture lacks confirm_merged");
    const mergeDecision = unit.decisions.find((decision) => decision.key === "confirm_merged");
    if (!mergeDecision || mergeDecision.submit.kind !== "review") throw new Error("captured fixture lacks merge decision target");
    const fetch = calls((path) => path.endsWith("/decide") ? { kind: "committed", run_id: fixture.run.run_id, event_id: "event-6" } : unit);
    const gateId = compositeId({ kind: "gate", runId: fixture.run.run_id, unitId: unit.unit_id, name: "merge_confirmation" });
    await resumeGate(gateId, { idempotency_key: "merge-1", artifact_revision_id: mergeDecision.submit.target_revision_id, gate_step: "merge_confirmation",
      action: "confirm_merged", operator_comment: "", feedback: "" });
    const posted = fetch.mock.calls.find(([path]) => String(path).endsWith("/decide"));
    const body = JSON.parse(String(posted?.[1]?.body));
    expect([String(posted?.[0]).includes(`/units/${encodeURIComponent(unit.unit_id)}/reviews/merge_confirmation/decide`), body.target])
      .toEqual([true, mergeDecision.submit.target_revision_id]);
  });

  it("confirms final merge against the independent manual target", async () => {
    const unit = (integrationMerge.units as unknown as OperatorUnitView[]).find((candidate) => candidate.stage === "integration" && candidate.decisions.some((decision) => decision.key === "confirm_merged"));
    if (!unit || !unit.collection_key) throw new Error("captured fixture lacks an integration merge decision");
    const target = `${unit.unit_id}:manual_merge_target:1`;
    const updated = { ...unit, decisions: unit.decisions.map((decision) => decision.key === "confirm_merged" && decision.submit.kind === "review"
      ? { ...decision, submit: { ...decision.submit, target_revision_id: target } } : decision) };
    const fetch = calls((path) => path.endsWith("/decide") ? { kind: "committed", run_id: integrationMerge.run.run_id, event_id: "event-manual-merge" } : [updated]);
    await confirmFinalPullRequest(integrationMerge.run.run_id, unit.collection_key as RepositoryKey,
      { idempotency_key: "manual-final-merge" });
    const posted = fetch.mock.calls.find(([path]) => String(path).endsWith("/decide"));
    expect([String(posted?.[0]).includes(`/units/${encodeURIComponent(unit.unit_id)}/reviews/merge_confirmation/decide`),
      JSON.parse(String(posted?.[1]?.body)).target]).toEqual([true, target]);
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
