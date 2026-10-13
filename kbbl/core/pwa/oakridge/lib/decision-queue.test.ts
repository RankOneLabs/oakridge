import { describe, expect, it } from "vitest";
import { makeArtifactRevision, makeDecision, makeInboxDecision, makeArtifact, makeUnitView } from "../__fixtures__/read-models";
import { selectActionableUnits, selectArtifactDecisions, selectStableOperatorDecisionQueue } from "./decision-queue";

describe("projected decision queue", () => {
  it("keeps actionable units in projection order", () => {
    const decision = makeDecision();
    const units = [
      makeUnitView({ unit_id: "first", decisions: [decision] }),
      makeUnitView({ unit_id: "waiting", decisions: [] }),
      makeUnitView({ unit_id: "last", decisions: [decision] }),
    ];
    expect(selectActionableUnits(units).map((unit) => unit.unit_id)).toEqual(["first", "last"]);
  });

  it("offers an artifact decision only on the revision it targets", () => {
    const revision = makeArtifactRevision();
    const decision = makeDecision();
    const unit = makeUnitView({ decisions: [decision], artifacts: [makeArtifact({ latest_revision: revision })] });
    expect(selectArtifactDecisions(unit, revision.id)).toEqual([decision]);
    expect(selectArtifactDecisions(unit, "earlier-revision")).toEqual([]);
  });

  it("keeps a departed item settled in its old row", () => {
    const a = makeInboxDecision({ key: "a" });
    const b = makeInboxDecision({ key: "b" });
    const c = makeInboxDecision({ key: "c" });
    expect(selectStableOperatorDecisionQueue([a, b, c].map((item) => ({ kind: "live", item })), [b, c]))
      .toEqual([{ kind: "settled", item: a }, { kind: "live", item: b }, { kind: "live", item: c }]);
  });

  it("appends newly arrived work after existing rows despite server reorder", () => {
    const a = makeInboxDecision({ key: "a" });
    const b = makeInboxDecision({ key: "b" });
    const assessment = makeInboxDecision({ key: "assessment" });
    expect(selectStableOperatorDecisionQueue([a, b].map((item) => ({ kind: "live", item })), [assessment, a, b]))
      .toEqual([{ kind: "live", item: a }, { kind: "live", item: b }, { kind: "live", item: assessment }]);
  });
});
