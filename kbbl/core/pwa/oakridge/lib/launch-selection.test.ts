import { describe, expect, test } from "vitest";
import { makeRuntimeDescriptor, makeRuntimeSelection } from "../__fixtures__/read-models";
import { coerceRoleSelection } from "./runtime-selection";

const claude = makeRuntimeDescriptor();
const codex = makeRuntimeDescriptor({ id: "codex", label: "Codex",
  models: [{ value: "gpt-5.6-sol", label: "gpt-5.6 sol" }],
  efforts: [{ value: "minimal", label: "minimal" }], supportsCompaction: false });
const descriptors = [claude, codex] as const;

describe("coerceRoleSelection effort handling", () => {
  describe.each([
    { label: "advertised model", descriptor: claude },
    { label: "empty model descriptor", descriptor: makeRuntimeDescriptor({ models: [] }) },
  ])("$label", ({ descriptor }) => {
    test("drops stale effort without changing a valid model", () => {
      const next = coerceRoleSelection("planner", makeRuntimeSelection({ effort: "minimal" }), [descriptor], "claude-code", true);
      expect(next).toEqual(makeRuntimeSelection());
    });

    test.each([null, undefined])("preserves no-override effort %s", (effort) => {
      const next = coerceRoleSelection("planner", makeRuntimeSelection({ effort }), [descriptor], "claude-code", true);
      expect(next.effort).toBe(effort);
    });
  });

  test("preserves an effort still valid for the unchanged runtime", () => {
    const next = coerceRoleSelection("planner", makeRuntimeSelection({ effort: "high" }), [...descriptors], "codex", true);
    expect(next.effort).toBe("high");
  });

  test("drops an effort the swapped descriptor no longer advertises", () => {
    const next = coerceRoleSelection("planner", makeRuntimeSelection({ model: "stale-model", effort: "minimal" }),
      [...descriptors], "codex", true);
    expect(next.effort).toBeUndefined();
  });

  test("drops the effort when the runtime changes", () => {
    const next = coerceRoleSelection("planner", makeRuntimeSelection({ runtime: "codex", model: "gpt-5.6-sol", effort: "minimal" }),
      [...descriptors], "claude-code", false);
    expect(next.runtime).toBe("claude-code");
    expect(next.effort).toBeUndefined();
  });
});
