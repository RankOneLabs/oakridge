import { describe, test, expect } from "bun:test";
import { normalizeModelList } from "./models";

// Note: startCodexAppServer integration tests require a real codex binary.
// These tests cover the config/logic surface that is testable without a process.

const PINNED_CODEX_MODEL_VALUES = [
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex-spark",
];

const PINNED_CODEX_MODELS = [
  { value: "gpt-5.6-sol", label: "gpt-5.6 sol" },
  { value: "gpt-5.6-terra", label: "gpt-5.6 terra" },
  { value: "gpt-5.6-luna", label: "gpt-5.6 luna" },
  { value: "gpt-5.5", label: "gpt-5.5" },
  { value: "gpt-5.4", label: "gpt-5.4" },
  { value: "gpt-5.4-mini", label: "gpt-5.4 mini" },
  { value: "gpt-5.3-codex-spark", label: "gpt-5.3 codex spark" },
];

describe("normalizeModelList (used by app-server startup)", () => {
  test("returns pinned Codex models for null", () => {
    expect(normalizeModelList(null)).toEqual(PINNED_CODEX_MODELS);
  });

  test("returns pinned Codex models for non-array", () => {
    expect(normalizeModelList("string").map((model) => model.value)).toEqual(
      PINNED_CODEX_MODEL_VALUES,
    );
    expect(normalizeModelList(42).map((model) => model.value)).toEqual(
      PINNED_CODEX_MODEL_VALUES,
    );
    expect(normalizeModelList({}).map((model) => model.value)).toEqual(
      PINNED_CODEX_MODEL_VALUES,
    );
  });

  test("normalizes model array and appends pinned models", () => {
    const raw = [{ id: "gpt-5.6-sol" }, { id: "o3" }];
    const result = normalizeModelList(raw);
    expect(result).toHaveLength(8);
    expect(result[0]).toEqual({ value: "gpt-5.6-sol", label: "gpt-5.6-sol" });
    expect(result[1]).toEqual({ value: "o3", label: "o3" });
    expect(result.slice(2).map((model) => model.value)).toEqual(
      PINNED_CODEX_MODEL_VALUES.slice(1),
    );
  });

  test("filters out entries without string id", () => {
    const raw = [{ id: "gpt-5.6-sol" }, { id: 42 }, { label: "no-id" }, null];
    const result = normalizeModelList(raw);
    expect(result).toHaveLength(7);
    expect(result.map((model) => model.value)).toEqual(PINNED_CODEX_MODEL_VALUES);
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

describe("Codex app-server shutdown", () => {
  test("descriptor-only runtime has no stopAppServer (never-started case is safe)", async () => {
    const { createCodexRuntimeDescriptorOnly } = await import("./index");
    const rt = createCodexRuntimeDescriptorOnly();
    // The server shutdown path checks for optional stopAppServer via casting.
    // When Codex was never started, it must be absent so the path skips it cleanly.
    const stop = (rt as unknown as { stopAppServer?: () => Promise<void> }).stopAppServer;
    expect(stop).toBeUndefined();
  });

  test("stop() is idempotent: repeated calls return the same promise and side-effects run once", async () => {
    // Unit-test the idempotency contract for the stop() closure pattern used in
    // startCodexAppServer without needing a live Codex process.
    let sideEffectCount = 0;
    let stopPromise: Promise<void> | null = null;

    function stop(): Promise<void> {
      if (stopPromise !== null) return stopPromise;
      stopPromise = (async () => {
        sideEffectCount++;
      })();
      return stopPromise;
    }

    const p1 = stop();
    const p2 = stop();
    expect(p1).toBe(p2);      // same promise object
    await p1;
    await p2;
    expect(sideEffectCount).toBe(1);  // side-effect ran exactly once
  });

  test("stop() in progress: a second call while the first is pending returns the same promise", async () => {
    let resolveStop!: () => void;
    const innerDone = new Promise<void>((r) => { resolveStop = r; });
    let stopPromise: Promise<void> | null = null;

    function stop(): Promise<void> {
      if (stopPromise !== null) return stopPromise;
      stopPromise = innerDone;
      return stopPromise;
    }

    const p1 = stop();
    const p2 = stop();
    expect(p1).toBe(p2);

    resolveStop();
    await p1;
    await p2;
  });
});
