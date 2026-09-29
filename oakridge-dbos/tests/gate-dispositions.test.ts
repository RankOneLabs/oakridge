import { expect, test } from "bun:test";

import { selectArtifactGateDisposition, selectBuiltInGateDisposition } from "../src/domain/gates";
import { selectBuildGateEvent } from "../src/adapters/dev-flow-build";

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

test("both build-stage gates route only through explicit operator dispositions", () => {
  expect(selectBuildGateEvent("build_review", "release")).toEqual({ ok: true, value: { kind: "build_review_approved" } });
  expect(selectBuildGateEvent("build_review", "revise")).toEqual({ ok: true, value: { kind: "build_review_revision_requested" } });
  expect(selectBuildGateEvent("assessment_review", "release")).toEqual({ ok: true, value: { kind: "assessment_review_approved" } });
  expect(selectBuildGateEvent("assessment_review", "revise")).toEqual({ ok: true, value: { kind: "assessment_review_revision_requested" } });
  expect(selectBuildGateEvent("assessment_review", "terminal")).toEqual({ ok: false, error: "assessment_review does not have a terminal route" });
});
