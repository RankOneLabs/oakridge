import { afterEach, describe, expect, it, vi } from "vitest";

import type { RunDetail, RunEvent, WorkflowRunId } from "../types";
import { fetchRunEvents, selectRunActivity } from "./run-activity";

afterEach(() => vi.unstubAllGlobals());

const run = {
  id: "run-1",
  stages: [{ stage_instance_id: "stage-1", name: "build", units: [{ cohort_id: "cohort-1", unit_id: "api" }] }],
} as RunDetail;

const event = (overrides: Partial<RunEvent> = {}): RunEvent => ({
  sequence: "1", transition_id: "transition-1", run_id: "run-1" as WorkflowRunId,
  owner: { kind: "cohort", id: "cohort-1" }, launch_reason: "initial",
  prior_owner_version: 0, resulting_owner_version: 1,
  effect: { kind: "start_attempt", cohort_id: "cohort-1", attempt_number: 1, attempt_id: null },
  effect_workflow_id: null, actor: "core", occurred_at: "2026-09-27T10:00:00Z",
  ...overrides,
});

describe("selectRunActivity", () => {
  it("labels cohort-owned events with stage and unit", () => {
    expect(selectRunActivity([event()], run)[0]).toMatchObject({
      summary: "Session launched (attempt 1)", context: "build · api",
    });
  });

  it("keeps meaningful transitions newest first and hides recorded-only changes", () => {
    const items = selectRunActivity([
      event({ sequence: "10", effect: { kind: "start_stage", stage_instance_id: "stage-1" }, owner: { kind: "stage_instance", id: "stage-1" } }),
      event({ sequence: "12", effect: { kind: "none" }, launch_reason: "gate_decided" }),
      event({ sequence: "11", effect: { kind: "dev_flow_build_cohort_transition", event: { kind: "builder_attempt_lost", pull_request_url: null }, disposition: "recorded_only" } }),
      event({ sequence: "13", run_id: "other-run" as WorkflowRunId }),
    ], run);
    expect(items.map((item) => item.summary)).toEqual(["Gate decided", "Stage started"]);
  });

  it("shows an unknown effect without losing activity", () => {
    expect(selectRunActivity([event({ effect: { kind: "unrecognized", effect_kind: "future_step" } })], run)[0]?.summary)
      .toBe("Recorded future_step");
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
