import type { OperatorUnitView } from "../operator-contracts";

/** A stalled cohort unit for retry behavior tests. Keep read-model construction
 * here so tests consume the same named fixture boundary as other v2 views. */
export function retryUnit(unitId: string): OperatorUnitView {
  return {
    unit_id: `run-1/unit/${unitId}`, run_id: "run-1", unit_key: unitId, label: unitId,
    stage: "cohort", collection_key: unitId, input: {}, depends_on: [], status: { kind: "active" }, outcome: null,
    is_terminal: false, attention: { kind: "stalled", detail: "worker failed" }, attempts: [], artifacts: [],
    decisions: [{ key: "retry:builder", label: "Retry builder", payload_schema: "{}", fields: [], submit: { kind: "retry", worker: "builder" } }],
  };
}

export function withUnitFields(unit: OperatorUnitView, fields: Partial<OperatorUnitView>): OperatorUnitView {
  return { ...unit, ...fields };
}
