import { describe, expect, test } from "vitest";
import { makeBuildBriefFixture } from "../__fixtures__/read-models";
import { selectFieldItems, selectFieldText } from "../artifact-types";

describe("checked build brief projection", () => {
  test("reads the registered brief's visible identity and goal", () => {
    const { body, schemas } = makeBuildBriefFixture();
    expect([selectFieldText(body, schemas, "cohort_id"), selectFieldText(body, schemas, "title"),
      selectFieldText(body, schemas, "goal")]).toEqual(["brief-ui", "Build brief review UI", "Make the brief reviewable."]);
  });

  test("reads a decision and its rationale through the pinned record schema", () => {
    const { body, schemas } = makeBuildBriefFixture();
    const decision = selectFieldItems(body, schemas, "decisions_made")[0];
    expect(decision && [selectFieldText(decision, schemas, "decision"), selectFieldText(decision, schemas, "rationale")])
      .toEqual(["Reuse v1", "It is proven."]);
  });
});
