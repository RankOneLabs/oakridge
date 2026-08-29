import type { RunDecision, RunDecisionRecord, RunOutputSlot, StageDecision, StageDecisionRecord, UnitDecision, UnitOutcomeRecord } from "./run-record";

const missingRequiredSlots = (record: UnitOutcomeRecord): readonly RunOutputSlot[] =>
  record.required_slots.filter((slot) => slot.required && slot.state.kind !== "released");

/** The unit asks its run-owned record. Executor state and workflow results are deliberately absent. */
export const selectUnitDecision = (record: UnitOutcomeRecord): UnitDecision => {
  if (record.unit.state === "cancelled") return { kind: "cancelled", outcome: record.unit.outcome as Extract<NonNullable<typeof record.unit.outcome>, { kind: "cancelled" }> };
  if (record.unit.state === "failed") return { kind: "failed", outcome: record.unit.outcome as Extract<NonNullable<typeof record.unit.outcome>, { kind: "failed" }> };
  const missing = missingRequiredSlots(record);
  if (missing.length === 0) {
    const ids = new Set(record.required_slots.flatMap((slot) => slot.state.kind === "released" ? [slot.state.artifact_revision_id] : []));
    return { kind: "satisfied", artifacts: record.artifacts.filter((artifact) => ids.has(artifact.id)) };
  }
  if (record.open_waits.length > 0) return { kind: "waiting", waits: record.open_waits };
  const available = record.work_orders.find((order) => order.state === "available");
  if (available) return { kind: "work_available", work_order: available };
  const started = record.work_orders.find((order) => order.state === "started");
  if (started) return { kind: "work_in_progress", work_order: started };
  return { kind: "needs_work", missing_slots: missing.map(({ run_unit_id, output_name }) => ({ run_unit_id, output_name })) };
};

export const selectStageDecision = (record: StageDecisionRecord): StageDecision => {
  const cancelled = record.units.find((unit): unit is Extract<UnitDecision, { kind: "cancelled" }> => unit.kind === "cancelled");
  if (cancelled) return cancelled;
  const failed = record.units.find((unit): unit is Extract<UnitDecision, { kind: "failed" }> => unit.kind === "failed");
  if (failed) return failed;
  const available = record.units.flatMap((unit) => unit.kind === "work_available" ? [unit.work_order] : []);
  if (available.length > 0) return { kind: "start_work", work_orders: available };
  if (record.stage.materialization_closed && record.units.every((unit) => unit.kind === "satisfied")) return { kind: "succeeded" };
  return { kind: "waiting" };
};

export const selectRunDecision = (record: RunDecisionRecord): RunDecision => {
  if (record.run.state !== "active" && record.run.outcome) return { kind: "complete", outcome: record.run.outcome };
  const cancelled = record.stages.find((stage): stage is Extract<StageDecision, { kind: "cancelled" }> => stage.kind === "cancelled");
  if (cancelled) return { kind: "complete", outcome: cancelled.outcome };
  const failed = record.stages.find((stage): stage is Extract<StageDecision, { kind: "failed" }> => stage.kind === "failed");
  if (failed) return { kind: "complete", outcome: failed.outcome };
  const work_orders = record.stages.flatMap((stage) => stage.kind === "start_work" ? stage.work_orders : []);
  if (work_orders.length > 0) return { kind: "start_work", work_orders, record_version: record.run.record_version };
  if (record.stages.length > 0 && record.stages.every((stage) => stage.kind === "succeeded")) return { kind: "complete", outcome: { kind: "succeeded" } };
  return { kind: "wait", record_version: record.run.record_version };
};
