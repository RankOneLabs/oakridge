import { describe, expect, test } from "vitest";
import { makeBuildBriefFixture } from "../__fixtures__/read-models";
import { selectFieldItems, selectFieldText } from "../artifact-types";

describe("checked build brief projection", () => {
  test("reads the registered brief's visible identity and goal", () => {
    const { body } = makeBuildBriefFixture();
    expect([selectFieldText(body, "cohort_id"), selectFieldText(body, "title"),
      selectFieldText(body, "goal")]).toEqual(["brief-ui", "Build brief review UI", "Make the brief reviewable."]);
  });

  test("reads a decision and its rationale through the pinned record schema", () => {
    const { body } = makeBuildBriefFixture();
    const decision = selectFieldItems(body, "decisions_made")[0];
    expect(decision && [selectFieldText(decision, "decision"), selectFieldText(decision, "rationale")])
      .toEqual(["Reuse v1", "It is proven."]);
  });
});
