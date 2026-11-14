import type { OperatorRunView } from "../operator-contracts/projections/run-view";
import type { OperatorUnitView } from "../operator-contracts/projections/unit-view";
import sample from "./v2-adapter-sample.json";

export const sampleRun = sample.run as unknown as OperatorRunView;
export const sampleUnits = sample.units as unknown as OperatorUnitView[];
export const sampleCohort: OperatorUnitView = (() => {
  const selected = sampleUnits.find((unit) => unit.stage === "cohort" && unit.decisions.some((decision) => decision.submit.kind === "review"));
  if (!selected) throw new Error("captured fixture lacks a cohort review");
  return selected;
})();

/** A stalled cohort unit for retry behavior tests. Keep read-model construction
 * here so tests consume the same named fixture boundary as other v2 views. */
export function retryUnit(unitId: string): OperatorUnitView {
  return {
    input_provenance: { status: "unresolved" }, unit_id: `run-1/unit/${unitId}`, run_id: "run-1", unit_key: unitId, label: unitId,
    stage: "cohort", collection_key: unitId, input: {}, depends_on: [], status: { kind: "active" }, outcome: null,
    is_terminal: false, attention: { kind: "stalled", detail: "worker failed" }, attempts: [], artifacts: [],
    decisions: [{ key: "retry:builder", label: "Retry builder", payload_schema: "{}", fields: [], submit: { kind: "retry", worker: "builder" } }],
    recorded_decisions: [],
  };
}

export function withUnitFields(unit: OperatorUnitView, fields: Partial<OperatorUnitView>): OperatorUnitView {
  return { ...unit, ...fields };
}
