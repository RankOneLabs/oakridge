// Cross-runtime conformance harness. Tests the AgentRuntime contract.
// Usage: import and call runConformanceTests in your adapter test file.

import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentRuntime, RuntimeId } from "./runtime";

export interface ConformanceRunnerOpts {
  makeRuntime: () => Promise<AgentRuntime>;
  runtimeId: RuntimeId;
}

export function runConformanceTests(opts: ConformanceRunnerOpts): void {
  describe(`AgentRuntime conformance: ${opts.runtimeId}`, () => {
    test("descriptor.id matches runtime.id", async () => {
      const rt = await opts.makeRuntime();
      expect(rt.id).toBe(opts.runtimeId);
      expect(rt.descriptor.id).toBe(opts.runtimeId);
    });

    test("descriptor has required fields", async () => {
      const rt = await opts.makeRuntime();
      expect(typeof rt.descriptor.label).toBe("string");
      expect(Array.isArray(rt.descriptor.models)).toBe(true);
      expect(typeof rt.descriptor.supportsCompaction).toBe("boolean");
    });

    test("resolveResumeRef returns unknown for non-existent session", async () => {
      const rt = await opts.makeRuntime();
      const tmpDir = mkdtempSync(join(tmpdir(), "kbbl-conform-"));
      try {
        const ref = await rt.resolveResumeRef(tmpDir, randomUUID());
        expect(ref.kind).toBe("unknown");
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    test("reconstructSnapshot from empty events returns zeroed state", async () => {
      const rt = await opts.makeRuntime();
      const contrib = rt.reconstructSnapshot([]);
      expect(contrib.runtimeSid).toBeNull();
      expect(contrib.yoloMode).toBe(false);
      expect(contrib.allowedTools).toEqual([]);
      expect(contrib.lastResultUsage).toBeNull();
      expect(contrib.observedModel).toBeNull();
    });

    test("reconstructSnapshot reads yolo_mode_changed", async () => {
      const rt = await opts.makeRuntime();
      const events = [
        { id: 0, type: "session_started", ts: "2026-01-01T00:00:00Z", payload: {} },
        {
          id: 1,
          type: "yolo_mode_changed",
          ts: "2026-01-01T00:00:01Z",
          payload: { enabled: true },
        },
      ];
      const contrib = rt.reconstructSnapshot(events);
      expect(contrib.yoloMode).toBe(true);
    });

    test("reconstructSnapshot reads tool_allowlisted", async () => {
      const rt = await opts.makeRuntime();
      const events = [
        { id: 0, type: "session_started", ts: "2026-01-01T00:00:00Z", payload: {} },
        {
          id: 1,
          type: "tool_allowlisted",
          ts: "2026-01-01T00:00:01Z",
          payload: { tool_name: "Read" },
        },
      ];
      const contrib = rt.reconstructSnapshot(events);
      expect(contrib.allowedTools).toContain("Read");
    });

    test("nonPersistedEventTypes is a Set if present", async () => {
      const rt = await opts.makeRuntime();
      if (rt.nonPersistedEventTypes) {
        expect(rt.nonPersistedEventTypes instanceof Set).toBe(true);
      }
    });
  });
}
