import { afterEach, describe, expect, it, vi } from "vitest";

import type { RunDetail, RunEvent, WorkflowRunId } from "../types";
import { fetchRunEvents, selectRunActivity } from "./run-activity";

afterEach(() => vi.unstubAllGlobals());

const run = {
  id: "run-1",
  stages: [{ stage_instance_id: "stage-1", name: "build", units: [{ version: 0, workers: [], brief: null, cohort_id: "cohort-1", unit_id: "api" }] }],
} as unknown as RunDetail;

const event = (overrides: Partial<RunEvent> = {}): RunEvent => ({
  sequence: "1", transition_id: "transition-1", run_id: "run-1" as WorkflowRunId,
  owner: { kind: "cohort", id: "cohort-1" }, launch_reason: "initial",
  prior_owner_version: 0, resulting_owner_version: 1,
  effect: { kind: "worker_decision", cohort_id: "cohort-1", from_state: "working", to_state: "working", actions: [{ worker: "build", action_point: "retry" }] },
  effect_workflow_id: null, actor: "core", occurred_at: "2026-09-27T10:00:00Z",
  ...overrides,
});

describe("selectRunActivity", () => {
  it("labels cohort-owned events with stage and unit", () => {
    expect(selectRunActivity([event()], run)[0]).toMatchObject({
      summary: "build: retry", context: "build · api",
    });
  });

  it("keeps meaningful transitions newest first and hides recorded-only changes", () => {
    const items = selectRunActivity([
      event({ sequence: "10", effect: { kind: "start_stage", stage_instance_id: "stage-1" }, owner: { kind: "stage_instance", id: "stage-1" } }),
      event({ sequence: "12", effect: { kind: "none" }, launch_reason: "gate_decided" }),
      event({ sequence: "11", effect: { kind: "cohort_transition", cohort_id: "cohort-1", unit_label: "api",
        event_kind: "session_ended", from_state: "building", to_state: "retry_wait",
        next_actor: "operator", refusal: null } }),
      event({ sequence: "13", run_id: "other-run" as WorkflowRunId }),
    ], run);
    expect(items.map((item) => item.summary)).toEqual(["Gate decided", "api: building → retry_wait", "Stage started"]);
  });

  it("shows an unknown effect without losing activity", () => {
    expect(selectRunActivity([event({ effect: { kind: "unrecognized", effect_kind: "future_step" } })], run)[0]?.summary)
      .toBe("Recorded future_step");
  });

  it("shows a generic cohort transition", () => {
    const retry = event({ effect: { kind: "cohort_transition", cohort_id: "cohort-1", unit_label: "api",
      event_kind: "operator_retry", from_state: "retry_wait", to_state: "building",
      next_actor: "agent", refusal: null } });
    expect(selectRunActivity([retry], run)[0]?.summary).toBe("api: retry_wait → building");
  });
});

describe("fetchRunEvents", () => {
  it("bounds every ledger page to the requested run", async () => {
    const request = vi.fn(async () => new Response(JSON.stringify([]), { status: 200 }));
    vi.stubGlobal("fetch", request);
    await fetchRunEvents("run/one");
    expect(request).toHaveBeenCalledWith("/oakridge/api/run_events?limit=500&run_id=run%2Fone");
  });
});
