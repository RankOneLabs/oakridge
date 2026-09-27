import { describe, expect, it } from "vitest";

import type { RunEvent, WorkflowRunId } from "../types";
import { selectRunActivity } from "./run-activity";

const event = (overrides: Partial<RunEvent> & Pick<RunEvent, "sequence" | "operation">): RunEvent => {
  const { sequence, operation, ...rest } = overrides;
  return {
    sequence,
    operation,
    occurred_at: "2026-09-27T10:00:00Z",
    payload: {
    run_id: "run-1" as WorkflowRunId,
    run_unit_id: null,
    stage_instance_id: null,
    stage_key: "build",
    unit_id: "c5",
    work_order_id: null,
    wait_id: null,
    output_name: "build_result",
    collection_key: null,
    artifact_revision_id: null,
    attention: null,
    continuation: null,
    detail: {},
  },
    ...rest,
  } as RunEvent;
};

describe("selectRunActivity", () => {
  it("keeps the run's durable transitions newest first", () => {
    const items = selectRunActivity([
      event({ sequence: "10", operation: "slot_released" }),
      event({ sequence: "12", operation: "gate_decided" }),
      event({ sequence: "11", operation: "slot_released", payload: {
        ...event({ sequence: "0", operation: "slot_released" }).payload,
        run_id: "another-run" as WorkflowRunId,
      } }),
    ], "run-1");

    expect(items.map((item) => item.sequence)).toEqual(["12", "10"]);
  });

  it("marks a continuing optional-attention publication", () => {
    const publication = event({
      sequence: "20",
      operation: "slot_released",
      payload: {
        ...event({ sequence: "0", operation: "slot_released" }).payload,
        attention: "optional",
        continuation: "continuing",
      },
    });

    expect(selectRunActivity([publication], "run-1")[0]).toMatchObject({
      summary: "Output published",
      is_optional_attention: true,
    });
  });

  it("leaves operational noise out of the activity list", () => {
    expect(selectRunActivity([
      event({ sequence: "30", operation: "work_started" }),
    ], "run-1")).toEqual([]);
  });
});
