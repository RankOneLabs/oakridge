import { describe, expect, it } from "vitest";
import sample from "../__fixtures__/v2-adapter-sample.json";
import cohortMerge from "../__fixtures__/v2-cohort-merge.json";
import integrationMerge from "../__fixtures__/v2-integration-merge.json";
import planningRevise from "../__fixtures__/v2-planning-revise.json";
import type { OperatorArtifactDetail, OperatorAttemptView, OperatorRunEvent, OperatorRunView, OperatorUnitView } from "../operator-contracts";
import { artifactTypes, attemptToWorkOrder, compositeId, decisionAction, deriveStatus, latestAttemptPerSession, latestUnitAttemptPerSession, parseCompositeId, reviewToGates, revisionToArtifact, runEventKind, runSnapshot, runSummary, statusInputOf, unitToStages } from "./core";
import { classifyDevelopmentInbox, replaceDevelopmentInboxRun } from "./inbox";
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
  it("shows a cancelled run even when a child unit still carries an old failure", () => {
    const detail = runSnapshot({ ...run, status: { kind: "cancelled" } }, units);
    expect(detail.ok && detail.value.status).toBe("cancelled");
  });
  it("rejects malformed unit data at the API boundary", () => {
    expect(parseUnitViews([{ ...cohort, decisions: [{ ...cohort.decisions[0], submit: { kind: "review" } }] }]).ok).toBe(false);
  });
  it("groups units into stages with artifacts", () => {
    const stages = unitToStages(units);
    expect(stages.ok && stages.value.find((stage) => stage.name === "cohort")?.artifacts.some((artifact) => artifact.type_id === "dev.build_result")).toBe(true);
  });
  it("exposes a pending admission control in the frozen stage row while the run remains parked", () => {
    const original = cohort.decisions.find((decision) => decision.submit.kind === "review");
    const briefRevision = cohort.artifacts.find((artifact) => artifact.artifact_key === "brief")?.latest_revision;
    if (!original || original.submit.kind !== "review" || !briefRevision) throw new Error("fixture lacks cohort review and brief");
    const awaiting: OperatorUnitView = { ...cohort, attention: { kind: "waiting", reason: "awaiting admission review" },
      decisions: [{ ...original, key: "admit", submit: { ...original.submit, review: "admission", decision: "admit",
        effect: "approve", target_revision_id: briefRevision.id } }] };
    const stages = unitToStages([awaiting]);
    const unit = stages.ok ? stages.value[0]?.units?.[0] : null;
    expect([stages.ok && stages.value[0]?.status, unit?.status, unit?.admission_required,
      unit?.admitted, unit?.admission_eligible]).toEqual(["parked", "pending", true, false, true]);
  });
  it("maps reviews to gates and change effects to the feedback action", () => {
    const gates = reviewToGates(cohort);
    expect(gates.ok && gates.value.find((gate) => gate.gate_step === "assessment_review")?.resume_actions).toEqual(["approve", "request_revision"]);
    expect(decisionAction(cohort.decisions.find((decision) => decision.key === "request_build_changes")!)).toBe("request_revision");
  });
  it("keeps an input-revision review target so the frozen decision button can submit", () => {
    const accept = cohort.decisions.find((decision) => decision.key === "accept");
    if (!accept || accept.submit.kind !== "review") throw new Error("captured fixture lacks an accept review");
    const target = `${cohort.unit_id}:input:1`;
    const inputReview: OperatorUnitView = { ...cohort, artifacts: [], decisions: [{ ...accept,
      submit: { ...accept.submit, review: "admission", target_revision_id: target } }] };
    const gates = reviewToGates(inputReview);
    expect(gates.ok && gates.value[0]?.artifact_revision_id).toBe(target);
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
  it("represents a planning revision in its reused kbbl session once", () => {
    const selected = latestAttemptPerSession(planningRevise.attempts as OperatorAttemptView[]);
    expect(selected.ok && selected.value.map((attempt) => [attempt.kbbl_session_id, attempt.mode, attempt.cause.kind]))
      .toEqual([[planningRevise.attempts[0]?.kbbl_session_id, "revise", "changes_requested"]]);
  });
  it("shows one session when separate brief units share its physical sid", () => {
    const first = units.find((unit) => unit.stage === "brief" && unit.attempts.length > 0);
    if (!first) throw new Error("captured fixture lacks a brief attempt");
    const second: OperatorUnitView = { ...first, unit_id: `${first.unit_id}-other`, attempts: first.attempts.map((attempt) => ({
      ...attempt, id: `${attempt.id}-other`, unit_id: `${first.unit_id}-other`, created_at: "9999-01-01T00:00:00Z" })) };
    const selected = latestUnitAttemptPerSession([first, second]);
    expect(selected.ok && selected.value.map(({ unit }) => unit.unit_id)).toEqual([second.unit_id]);
  });
  it("maps a run event kind", () => {
    const event = runEventKind(sample.event as OperatorRunEvent);
    expect(event.ok && event.value?.operation).toBe("slot_released");
  });
  it("distinguishes a stalled worker from a parked review", () => {
    expect(deriveStatus({ status: cohort.status, attention: { kind: "stalled", detail: "worker failed" }, attempts: cohort.attempts, decisions: cohort.decisions }).run).toBe("failed");
  });
  it("parks a unit awaiting the operator and leaves a dependency wait pending", () => {
    const blocked = units.find((unit) => unit.attention?.kind === "waiting" && unit.decisions.length === 0);
    if (!blocked) throw new Error("captured fixture lacks a dependency wait");
    expect([deriveStatus(statusInputOf(cohort)).run, deriveStatus(statusInputOf(blocked)).run]).toEqual(["parked", "pending"]);
  });
  it("shows a reviewable revision as parked after its worker failed, in both list and detail", () => {
    const failed = { ...cohort, attention: { kind: "waiting" as const, reason: "awaiting assessment_review review" },
      attempts: [{ ...cohort.attempts[0]!, status: "failed" as const,
        failure: { code: "no_output", detail: "worker ended before publishing" }, is_current: true }] };
    const detail = runSnapshot(run, units.map((unit) => unit.unit_id === cohort.unit_id ? failed : unit));
    expect(detail.ok && [detail.value.stages.find((stage) => stage.name === cohort.stage)?.status,
      detail.value.status, runSummary(detail.value, run).status]).toEqual(["parked", "parked", "parked"]);
  });
  it("maps an approve-effect decision onto a v1 action the frozen gate UI renders", () => {
    const accept = cohort.decisions.find((decision) => decision.key === "accept");
    const merge = (cohortMerge.units as unknown as OperatorUnitView[])
      .flatMap((unit) => unit.decisions).find((decision) => decision.key === "confirm_merged");
    if (!accept || !merge) throw new Error("captured fixtures lack the approve decisions");
    expect([decisionAction(accept), decisionAction(merge)]).toEqual(["approve", "confirm_merged"]);
  });
  it("classifies a development workflow inbox with a cohort lifecycle", () => {
    const inbox = classifyDevelopmentInbox(sample.inbox as unknown as { run_id: string; items: readonly import("../operator-contracts").OperatorInboxItem[] }, units);
    expect(inbox.ok && [inbox.value.items[0].kind, inbox.value.cohorts[0].lifecycle]).toEqual(["artifact_gate", "artifact_review"]);
    expect(inbox.ok && inbox.value.items.filter((item) => item.kind === "artifact_gate")).toHaveLength(1);
  });
  it("keeps both run slices when invalidate responses complete against an old inbox snapshot", () => {
    const first = classifyDevelopmentInbox(sample.inbox as unknown as { run_id: string; items: readonly import("../operator-contracts").OperatorInboxItem[] }, units);
    if (!first.ok) throw new Error(first.error.detail);
    const secondRun = "run-another";
    const second = { cohorts: first.value.cohorts.map((cohort) => ({ ...cohort, run_id: secondRun })),
      items: first.value.items.map((item) => ({ ...item, run_id: secondRun })) };
    const latest = replaceDevelopmentInboxRun(first.value, secondRun, second);
    const changedFirst = { cohorts: first.value.cohorts, items: [] };
    const combined = replaceDevelopmentInboxRun(latest, run.run_id, changedFirst);
    expect([combined.items.some((item) => item.run_id === run.run_id), combined.items.some((item) => item.run_id === secondRun)])
      .toEqual([false, true]);
  });
  it.each([cohortMerge, integrationMerge])("captures confirm_merged on the unit's current revision", (fixture) => {
    const unit = fixture.units.find((candidate) => candidate.decisions.some((decision) => decision.key === "confirm_merged"));
    if (!unit) throw new Error("captured merge fixture lacks confirm_merged");
    const gates = reviewToGates(unit as unknown as OperatorUnitView);
    expect(gates.ok && gates.value.find((gate) => gate.gate_step === "merge_confirmation")?.resume_actions).toEqual(["confirm_merged"]);
  });
});
