import { describe, expect, it } from "vitest";

import {
  makeBuildBriefFixture, makeBuildResultFixture, makeDecision, makeRunView, makeRunUnitSummary, makeUnitView, makeUnitWithArtifact,
} from "../__fixtures__/read-models";
import { selectActionableUnits } from "./decision-queue";
import { selectRunAttempts } from "./run-sessions";
import {
  selectArtifactInUnits, selectRunArtifacts, selectRunProgress, selectRunUnit, selectUnitDetail,
  selectUnitDetailStatus, selectUnitStatus,
} from "./run-overview";

describe("generated run overview", () => {
  it("counts completed and actionable units", () => {
    const run = makeRunView({ units: [
      makeRunUnitSummary({ unit_id: "plan", status: { kind: "done", outcome: {} }, is_terminal: true }),
      makeRunUnitSummary({ unit_id: "build", asks: ["approve"] }),
      makeRunUnitSummary({ unit_id: "assess" }),
      makeRunUnitSummary({ unit_id: "dropped", status: { kind: "cancelled" }, is_terminal: true }),
    ] });
    expect(selectRunProgress(run)).toEqual({ total: 4, complete: 1 });
  });

  it("reports zero progress for a run with no units", () => {
    expect(selectRunProgress(makeRunView())).toEqual({ total: 0, complete: 0 });
  });

  it("opens an available merge confirmation on its own unit", () => {
    const unit = makeUnitView({ unit_id: "build-1", decisions: [makeDecision({ key: "confirm_merged", label: "Confirm merged" })] });
    expect(selectActionableUnits([unit]).map((item) => item.unit_id)).toEqual(["build-1"]);
  });

  it("does not offer actions from a terminal unit", () => {
    const other = makeUnitView({ unit_id: "build-2", decisions: [makeDecision({ key: "confirm_merged" })] });
    const terminal = makeUnitView({ unit_id: "build-1", is_terminal: true, decisions: [makeDecision({ key: "confirm_merged" })] });
    expect(selectActionableUnits([other, terminal]).find((unit) => unit.unit_id === "build-1")).toBeUndefined();
  });

  it("keeps the available decision labels on a live unit", () => {
    const unit = makeUnitView({ decisions: [makeDecision({ key: "approve", label: "Approve" }), makeDecision({ key: "reject", label: "Reject" })] });
    expect(selectActionableUnits([unit])[0]?.decisions.map((decision) => decision.label)).toEqual(["Approve", "Reject"]);
  });

  it("shows asks as attention, with a finished unit's own state taking precedence", () => {
    expect(selectUnitStatus(makeRunUnitSummary({ asks: ["approve"] }))).toBe("attention");
    expect(selectUnitStatus(makeRunUnitSummary({ status: { kind: "done", outcome: {} }, is_terminal: true, asks: ["approve"] }))).toBe("complete");
  });

  it("shows a live root offering only the run's cancel as running, not attention", () => {
    const cancel = makeDecision({ key: "cancel", label: "Cancel run", submit: { kind: "cancel" } });
    expect(selectUnitDetailStatus(makeUnitView({ decisions: [cancel] }))).toBe("running");
  });

  it("shows a loaded unit with an ask beside the cancel as attention", () => {
    const cancel = makeDecision({ key: "cancel", label: "Cancel run", submit: { kind: "cancel" } });
    expect(selectUnitDetailStatus(makeUnitView({ decisions: [makeDecision(), cancel] }))).toBe("attention");
  });

  it("never shows a cancelled unit as complete", () => {
    expect(selectUnitStatus(makeRunUnitSummary({ status: { kind: "cancelled" }, is_terminal: true }))).toBe("cancelled");
  });

  it("exposes only published current revisions as artifacts", () => {
    const brief = makeBuildBriefFixture();
    const units = [makeUnitWithArtifact({ body: brief.body, artifact_key: "brief", schema: "brief_body" }), makeUnitView()];
    expect(selectRunArtifacts(units).map((artifact) => artifact.artifact.schema)).toEqual(["brief_body"]);
  });

  it("keeps the attempt list empty when no unit has an attempt", () => {
    expect(selectRunAttempts([makeUnitView()])).toEqual([]);
  });
});

describe("run workspace unit and artifact selection", () => {
  const brief = makeBuildBriefFixture();
  const result = makeBuildResultFixture();
  const units = [
    makeUnitWithArtifact({ body: brief.body, artifact_key: "brief", revision_id: "brief-revision",
      unit: { unit_id: "brief-unit" } }),
    makeUnitWithArtifact({ body: result.body, artifact_key: "build_result", revision_id: "result-revision",
      unit: { unit_id: "build-unit" } }),
  ];

  it("indexes the current artifact revisions from all loaded units", () => {
    expect(selectRunArtifacts(units).map((entry) => entry.revision.id)).toEqual(["brief-revision", "result-revision"]);
  });

  it("does not resolve an artifact revision absent from current unit projections", () => {
    expect(selectArtifactInUnits(units, "deleted-revision")).toBeNull();
    expect(selectArtifactInUnits(units, "result-revision")?.unit_id).toBe("build-unit");
  });

  it("uses an explicit unit route before the root fallback", () => {
    const run = makeRunView({ units: [
      makeRunUnitSummary({ unit_id: "root", unit_key: "development" }),
      makeRunUnitSummary({ unit_id: "build", unit_key: "build" }),
    ] });
    expect(selectRunUnit(run, "build", "development")?.unit_id).toBe("build");
    expect(selectRunUnit(run, "missing", "development")?.unit_id).toBe("root");
  });

  it("does not display a deleted unit detail from a stale route ID", () => {
    expect(selectUnitDetail(units, "deleted-unit")).toBeNull();
    expect(selectUnitDetail(units, "brief-unit")?.unit_id).toBe("brief-unit");
  });

  it("selects no unit when the definition's root is unknown and no unit is routed", () => {
    const run = makeRunView({ units: [makeRunUnitSummary({ unit_id: "child", unit_key: "build" })] });
    expect(selectRunUnit(run, null, null)).toBeNull();
    expect(selectRunUnit(run, null, "development")).toBeNull();
    expect(selectUnitDetail([makeUnitView({ unit_id: "child" })], null)).toBeNull();
  });
});
