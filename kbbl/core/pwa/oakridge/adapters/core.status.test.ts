import { describe, expect, it } from "vitest";
import cohortMerge from "../__fixtures__/v2-cohort-merge.json";
import { sampleCohort as cohort, sampleRun as run, sampleUnits as units, withUnitFields } from "../__fixtures__/read-models";
import type { OperatorRunView } from "../operator-contracts/projections/run-view";
import type { OperatorUnitView } from "../operator-contracts/projections/unit-view";
import type { RunStatus, StageStatus } from "../run-types";
import { deriveStatus, runSnapshot, runSummary, selectAggregateStatus, statusInputOf, unitToStages } from "./core";

const rootUnit: OperatorUnitView = (() => {
  const selected = units.find((unit) => unit.stage === null);
  if (!selected) throw new Error("captured fixture lacks the root unit");
  return selected;
})();

function childWithStatus(status: RunStatus, index: number, stage = "cohort"): OperatorUnitView {
  const unitStatus: OperatorUnitView["status"] = status === "complete" ? { kind: "done", outcome: null }
    : status === "cancelled" ? { kind: "cancelled" }
      : status === "pending" ? { kind: "not_started" } : { kind: "active" };
  return withUnitFields(cohort, {
    unit_id: `${cohort.unit_id}-${index}`, unit_key: `${stage}-${index}`, collection_key: `${stage}-${index}`, stage,
    status: unitStatus, is_terminal: status === "complete" || status === "cancelled",
    attention: status === "parked" ? { kind: "waiting", reason: "awaiting review" }
      : status === "failed" ? { kind: "stalled", detail: "worker failed" } : null,
    decisions: status === "parked" ? cohort.decisions : [], attempts: [], artifacts: [],
  });
}

describe("selectAggregateStatus", () => {
  it.each<{ name: string; statuses: RunStatus[]; expected: StageStatus }>([
    { name: "running with pending", statuses: ["running", "pending"], expected: "running" },
    { name: "several running and pending", statuses: ["running", "pending", "running", "pending"], expected: "running" },
    { name: "running with parked", statuses: ["running", "parked"], expected: "running" },
    { name: "parked without running", statuses: ["parked", "pending"], expected: "parked" },
    { name: "unstarted children", statuses: ["pending", "pending"], expected: "pending" },
    { name: "all completed", statuses: ["complete", "complete"], expected: "complete" },
    { name: "completed with running", statuses: ["complete", "complete", "running"], expected: "running" },
    { name: "completed with parked", statuses: ["complete", "complete", "parked"], expected: "parked" },
    { name: "cancelled with running", statuses: ["cancelled", "running"], expected: "running" },
    { name: "cancelled with parked", statuses: ["cancelled", "parked"], expected: "parked" },
    { name: "cancelled after all work ends", statuses: ["complete", "cancelled"], expected: "failed" },
    { name: "failure with completed and pending", statuses: ["failed", "complete", "pending"], expected: "failed" },
    { name: "no children", statuses: [], expected: "pending" },
  ])("aggregates $name as $expected", ({ statuses, expected }) => {
    expect(selectAggregateStatus(statuses)).toBe(expected);
  });
});

describe("child status aggregation", () => {
  it.each<{ name: string; statuses: RunStatus[]; expectedStage: StageStatus | null; expectedRun: RunStatus;
    parkedCount: number; rootStatus?: OperatorRunView["status"]; rootUnit?: OperatorUnitView; isStuck?: boolean }>([
    { name: "one running and one pending", statuses: ["running", "pending"], expectedStage: "running", expectedRun: "running", parkedCount: 0 },
    { name: "several running and pending", statuses: ["running", "pending", "running", "pending"], expectedStage: "running", expectedRun: "running", parkedCount: 0 },
    { name: "parked with no running", statuses: ["parked", "pending"], expectedStage: "parked", expectedRun: "parked", parkedCount: 1 },
    { name: "unstarted children", statuses: ["pending", "pending"], expectedStage: "pending", expectedRun: "pending", parkedCount: 0 },
    { name: "all completed with a completed root", statuses: ["complete", "complete"], expectedStage: "complete", expectedRun: "complete",
      parkedCount: 0, rootStatus: { kind: "done", outcome: null } },
    { name: "all completed with an active root", statuses: ["complete", "complete"], expectedStage: "complete", expectedRun: "running", parkedCount: 0 },
    { name: "completed children with running", statuses: ["complete", "complete", "running"], expectedStage: "running", expectedRun: "running", parkedCount: 0 },
    { name: "completed children with parked", statuses: ["complete", "complete", "parked"], expectedStage: "parked", expectedRun: "parked", parkedCount: 1 },
    { name: "cancelled child with running", statuses: ["cancelled", "running"], expectedStage: "running", expectedRun: "running", parkedCount: 0 },
    { name: "cancelled child with parked", statuses: ["cancelled", "parked"], expectedStage: "parked", expectedRun: "parked", parkedCount: 1 },
    { name: "only terminal children including cancellation", statuses: ["complete", "cancelled"], expectedStage: "failed", expectedRun: "running", parkedCount: 0 },
    { name: "only an active root unit", statuses: [], expectedStage: null, expectedRun: "running", parkedCount: 0, rootUnit },
    { name: "a failed stage-null root unit", statuses: [], expectedStage: null, expectedRun: "running", parkedCount: 0,
      rootUnit: withUnitFields(rootUnit, { attention: { kind: "stalled", detail: "root failed" } }), isStuck: true },
  ])("uses the child and root statuses for $name", ({ statuses, expectedStage, expectedRun, parkedCount, rootStatus, rootUnit, isStuck }) => {
    const children = statuses.map((status, index) => childWithStatus(status, index));
    const stageUnits = rootUnit ? [rootUnit, ...children] : children;
    const stages = unitToStages(stageUnits);
    const detail = runSnapshot(rootStatus ? { ...run, status: rootStatus } : run, stageUnits);
    expect(stages.ok && detail.ok && [stages.value[0]?.status ?? null, detail.value.status, detail.value.is_stuck,
      detail.value.parked_count]).toEqual([expectedStage, expectedRun, isStuck ?? false, parkedCount]);
  });

  it("keeps failed ahead of complete and pending outside the active-root stuck case", () => {
    const children = ["failed", "complete", "pending"].map((status, index) => childWithStatus(status as StageStatus, index));
    const detail = runSnapshot({ ...run, status: { kind: "not_started" } }, children);
    expect(detail.ok && [detail.value.stages[0]?.status, detail.value.status]).toEqual(["failed", "failed"]);
  });

  it("aggregates several brief outputs and the run from the same live children", () => {
    const root = units.find((unit) => unit.stage === null);
    if (!root) throw new Error("captured fixture lacks the root unit");
    const children = ["complete", "parked", "running", "pending"].map((status, index) =>
      childWithStatus(status as StageStatus, index, "brief"));
    const stages = unitToStages(children);
    const detail = runSnapshot(run, [root, ...children]);
    expect(stages.ok && detail.ok && [stages.value[0]?.status, detail.value.stages[0]?.status,
      detail.value.status, detail.value.parked_count]).toEqual(["running", "running", "running", 1]);
  });
});

describe("run and unit status", () => {
  it("maps a run snapshot and summary through the same status derivation", () => {
    const detail = runSnapshot(run, units);
    expect(detail.ok && [detail.value.status, runSummary(detail.value, run).status]).toEqual(["parked", "parked"]);
  });
  it("shows a cancelled run even when a child unit still carries an old failure", () => {
    const detail = runSnapshot({ ...run, status: { kind: "cancelled" } }, units);
    expect(detail.ok && detail.value.status).toBe("cancelled");
  });
  it("keeps an active run stuck while a brief unit has failed", () => {
    const failedBrief = withUnitFields(cohort, { stage: "brief", attention: { kind: "stalled", detail: "writer failed" } });
    const detail = runSnapshot({ ...run, status: { kind: "active" } }, [failedBrief]);
    expect(detail.ok && [detail.value.status, detail.value.is_stuck,
      runSummary(detail.value, run).is_failed]).toEqual(["running", true, false]);
  });
  it("distinguishes a stalled worker from a parked review", () => {
    expect(deriveStatus({ status: cohort.status, attention: { kind: "stalled", detail: "worker failed" }, attempts: cohort.attempts, decisions: cohort.decisions }).run).toBe("failed");
  });
  it.each(["invalid_instruction", "discovery_unsupported"])("parks a cohort with manual merge confirmation despite a %s PR watcher failure", (code) => {
    const mergeRun = cohortMerge.run as unknown as OperatorRunView;
    const mergeUnits = cohortMerge.units as unknown as OperatorUnitView[];
    const mergeUnit = mergeUnits.find((unit) => unit.decisions.some((decision) => decision.submit.kind === "review"
      && decision.submit.decision === "confirm_merged"));
    if (!mergeUnit) throw new Error("captured fixture lacks merge confirmation");
    const observedState = mergeUnit.artifacts.find((artifact) => artifact.artifact_key === "pr_state");
    if (!observedState) throw new Error("captured fixture lacks a PR state artifact");
    const stalled = withUnitFields(mergeUnit, {
      artifacts: [...mergeUnit.artifacts, { ...observedState, artifact_key: "observed_state" }],
      attention: { kind: "stalled", detail: "pr_watch failed: no pull request reader is configured" },
      attempts: mergeUnit.attempts.map((attempt) => attempt.worker === "pr_watch"
        ? { ...attempt, status: "failed", failure: { code, detail: "no pull request reader is configured" } }
        : attempt) });
    const detail = runSnapshot(mergeRun, mergeUnits.map((unit) => unit.unit_id === mergeUnit.unit_id ? stalled : unit));
    expect(detail.ok && [detail.value.stages.find((stage) => stage.name === "cohort")?.status,
      detail.value.status, runSummary(detail.value, mergeRun).status]).toEqual(["parked", "parked", "parked"]);
  });
  it("keeps a cohort on the old pinned definition failed when its watcher blocks completion", () => {
    const mergeUnit = (cohortMerge.units as unknown as OperatorUnitView[]).find((unit) => unit.decisions.some((decision) => decision.submit.kind === "review"
      && decision.submit.decision === "confirm_merged"));
    if (!mergeUnit) throw new Error("captured fixture lacks merge confirmation");
    expect(deriveStatus({ ...statusInputOf(mergeUnit), attention: { kind: "stalled", detail: "pr_watch failed: missing URL" },
      attempts: mergeUnit.attempts.map((attempt) => attempt.worker === "pr_watch"
        ? { ...attempt, status: "failed", failure: { code: "invalid_instruction", detail: "missing URL" } }
        : attempt) }).run).toBe("failed");
  });
  it("keeps a PR mismatch visible as a failed cohort even with merge confirmation", () => {
    const mergeUnit = (cohortMerge.units as unknown as OperatorUnitView[]).find((unit) => unit.decisions.some((decision) => decision.submit.kind === "review"
      && decision.submit.decision === "confirm_merged"));
    if (!mergeUnit) throw new Error("captured fixture lacks merge confirmation");
    expect(deriveStatus({ ...statusInputOf(mergeUnit), attention: { kind: "stalled", detail: "pr_watch failed: PR branch differs" },
      attempts: mergeUnit.attempts.map((attempt) => attempt.worker === "pr_watch"
        ? { ...attempt, status: "failed", failure: { code: "pull_request_mismatch", detail: "PR branch differs" } }
        : attempt) }).run).toBe("failed");
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
});
