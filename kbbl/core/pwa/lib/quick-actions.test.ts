import { afterEach, expect, it } from "vitest";
import type { Skill } from "../../runtime-interface";
import { DEFAULT_QUICK_ACTION_KEYS, quickActionKey, selectQuickActionIcon, selectQuickActions, selectToggledQuickActionKeys } from "./quick-actions";
import { QUICK_ACTIONS_STORAGE_KEY, readStoredQuickActionKeys, writeStoredQuickActionKeys } from "./storage";

const tool = (id: string, name: string): Skill => ({ id, name, description: "", backend: "codex", scope: "system", args: [], user_invocable: true, model_invocable: false });
afterEach(() => localStorage.clear());

it("keys tools independently of profile and commands by slash name", () => {
  expect(["cc", "codex"].map((profile) => quickActionKey(tool(profile + ":mcp:gated-review:get_review_round", "mcp:gated-review:get_review_round")))).toEqual([DEFAULT_QUICK_ACTION_KEYS[0], DEFAULT_QUICK_ACTION_KEYS[0]]);
  expect(quickActionKey(tool("agent-command:compact", "compact"))).toBe("/compact");
});
it("filters default keys against advertised actions in available order", () => {
  const review = tool("cc:mcp:gated-review:get_review_round", DEFAULT_QUICK_ACTION_KEYS[0]);
  const compact = tool("agent-command:compact", "compact");
  expect(selectQuickActions([review, compact], DEFAULT_QUICK_ACTION_KEYS)).toEqual([review, compact]);
  expect(selectQuickActions([review], DEFAULT_QUICK_ACTION_KEYS)).toEqual([review]);
  expect(selectQuickActions([review], ["absent"])).toEqual([]);
});
it("falls back on absent and malformed preferences and round trips valid keys", () => {
  expect(readStoredQuickActionKeys()).toEqual(DEFAULT_QUICK_ACTION_KEYS);
  for (const value of ["invalid", '[1]', '{}']) {
    localStorage.setItem(QUICK_ACTIONS_STORAGE_KEY, value);
    expect(readStoredQuickActionKeys()).toEqual(DEFAULT_QUICK_ACTION_KEYS);
  }
  writeStoredQuickActionKeys(["/compact"]);
  expect(readStoredQuickActionKeys()).toEqual(["/compact"]);
  writeStoredQuickActionKeys([]);
  expect(readStoredQuickActionKeys()).toEqual([]);
});


it("toggles one key while preserving the other choices and input", () => {
  const keys = ["/compact", "other"];
  expect(selectToggledQuickActionKeys(keys, "new")).toEqual(["/compact", "other", "new"]);
  expect(selectToggledQuickActionKeys(keys, "/compact")).toEqual(["other"]);
  expect(keys).toEqual(["/compact", "other"]);
});

it("gives the default quick actions their icons and any other action its initial", () => {
  expect(selectQuickActionIcon(tool("agent-command:compact", "compact"), "compact")).toBe("⇊");
  expect(selectQuickActionIcon(tool("cc:mcp:gated-review:get_review_round", "mcp:gated-review:get_review_round"), "get_review_round")).toBe("⟳");
  expect(selectQuickActionIcon(tool("cc:user:list-tasks", "list-tasks"), "list-tasks")).toBe("L");
});
