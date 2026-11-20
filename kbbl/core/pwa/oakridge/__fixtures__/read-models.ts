import { CURRENT_ASSESSMENT } from "./current-assessments";
import type { OperatorJsonValue } from "../operator-contracts/domain/primitives";
import specBody from "./current-spec.json";
import { OPERATOR_CURRENT_ARTIFACT_VERSIONS } from "../operator-contracts/artifact-versions";
import currentParked from "./parked-blocker-unit.json";
import currentBrief from "./current-brief.json";
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

/** Mirrors the engine's implicit blocker_review operator contract. */
export function blockerUnit(): OperatorUnitView {
  return { ...sampleCohort, run_id: "run-1", unit_id: "unit-a", artifacts: [],
    decisions: ["clarify", "discuss", "override"].map((decision) => ({ key: decision, label: decision,
      is_available: true, disabled_reason: null, payload_schema: "{answer: text}", fields: [{ key: "answer", label: "Answer" }],
      submit: { kind: "review", review: "blocker_review", decision, effect: "request_changes", target_revision_id: "blocker-revision" } })) };
}

/** The parked blocker fixture moved to another brief unit, with its blocker_review decisions aimed at that unit's blocker revision. */
export function parkedBlockerUnitFor(key: string): OperatorUnitView {
  const unit = currentParked as unknown as OperatorUnitView;
  const revision_id = `run/brief/${key}:blocker:1`;
  return { ...unit, unit_id: `run/brief/${key}`, collection_key: key,
    decisions: unit.decisions.map((decision) => decision.submit.kind === "review" ? { ...decision, submit: { ...decision.submit, target_revision_id: revision_id } } : decision) };
}

/** A real implementation handoff has cohort/brief inputs, not a writer assignment. */
export function currentParkedCohort(): OperatorUnitView {
  const unit = currentParked as unknown as OperatorUnitView;
  return { ...unit, stage: "cohort", input: { cohort: currentParked.input.assignment.cohort, brief: currentBrief },
    decisions: unit.decisions.map((decision) => ({ ...decision,
      is_available: decision.key !== "override", disabled_reason: decision.key === "override" ? "Open blocking findings" : null,
    })) };
}

export function canonicalSpecUnit(): OperatorUnitView {
  const unit = currentParked as unknown as OperatorUnitView;
  return { ...unit, input: {}, artifacts: [{ run_id: "run", unit_id: unit.unit_id, artifact_key: "spec", schema: "spec_body", is_reviewable: true, is_adjudicated: false, is_editable: false, revision_count: 1, latest_revision: { id: "spec:1", run_id: "run", unit_id: unit.unit_id, artifact_key: "spec", artifact_schema_version: OPERATOR_CURRENT_ARTIFACT_VERSIONS.spec_body.version, body: specBody, predecessor_id: null, subject_id: null, attempt_id: null, number: 1, created_at: "2026-11-17" } as OperatorUnitView["artifacts"][number]["latest_revision"] }], recorded_decisions: [{ id: "approve:1", review: "spec_review", decision: "approve", effect: "approve", target_revision_id: "spec:1", payload: {}, created_at: "2026-11-17" }] };
}

/** Current assessment with the core's production build-result redirection. */
export function currentAdjudicationUnit(): OperatorUnitView {
  const unit_id = "run/cohort";
  const revision = { id: "assessment:1", run_id: "run", unit_id, artifact_key: "assessment", number: 1,
    artifact_schema_version: OPERATOR_CURRENT_ARTIFACT_VERSIONS.assessment_body.version, attempt_id: null,
    body: JSON.parse(JSON.stringify(CURRENT_ASSESSMENT)) as OperatorJsonValue, predecessor_id: null, subject_id: "build:1", created_at: "2026-11-18T00:00:00Z" };
  const artifact = { run_id: "run", unit_id, artifact_key: "assessment", schema: "assessment_body", is_reviewable: true, is_adjudicated: true, is_editable: true, revision_count: 1, latest_revision: revision };
  return { ...canonicalSpecUnit(), run_id: "run", unit_id, stage: "cohort", artifacts: [artifact], recorded_decisions: [], decisions: ["accept", "request_build_changes"].map(decision => ({
    key: decision, label: decision, payload_schema: "adjudication", fields: [], submit: { kind: "review", review: "assessment_review", decision,
      target_revision_id: decision === "accept" ? "assessment:1" : "build:1", effect: decision === "accept" ? "approve" : "request_changes" },
  })) };
}
