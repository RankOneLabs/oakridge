import { describe, expect, it } from "vitest";

import type { OperatorRunView } from "../oakridge/operator-contracts";
import { makeRunUnitSummary, makeRunView } from "../oakridge/__fixtures__/read-models";
import { selectSessionRunLabel, selectSessionUnitLabel } from "./session";

const runSummary: OperatorRunView = makeRunView({ definition_digest: "sha-1", created_at: "2026-10-09T00:00:00.000Z",
  units: [makeRunUnitSummary({ unit_id: "stage-plan", unit_key: "planning", label: "Plan the work", stage: "planning" })] });

const runDetail: OperatorRunView = runSummary;

describe("session run label selectors", () => {
  it("selects a projected run ID", () => {
    expect(selectSessionRunLabel("run-1", [runSummary])).toBe("run-1");
  });

  it("returns null when a run title is unavailable", () => {
    expect(selectSessionRunLabel("missing-run", [runSummary])).toBeNull();
  });

  it("selects a projected scope label", () => {
    expect(selectSessionUnitLabel("stage-plan", runDetail)).toBe("Plan the work");
  });

  it("returns null when a stage name is unavailable", () => {
    expect(selectSessionUnitLabel("missing-stage", runDetail)).toBeNull();
  });
});
