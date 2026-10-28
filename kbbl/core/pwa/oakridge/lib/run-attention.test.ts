import { describe, expect, it } from "vitest";

import type { ReviewInboxItem } from "../types";
import { selectAttentionContext, selectRepositoryAttentionContext, selectReviewCohortKey, selectRunAttentionCounts, selectUnitAttentionLabel } from "./run-attention";

function inboxItem(
  id: string,
  runId: string,
  state: ReviewInboxItem["state"],
  blockedBy: string[] = [],
  kind: ReviewInboxItem["kind"] = "cohort_blocked",
): ReviewInboxItem {
  return {
    id,
    kind,
    state,
    run_id: runId,
    workflow_name: "spec_to_ship",
    stage_instance_id: "stage-1",
    stage_name: "build",
    unit_id: "unit-1",
    cohort_key: null,
    brief_title: null,
    repository_key: null,
    lifecycle: "building",
    resume_actions: [],
    blocked_by: blockedBy,
  };
}

describe("selectRunAttentionCounts", () => {
  it("groups actionable items by run", () => {
    const counts = selectRunAttentionCounts([
      inboxItem("one", "run-a", "actionable"),
      inboxItem("two", "run-a", "actionable"),
      inboxItem("three", "run-b", "actionable"),
    ]);

    expect([...counts]).toEqual([["run-a", 2], ["run-b", 1]]);
  });

  it("does not treat a downstream handoff wait as attention", () => {
    const counts = selectRunAttentionCounts([
      inboxItem("wait", "run-a", "blocked", ["handoff_downstream"]),
    ]);

    expect(counts.get("run-a")).toBeUndefined();
  });

  it("counts a pull request mismatch even when its backend state is blocked", () => {
    const counts = selectRunAttentionCounts([
      inboxItem("mismatch", "run-a", "blocked", [], "pull_request_mismatch"),
    ]);

    expect(counts.get("run-a")).toBe(1);
  });
});

it("keeps cohort identities separate across stages", () => {
  const gate = inboxItem("gate", "run-a", "actionable");
  gate.unit_id = "0";
  const other = { ...gate, stage_instance_id: "stage-2" };
  const cohorts = new Map([
    [selectReviewCohortKey(gate), "gate stage"],
    [selectReviewCohortKey(other), "other stage"],
  ]);

  expect([cohorts.get(selectReviewCohortKey(gate)), cohorts.get(selectReviewCohortKey(other))])
    .toEqual(["gate stage", "other stage"]);
});

it("names the run and artifact around attention work", () => {
  expect(selectAttentionContext({ run_title: "import validation", artifact_key: "brief" }))
    .toBe("import validation · brief");
});

it("leaves out context the work does not have", () => {
  expect(selectAttentionContext({ run_title: null, artifact_key: null })).toBe("");
});

describe("selectRepositoryAttentionContext", () => {
  const repository_key = "oakridge" as ReviewInboxItem["repository_key"];

  it("leads the run and artifact with the repository", () => {
    expect(selectRepositoryAttentionContext({ repository_key, run_title: "import validation", artifact_key: "brief" }))
      .toBe("oakridge · import validation · brief");
  });

  it("leaves out a repository the work does not have", () => {
    expect(selectRepositoryAttentionContext({ repository_key: null, run_title: "import validation", artifact_key: "brief" }))
      .toBe("import validation · brief");
  });
});

describe("selectUnitAttentionLabel", () => {
  const complete = { cohort_key: "api", brief_title: "Build the API", repository_key: "oakridge" as ReviewInboxItem["repository_key"] };

  it("names the cohort, brief and repository in that order", () => {
    expect(selectUnitAttentionLabel(complete)).toBe("api · Build the API · oakridge");
  });

  it.each([
    [{ ...complete, cohort_key: null }, "Build the API · oakridge"],
    [{ ...complete, brief_title: null }, "api · oakridge"],
    [{ ...complete, repository_key: null }, "api · Build the API"],
    [{ ...complete, brief_title: "" }, "api · oakridge"],
    [{ ...complete, brief_title: "   " }, "api · oakridge"],
  ])("omits one absent or empty part", (input, expected) => {
    expect(selectUnitAttentionLabel(input)).toBe(expected);
  });

  it("returns an empty string when every part is absent", () => {
    expect(selectUnitAttentionLabel({ cohort_key: null, brief_title: null, repository_key: null })).toBe("");
  });
});
