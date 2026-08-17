import { expect, test } from "bun:test";

import { selectBuiltInGateDisposition, selectGateDisposition, type GateAction } from "../src/domain/gates";

const steps: readonly GateAction[] = [
  { name: "approve", disposition: "release" },
  { name: "request_revision", disposition: "revise" },
];

test("a gate step's own declaration decides what its action does", () => {
  expect(selectGateDisposition("approve", steps)).toBe("release");
  expect(selectGateDisposition("request_revision", steps)).toBe("revise");
});

/**
 * The operator surface refuses an action the step never offered, so one
 * arriving here means the step changed under a decision already in flight.
 * Ending the unit is the safe reading; silently treating it as a release is not.
 */
test("an action the step never offered ends the unit rather than releasing it", () => {
  expect(selectGateDisposition("accept", steps)).toBe("terminal");
});

test("the shared vocabulary covers the names the built-in gates ship with", () => {
  expect(["pass", "approve", "confirm_merged", "closed_without_merge"].map(selectBuiltInGateDisposition))
    .toEqual(["release", "release", "release", "release"]);
  expect(["rerun", "request_revision"].map(selectBuiltInGateDisposition)).toEqual(["revise", "revise"]);
  expect(selectBuiltInGateDisposition("fail")).toBe("terminal");
});
