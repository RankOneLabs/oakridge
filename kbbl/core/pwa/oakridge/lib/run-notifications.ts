import type { RunEvent, RunEventFrame, RunEventOperation } from "../types";

export interface RunNotification {
  readonly kind: "success" | "error" | "info";
  readonly message: string;
  readonly href: string;
}

const transitionLabels: Readonly<Record<RunEventOperation, string>> = {
  stage_materialized: "Stage materialized",
  materialization_closed: "Materialization closed",
  materialization_failed: "Materialization failed",
  run_cancelled: "Run cancelled",
  unit_admitted: "Unit admitted",
  operator_retry_created: "Unit retry created",
  input_revised: "Input revised",
  slot_released: "Output published",
  slot_pending: "Output awaiting review",
  slot_invalidated: "Output invalidated",
  unit_satisfied: "Unit completed",
  work_started: "Work started",
  gate_opened: "Gate opened",
  gate_decided: "Gate decided",
  pull_request_observed: "Pull request observed",
  pull_request_merge_confirmed: "Pull request merge confirmed",
};

const kindOf = (operation: RunEventOperation): RunNotification["kind"] => {
  if (operation === "materialization_failed" || operation === "run_cancelled") return "error";
  if (operation === "unit_satisfied" || operation === "pull_request_merge_confirmed") return "success";
  return "info";
};

export const selectRunNotification = (event: RunEvent): RunNotification => {
  const location = [event.payload.stage_key, event.payload.unit_id]
    .filter((part): part is string => part !== null)
    .join(" · ");
  const optionalAttention =
    event.payload.attention === "optional" && event.payload.continuation === "continuing";
  const prefix = optionalAttention ? "Optional attention: " : "";
  const suffix = location === "" ? "" : ` · ${location}`;
  return {
    kind: kindOf(event.operation),
    message: `${prefix}${transitionLabels[event.operation]}${suffix}`,
    href: `#oakridge/run/${encodeURIComponent(event.payload.run_id)}`,
  };
};

/** Replayed frames rebuild stream position and never represent a new notification. */
export const selectRunFrameNotification = (frame: RunEventFrame): RunNotification | null =>
  frame.replayed ? null : selectRunNotification(frame);
