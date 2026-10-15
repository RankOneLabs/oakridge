import { describe, expect, it } from "vitest";
import sample from "../__fixtures__/v2-adapter-sample.json";
import cohortMerge from "../__fixtures__/v2-cohort-merge.json";
import integrationMerge from "../__fixtures__/v2-integration-merge.json";
import type { OperatorArtifactDetail, OperatorRunEvent, OperatorRunView, OperatorUnitView } from "../operator-contracts";
import { artifactTypes, attemptToWorkOrder, compositeId, decisionAction, deriveStatus, parseCompositeId, reviewToGates, revisionToArtifact, runEventKind, runSnapshot, runSummary, unitToStages } from "./core";
import { classifyDevelopmentInbox } from "./inbox";
import { parseUnitViews } from "./parse";

const run = sample.run as unknown as OperatorRunView;
const units = sample.units as unknown as OperatorUnitView[];
const cohort = units.find((unit) => unit.stage === "cohort" && unit.decisions.some((decision) => decision.submit.kind === "review"));
if (!cohort) throw new Error("captured fixture lacks a cohort review");

describe("v2 development adapters", () => {
  it("maps a run snapshot and summary through the same status derivation", () => {
    const detail = runSnapshot(run, units);
    expect(detail.ok && [detail.value.status, runSummary(detail.value, run).status]).toEqual(["parked", "parked"]);
  });
  it("rejects malformed unit data at the API boundary", () => {
    expect(parseUnitViews([{ ...cohort, decisions: [{ ...cohort.decisions[0], submit: { kind: "review" } }] }]).ok).toBe(false);
  });
  it("groups units into stages with artifacts", () => {
    const stages = unitToStages(units);
    expect(stages.ok && stages.value.find((stage) => stage.name === "cohort")?.artifacts.some((artifact) => artifact.type_id === "dev.build_result")).toBe(true);
  });
  it("maps reviews to gates and change effects to the feedback action", () => {
    const gates = reviewToGates(cohort);
    expect(gates.ok && gates.value.find((gate) => gate.gate_step === "assessment_review")?.resume_actions).toEqual(["accept", "request_revision"]);
    expect(decisionAction(cohort.decisions.find((decision) => decision.key === "request_build_changes")!)).toBe("request_revision");
  });
  it("keeps gate and artifact ids resolvable after a cold load", () => {
    const id = compositeId({ kind: "artifact", runId: run.run_id, unitId: cohort.unit_id, name: "build_result" });
    expect(parseCompositeId(id, "artifact")).toEqual({ ok: true, value: { kind: "artifact", runId: run.run_id, unitId: cohort.unit_id, name: "build_result" } });
  });
  it("maps revisions and dispatches all six supported viewer schemas", () => {
    const artifact = revisionToArtifact(sample.artifact as unknown as OperatorArtifactDetail);
    expect(artifact.ok && artifact.value.component_id).toBe("dev-build-result-viewer");
    expect(artifactTypes().map((type) => type.component_id)).toHaveLength(6);
  });
  it("maps a v2 attempt to the v1 work order reason and state", () => {
    const builder = cohort.attempts.find((attempt) => attempt.worker === "builder");
    if (!builder) throw new Error("captured fixture lacks a builder attempt");
    const attempt = attemptToWorkOrder({ runId: run.run_id, stage: "cohort", unit: cohort, attempt: builder });
    expect(attempt.ok && [attempt.value.reason, attempt.value.work_order_state, attempt.value.completed_at]).toEqual(["initial", "completed", null]);
  });
  it("maps a run event kind", () => {
    const event = runEventKind(sample.event as OperatorRunEvent);
    expect(event.ok && event.value?.operation).toBe("slot_released");
  });
  it("distinguishes a stalled worker from a parked review", () => {
    expect(deriveStatus({ status: cohort.status, attention: { kind: "stalled", detail: "worker failed" }, attempts: cohort.attempts }).run).toBe("failed");
  });
  it("classifies a development workflow inbox with a cohort lifecycle", () => {
    const inbox = classifyDevelopmentInbox(sample.inbox as unknown as { run_id: string; items: readonly import("../operator-contracts").OperatorInboxItem[] }, units);
    expect(inbox.ok && [inbox.value.items[0].kind, inbox.value.cohorts[0].lifecycle]).toEqual(["artifact_gate", "artifact_review"]);
    expect(inbox.ok && inbox.value.items.filter((item) => item.kind === "artifact_gate")).toHaveLength(1);
  });
  it.each([cohortMerge, integrationMerge])("captures confirm_merged on the unit's current revision", (fixture) => {
    const unit = fixture.units.find((candidate) => candidate.decisions.some((decision) => decision.key === "confirm_merged"));
    if (!unit) throw new Error("captured merge fixture lacks confirm_merged");
    const gates = reviewToGates(unit as unknown as OperatorUnitView);
    expect(gates.ok && gates.value.find((gate) => gate.gate_step === "merge_confirmation")?.resume_actions).toEqual(["confirm_merged"]);
  });
});
