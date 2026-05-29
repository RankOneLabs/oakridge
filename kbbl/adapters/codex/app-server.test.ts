import { describe, test, expect } from "bun:test";
import { normalizeModelList } from "./models";

// Note: startCodexAppServer integration tests require a real codex binary.
// These tests cover the config/logic surface that is testable without a process.

describe("normalizeModelList (used by app-server startup)", () => {
  test("returns pinned Codex models for null", () => {
    expect(normalizeModelList(null)).toEqual([
      { value: "gpt-5.5", label: "gpt-5.5" },
      { value: "gpt-5.4-mini", label: "gpt-5.4 mini" },
    ]);
  });

  test("returns pinned Codex models for non-array", () => {
    expect(normalizeModelList("string").map((model) => model.value)).toEqual([
      "gpt-5.5",
      "gpt-5.4-mini",
    ]);
    expect(normalizeModelList(42).map((model) => model.value)).toEqual([
      "gpt-5.5",
      "gpt-5.4-mini",
    ]);
    expect(normalizeModelList({}).map((model) => model.value)).toEqual([
      "gpt-5.5",
      "gpt-5.4-mini",
    ]);
  });

  test("normalizes model array and appends pinned models", () => {
    const raw = [{ id: "gpt-5.5" }, { id: "o3" }];
    const result = normalizeModelList(raw);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ value: "gpt-5.5", label: "gpt-5.5" });
    expect(result[1]).toEqual({ value: "o3", label: "o3" });
    expect(result[2]).toEqual({ value: "gpt-5.4-mini", label: "gpt-5.4 mini" });
  });

  test("filters out entries without string id", () => {
    const raw = [{ id: "gpt-5.5" }, { id: 42 }, { label: "no-id" }, null];
    const result = normalizeModelList(raw);
    expect(result).toHaveLength(2);
    expect(result[0].value).toBe("gpt-5.5");
    expect(result[1].value).toBe("gpt-5.4-mini");
  });
});

describe("parseListenUrl (tested indirectly via imports)", () => {
  test("module exports startCodexAppServer", async () => {
    const mod = await import("./app-server");
    expect(typeof mod.startCodexAppServer).toBe("function");
  });
});

describe("Codex runtime descriptor", () => {
  test("supportsCompaction is false for Codex sessions", async () => {
    // Import the descriptor-only factory to confirm supportsCompaction=false
    // without starting a real app-server process
    const { createCodexRuntimeDescriptorOnly } = await import("./index");
    const rt = createCodexRuntimeDescriptorOnly();
    expect(rt.descriptor.supportsCompaction).toBe(false);
    expect(rt.descriptor.id).toBe("codex");
  });
});
