import { describe, expect, it } from "vitest";

import type { StageUnit } from "../types";
import { selectCohortBrief } from "./stage-unit-params";
import buildParams from "./__fixtures__/run-fd23c8b3-build-params.json";
import assessorParams from "./__fixtures__/run-fd23c8b3-assessor-params.json";

// Fixtures copied from a live GET /runs/:id payload (run
// fd23c8b3-e896-4928-8114-db3b8a490eaa), not written from the
// StageUnitParams type — that's exactly how the params type this
// replaces went wrong unnoticed: it compiled cleanly and rendered
// blank against every real build unit.

function makeUnit(params: StageUnit["params"]): StageUnit {
  return {
    unit_id: "acceptance-and-browser",
    repository_key: null,
    params,
    sid: null,
    worktree: null,
    status: "complete",
    gate: null,
  };
}

describe("selectCohortBrief", () => {
  it("returns a populated BuildBrief for a real build unit fixture", () => {
    const brief = selectCohortBrief(makeUnit(buildParams as StageUnit["params"]));
    expect(brief?.title).toBe("End-to-end, browser, offline and packaging acceptance");
    expect(brief?.repository_key).toBe("assay");
    expect(brief?.goal).toContain("Close out the required cases");
    expect(brief?.files_in_scope).toContain("tests/test_review_acceptance.py");
    expect(brief?.depends_on).toEqual(["review-cli", "frontend-bundle"]);
  });

  it("returns null for a scalar unit whose params is {}", () => {
    expect(selectCohortBrief(makeUnit({}))).toBeNull();
  });

  it("returns null for an assessor unit whose artifact is a dev.build_result body", () => {
    expect(selectCohortBrief(makeUnit(assessorParams as StageUnit["params"]))).toBeNull();
  });

  it("returns null when params is absent entirely", () => {
    expect(selectCohortBrief(makeUnit(null))).toBeNull();
  });
});
