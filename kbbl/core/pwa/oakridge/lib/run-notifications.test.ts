import { describe, expect, it } from "vitest";

import type { RunEventFrame, WorkflowRunId } from "../types";
import { selectRunFrameNotification } from "./run-notifications";

const frame = (replayed: boolean): RunEventFrame => ({
  sequence: "42", transition_id: "transition-42", run_id: "run/one" as WorkflowRunId,
  owner: { kind: "cohort", id: "cohort-1" }, launch_reason: "retry",
  prior_owner_version: 1, resulting_owner_version: 2,
  effect: { kind: "worker_decision", cohort_id: "cohort-1", from_state: "working", to_state: "working", changes: [], actions: [{ worker: "build", action_point: "retry" }] },
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

  it("notifies when a declared target state needs an operator", () => {
    expect(selectRunFrameNotification({ ...frame(false), effect: {
      kind: "cohort_transition", cohort_id: "cohort-1", unit_label: "api", event_kind: "session_ended",
      from_state: "building", to_state: "retry_wait", next_actor: "operator", refusal: null,
    } })?.kind).toBe("info");
  });

  it("does not notify when the target state belongs to an agent", () => {
    const retry = { ...frame(false), effect: { kind: "cohort_transition" as const, cohort_id: "cohort-1",
      unit_label: "api", event_kind: "operator_retry", from_state: "retry_wait", to_state: "building",
      next_actor: "agent", refusal: null } };
    expect(selectRunFrameNotification(retry)).toBeNull();
    expect(selectRunFrameNotification({ ...retry, replayed: true })).toBeNull();
  });
});
