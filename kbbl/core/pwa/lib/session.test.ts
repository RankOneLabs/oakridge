import { describe, expect, it } from "vitest";

import type { RunDetail, RunSummary } from "../oakridge/types";
import { selectSessionRunTitle, selectSessionStageName } from "./session";

const runSummary: RunSummary = {
  id: "run-1",
  title: "Persisted run title",
  repository_keys: ["oakridge"],
  workflow_name: "development",
  status: "running",
  current_stage: "Plan",
  stage_total: 1,
  stage_complete: 0,
  parked_count: 0,
  updated_at: "2026-01-01T00:00:00.000Z",
  is_stuck: false,
  is_failed: false,
};

const runDetail: RunDetail = {
  id: "run-1",
  title: "Persisted run title",
  repository_keys: ["oakridge"],
  workflow_name: "development",
  status: "running",
  stages: [{
    stage_instance_id: "stage-plan",
    name: "Plan the work",
    type: "scalar",
    status: "running",
    artifacts: [],
    delegated_kbbl_sid: null,
    worktree: null,
  }],
  parked_count: 0,
  updated_at: "2026-01-01T00:00:00.000Z",
  is_stuck: false,
};

describe("session run label selectors", () => {
  it("selects a persisted run title", () => {
    expect(selectSessionRunTitle("run-1", [runSummary])).toBe("Persisted run title");
  });

  it("returns null when a run title is unavailable", () => {
    expect(selectSessionRunTitle("missing-run", [runSummary])).toBeNull();
  });

  it("selects a persisted stage name", () => {
    expect(selectSessionStageName("stage-plan", runDetail)).toBe("Plan the work");
  });

  it("returns null when a stage name is unavailable", () => {
    expect(selectSessionStageName("missing-stage", runDetail)).toBeNull();
  });
});
