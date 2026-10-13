import { describe, expect, it } from "vitest";

import {
  makeBuildBriefFixture, makeDecision, makeRunView, makeRunUnitSummary, makeUnitView, makeUnitWithArtifact,
} from "../__fixtures__/read-models";
import { selectActionableUnits } from "./decision-queue";
import { selectRunAttempts } from "./run-sessions";
import { selectRunArtifacts, selectRunProgress, selectUnitStatus } from "./run-overview";

describe("generated run overview", () => {
  it("counts completed and actionable units", () => {
    const run = makeRunView({ units: [
      makeRunUnitSummary({ unit_id: "plan", is_terminal: true }),
      makeRunUnitSummary({ unit_id: "build", asks: ["approve"] }),
      makeRunUnitSummary({ unit_id: "assess" }),
    ] });
    expect(selectRunProgress(run)).toEqual({ total: 3, complete: 1, needs_attention: 1 });
  });

  it("reports zero progress for a run with no units", () => {
    expect(selectRunProgress(makeRunView())).toEqual({ total: 0, complete: 0, needs_attention: 0 });
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

  it("shows asks as attention, with terminal state taking precedence", () => {
    expect(selectUnitStatus(makeRunUnitSummary({ asks: ["approve"] }))).toBe("attention");
    expect(selectUnitStatus(makeRunUnitSummary({ is_terminal: true, asks: ["approve"] }))).toBe("complete");
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
