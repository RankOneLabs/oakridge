import { describe, expect, it } from "vitest";

import type { StageUnit } from "../types";
import { selectCohortBrief } from "./stage-unit-params";
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
