import { expect, test } from "bun:test";

import { selectHandoffStatusFromWait } from "../src/domain/wait";

test("a cancelled wait of either kind maps to cancelled", () => {
  expect(selectHandoffStatusFromWait("handoff_external", "closed", "cancelled")).toBe("cancelled");
  expect(selectHandoffStatusFromWait("handoff_downstream", "closed", "cancelled")).toBe("cancelled");
});

test("an open external wait maps to awaiting_external", () => {
  expect(selectHandoffStatusFromWait("handoff_external", "open", null)).toBe("awaiting_external");
});

test("a completed external wait maps to released", () => {
  expect(selectHandoffStatusFromWait("handoff_external", "closed", "external_completed")).toBe("released");
});

test("an open downstream wait maps to awaiting_downstream", () => {
  expect(selectHandoffStatusFromWait("handoff_downstream", "open", null)).toBe("awaiting_downstream");
});

test("a decided downstream wait maps to revision_requested", () => {
  expect(selectHandoffStatusFromWait("handoff_downstream", "closed", "decided")).toBe("revision_requested");
});

test("a superseded wait of either kind maps to superseded", () => {
  expect(selectHandoffStatusFromWait("handoff_downstream", "closed", "superseded")).toBe("superseded");
  expect(selectHandoffStatusFromWait("handoff_external", "closed", "superseded")).toBe("superseded");
});

test("a withdrawn wait of either kind maps to withdrawn", () => {
  expect(selectHandoffStatusFromWait("handoff_downstream", "closed", "withdrawn")).toBe("withdrawn");
  expect(selectHandoffStatusFromWait("handoff_external", "closed", "withdrawn")).toBe("withdrawn");
});
