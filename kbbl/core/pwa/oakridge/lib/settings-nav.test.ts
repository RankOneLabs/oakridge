import { expect, it } from "vitest";
import type { OakridgeSubRoute, SettingsSubRoute } from "../../lib/hash";
import { SETTINGS_NAV, selectSettingsNavItem } from "./settings-nav";

it.each<[OakridgeSubRoute | SettingsSubRoute, string]>([
  [{ sub: "status" }, "status"],
  [{ sub: "workflows" }, "workflows"],
  [{ sub: "workflow", id: "def-1", selection: null }, "workflows"],
  [{ sub: "grading-config", version: null }, "grading"],
  [{ sub: "grading-config", version: 3 }, "grading"],
])("puts %o under the %s entry", (route, item) => {
  expect(selectSettingsNavItem(route)).toBe(item);
});

it("has no Settings entry for an Oakridge route", () => {
  expect(selectSettingsNavItem({ sub: "runs" })).toBeNull();
});

it("links every entry the selector can return", () => {
  expect(SETTINGS_NAV.map((entry) => entry.item)).toEqual(["status", "workflows", "grading"]);
});
