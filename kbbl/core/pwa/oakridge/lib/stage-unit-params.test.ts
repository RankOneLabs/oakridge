import { describe, expect, it } from "vitest";

import type { StageDetail, StageUnit } from "../types";
import { selectCohortBrief, selectStageHasCohortRows, selectCohortArtifacts, selectGateLabel } from "./stage-unit-params";
import buildParams from "./__fixtures__/run-fd23c8b3-build-params.json";

function makeUnit(brief: StageUnit["brief"]): StageUnit {
  return { version: 0, workers: [],
    cohort_id: "acceptance-and-browser",
    unit_id: "acceptance-and-browser",
    repository_key: null,
    brief,
    sid: null,
    worktree: null,
    status: "complete",
    blocked_reason: null,
    next_actor: null,
    retryable: false,
    gate: null,
  };
}

describe("selectCohortBrief", () => {
  it("returns a populated BuildBrief for a real build unit fixture", () => {
    const brief = selectCohortBrief(makeUnit(buildParams.artifact));
    expect(brief?.title).toBe("End-to-end, browser, offline and packaging acceptance");
    expect(brief?.repository_key).toBe("assay");
    expect(brief?.goal).toContain("Close out the required cases");
    expect(brief?.files_in_scope).toContain("tests/test_review_acceptance.py");
    expect(brief?.depends_on).toEqual(["review-cli", "frontend-bundle"]);
  });

  it("returns null for a scalar unit without a brief", () => {
    expect(selectCohortBrief(makeUnit(null))).toBeNull();
  });

  it("returns null for an assessor unit whose artifact is a dev.build_result body", () => {
    expect(selectCohortBrief(makeUnit(null))).toBeNull();
  });

  it("returns null when the frozen brief is absent", () => {
    expect(selectCohortBrief(makeUnit(null))).toBeNull();
  });
});

const stage = (units: StageUnit[]): StageDetail => ({ stage_instance_id: "stage", name: "spec_analysis", type: "delegated_session",
  status: "active", blocked_reason: null, next_actor: "core", delegated_kbbl_sid: null, worktree: null, artifacts: [], units });

it("a named singleton uses the collapsed stage row", () => {
  expect(selectStageHasCohortRows(stage([{ ...makeUnit(null), unit_id: "spec_analysis" }]))).toBe(false);
});
it("repository controls remain available for a single cohort", () => {
  expect(selectStageHasCohortRows(stage([{ ...makeUnit(null), worktree: { branch: "cohort/core", path: "/repo", base_ref: "main" } }]))).toBe(true);
});
it("artifacts follow cohort ownership even with absent or misleading labels", () => {
  const detail = { ...stage([makeUnit(null)]), artifacts: [
    { id: "ours", type_id: "dev.build_result", version: 2, cohort_id: "cohort", label: null },
    { id: "theirs", type_id: "dev.build_result", version: 1, cohort_id: "other", label: "cohort" },
  ] };
  expect(selectCohortArtifacts(detail, "cohort").map((artifact) => artifact.id)).toEqual(["ours"]);
});
it("gate labels describe the v15 worker review", () => {
  expect([selectGateLabel("assessment"), selectGateLabel("final_integration")]).toEqual(["Artifact review", "Merge confirmation"]);
});

it("a merge-wait control follows the authoritative diagnosis even when the unit projection lags", () => {
  expect(selectStageHasCohortRows(stage([makeUnit(null)]), [{ cohort_id: "acceptance-and-browser", stage_instance_id: "stage",
    unit_id: "acceptance-and-browser", pull_request_url: "https://example.test/pr/1" }])).toBe(true);
});
