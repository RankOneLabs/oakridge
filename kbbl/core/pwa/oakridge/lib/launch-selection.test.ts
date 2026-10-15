import { describe, expect, test } from "vitest";
import type { RuntimeDescriptor } from "../../types";
import { coerceSelection } from "./launch-config";

describe("coerceSelection effort handling", () => {
  const claude: RuntimeDescriptor = {
    id: "claude-code",
    label: "Claude Code",
    models: [{ value: "claude-opus-4-8", label: "opus 4.8" }],
    efforts: [
      { value: "medium", label: "medium" },
      { value: "high", label: "high" },
    ],
    supportsCompaction: true,
  };
  const codex: RuntimeDescriptor = {
    id: "codex",
    label: "Codex",
    models: [{ value: "gpt-5.6-sol", label: "gpt-5.6 sol" }],
    efforts: [{ value: "minimal", label: "minimal" }],
    supportsCompaction: false,
  };
  const descriptors = [claude, codex];

  describe.each([
    { label: "advertised model", descriptor: claude },
    { label: "empty model descriptor", descriptor: { ...claude, models: [] } },
  ])("$label", ({ descriptor }) => {
    test("drops stale effort without changing a valid model", () => {
      const next = coerceSelection(
        "planner",
        { runtime: "claude-code", model: "claude-opus-4-8", effort: "minimal" },
        [descriptor],
        "claude-code",
        true,
      );
      expect(next).toEqual({
        runtime: "claude-code",
        model: "claude-opus-4-8",
        effort: undefined,
      });
    });

    test.each([null, undefined])("preserves no-override effort %s", (effort) => {
      const next = coerceSelection(
        "planner",
        { runtime: "claude-code", model: "claude-opus-4-8", effort },
        [descriptor],
        "claude-code",
        true,
      );
      expect(next.effort).toBe(effort);
    });
  });

  test("preserves an effort still valid for the unchanged runtime", () => {
    const next = coerceSelection(
      "planner",
      { runtime: "claude-code", model: "claude-opus-4-8", effort: "high" },
      descriptors,
      "codex", // default differs; runtimeTouched=true keeps the selected runtime
      true,
    );
    expect(next.effort).toBe("high");
  });

  test("drops an effort the (swapped) descriptor no longer advertises", () => {
    // Same runtime id, but the descriptor's effort set no longer includes the
    // stale level (e.g. fallback → server descriptor swap). Force a re-coerce
    // by changing the model so the early same-selection return is skipped.
    const next = coerceSelection(
      "planner",
      { runtime: "claude-code", model: "stale-model", effort: "minimal" },
      descriptors,
      "codex",
      true,
    );
    expect(next.effort).toBeUndefined();
  });

  test("drops the effort when the runtime changes", () => {
    const next = coerceSelection(
      "planner",
      { runtime: "codex", model: "gpt-5.6-sol", effort: "minimal" },
      descriptors,
      "claude-code",
      false, // not touched → coerces back to the default (claude-code) runtime
    );
    expect(next.runtime).toBe("claude-code");
    expect(next.effort).toBeUndefined();
  });
});
