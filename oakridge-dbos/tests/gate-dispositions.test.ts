import { expect, test } from "bun:test";

import { selectArtifactGateDisposition, selectBuiltInGateDisposition } from "../src/domain/gates";

test("the shared vocabulary covers the names the built-in gates ship with", () => {
  expect(["pass", "approve", "confirm_merged", "closed_without_merge"].map(selectBuiltInGateDisposition))
    .toEqual(["release", "release", "release", "release"]);
  expect(["rerun", "request_revision"].map(selectBuiltInGateDisposition)).toEqual(["revise", "revise"]);
  expect(selectBuiltInGateDisposition("fail")).toBe("terminal");
});

test("an assessment fail gate action requests changes instead of terminating its unit", () => {
  expect(selectArtifactGateDisposition("dev.assessment", selectBuiltInGateDisposition("fail"))).toBe("revise");
  expect(selectArtifactGateDisposition("dev.build_result", selectBuiltInGateDisposition("fail"))).toBe("terminal");
});
