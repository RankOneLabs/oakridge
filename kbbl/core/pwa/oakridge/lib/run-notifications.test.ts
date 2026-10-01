import { describe, expect, it } from "vitest";

import type { RunEventFrame, WorkflowRunId } from "../types";
import { selectRunFrameNotification } from "./run-notifications";

const frame = (replayed: boolean): RunEventFrame => ({
  sequence: "42", transition_id: "transition-42", run_id: "run/one" as WorkflowRunId,
  owner: { kind: "cohort", id: "cohort-1" }, launch_reason: "retry",
  prior_owner_version: 1, resulting_owner_version: 2,
  effect: { kind: "start_attempt", cohort_id: "cohort-1", attempt_number: 2, attempt_id: null },
  effect_workflow_id: null, actor: "core", occurred_at: "2026-09-27T10:00:00Z", replayed,
});

describe("selectRunFrameNotification", () => {
  it("links a live retry to its durable run surface", () => {
    expect(selectRunFrameNotification(frame(false))).toEqual({
      kind: "info", message: "Retry launched", href: "#oakridge/run/run%2Fone",
    });
  });

  it("suppresses replayed first-load and reconnect frames", () => {
    expect(selectRunFrameNotification(frame(true))).toBeNull();
  });

  it("reports lost builder attempts as errors", () => {
    expect(selectRunFrameNotification({ ...frame(false), effect: {
      kind: "dev_flow_build_cohort_transition",
      event: { kind: "builder_attempt_lost", pull_request_url: null }, disposition: "transitioned",
    } })?.kind).toBe("error");
  });

  it("reports a transitioned dev-flow retry as a live info notification", () => {
    const retry = { ...frame(false), effect: { kind: "dev_flow_build_cohort_transition" as const,
      event: { kind: "operator_retry_requested" as const, pull_request_url: null }, disposition: "transitioned" } };
    expect(selectRunFrameNotification(retry)).toMatchObject({ kind: "info", message: "Retry launched" });
    expect(selectRunFrameNotification({ ...retry, replayed: true })).toBeNull();
  });
});
