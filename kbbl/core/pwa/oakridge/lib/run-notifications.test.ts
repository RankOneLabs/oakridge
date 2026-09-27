import { describe, expect, it } from "vitest";

import type { RunEventFrame, WorkflowRunId } from "../types";
import { selectRunFrameNotification } from "./run-notifications";

const frame = (replayed: boolean): RunEventFrame => ({
  sequence: "42",
  operation: "slot_released",
  occurred_at: "2026-09-27T10:00:00Z",
  replayed,
  payload: {
    run_id: "run/one" as WorkflowRunId,
    run_unit_id: null,
    stage_instance_id: null,
    stage_key: "build",
    unit_id: "c5",
    work_order_id: null,
    wait_id: null,
    output_name: "build_result",
    collection_key: null,
    artifact_revision_id: null,
    attention: "optional",
    continuation: "continuing",
    detail: { attention: "optional", continuation: "continuing" },
  },
});

describe("selectRunFrameNotification", () => {
  it("links a live transition to its durable run surface", () => {
    expect(selectRunFrameNotification(frame(false))).toEqual({
      kind: "info",
      message: "Optional attention: Output published · build · c5",
      href: "#oakridge/run/run%2Fone",
    });
  });

  it("suppresses replayed first-load and reconnect frames", () => {
    expect(selectRunFrameNotification(frame(true))).toBeNull();
  });
});
