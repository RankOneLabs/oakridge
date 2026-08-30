import { expect, test } from "bun:test";

import { selectBuiltInGateDisposition } from "../src/domain/gates";

test("the shared vocabulary covers the names the built-in gates ship with", () => {
  expect(["pass", "approve", "confirm_merged", "closed_without_merge"].map(selectBuiltInGateDisposition))
    .toEqual(["release", "release", "release", "release"]);
  expect(["rerun", "request_revision"].map(selectBuiltInGateDisposition)).toEqual(["revise", "revise"]);
  expect(selectBuiltInGateDisposition("fail")).toBe("terminal");
});
