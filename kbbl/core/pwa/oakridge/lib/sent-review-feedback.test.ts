import { expect, it } from "vitest";

import { selectSentFeedbackTitle } from "./sent-review-feedback";

it.each([
  ["request_assessment_changes", "Assessment changes requested"],
  ["request_build_changes", "Build changes requested"],
  ["request_changes", "Changes requested"],
])("names %s as %s", (decision, title) => {
  expect(selectSentFeedbackTitle(decision)).toBe(title);
});
