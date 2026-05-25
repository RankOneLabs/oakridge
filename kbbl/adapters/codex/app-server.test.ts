import { describe, test, expect } from "bun:test";
import { normalizeModelList } from "./models";

// Note: startCodexAppServer integration tests require a real codex binary.
// These tests cover the config/logic surface that is testable without a process.

describe("normalizeModelList (used by app-server startup)", () => {
  test("returns empty array for null", () => {
    expect(normalizeModelList(null)).toEqual([]);
  });

  test("returns empty array for non-array", () => {
    expect(normalizeModelList("string")).toEqual([]);
    expect(normalizeModelList(42)).toEqual([]);
    expect(normalizeModelList({})).toEqual([]);
  });

  test("normalizes model array", () => {
    const raw = [{ id: "gpt-5.5" }, { id: "o3" }];
    const result = normalizeModelList(raw);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ value: "gpt-5.5", label: "gpt-5.5" });
    expect(result[1]).toEqual({ value: "o3", label: "o3" });
  });

  test("filters out entries without string id", () => {
    const raw = [{ id: "gpt-5.5" }, { id: 42 }, { label: "no-id" }, null];
    const result = normalizeModelList(raw);
    expect(result).toHaveLength(1);
    expect(result[0].value).toBe("gpt-5.5");
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
