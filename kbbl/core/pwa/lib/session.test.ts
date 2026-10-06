import { describe, expect, it } from "vitest";

import type { OperatorRunView } from "../oakridge/operator-contracts";
import { selectSessionRunLabel, selectSessionScopeLabel } from "./session";

const runSummary: OperatorRunView = {
  run_id: "run-1",
  definition_bundle_id: "bundle-1",
  definition_digest: "sha-1",
  version: 1,
  cursor: [{ scope_id: "stage-plan", version: 1 }],
  scopes: [{ scope_id: "stage-plan", scope_key: "planning", label: "Plan the work",
    version: 1, is_terminal: false, available_commands: [] }],
};

const runDetail: OperatorRunView = runSummary;

describe("session run label selectors", () => {
  it("selects a projected run ID", () => {
    expect(selectSessionRunLabel("run-1", [runSummary])).toBe("run-1");
  });

  it("returns null when a run title is unavailable", () => {
    expect(selectSessionRunLabel("missing-run", [runSummary])).toBeNull();
  });

  it("selects a projected scope label", () => {
    expect(selectSessionScopeLabel("stage-plan", runDetail)).toBe("Plan the work");
  });

  it("returns null when a stage name is unavailable", () => {
    expect(selectSessionScopeLabel("missing-stage", runDetail)).toBeNull();
  });
});
