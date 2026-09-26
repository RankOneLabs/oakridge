import { expect, test } from "bun:test";

import type { OutputReleaseContract } from "./compiled-workflow";
import { selectOutputReleasePolicy } from "./output-release-policy";

const gate: OutputReleaseContract = {
  kind: "gate",
  steps: [],
  requires_zero_open_review_items: false,
  revision_target: "self_stage",
};

test.each([
  [gate, { attention: "required", continuation: "waiting" }],
  [{ kind: "handoff", downstream_role: "assessment", external_wait_kind: "pull_request_merge" }, { attention: "optional", continuation: "waiting" }],
  [{ kind: "handoff", downstream_role: "assessment", external_wait_kind: "" }, { attention: "none", continuation: "waiting" }],
  [{ kind: "immediate" }, { attention: "none", continuation: "continuing" }],
] as const)("derives the compatible policy for %o", (release, expected) => {
  expect(selectOutputReleasePolicy(release, null)).toEqual(expected);
});
