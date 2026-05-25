import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { createCodexRuntimeDescriptorOnly } from "./index";
import { CODEX_NON_PERSISTED_EVENT_TYPES } from "./events";

describe("Codex adapter descriptor", () => {
  test("id is 'codex'", () => {
    const rt = createCodexRuntimeDescriptorOnly();
    expect(rt.id).toBe("codex");
    expect(rt.descriptor.id).toBe("codex");
  });

  test("supportsCompaction is false", () => {
    const rt = createCodexRuntimeDescriptorOnly();
    expect(rt.descriptor.supportsCompaction).toBe(false);
  });

  test("label is set", () => {
    const rt = createCodexRuntimeDescriptorOnly();
    expect(typeof rt.descriptor.label).toBe("string");
    expect(rt.descriptor.label.length).toBeGreaterThan(0);
  });

  test("models array is empty by default", () => {
    const rt = createCodexRuntimeDescriptorOnly();
    expect(Array.isArray(rt.descriptor.models)).toBe(true);
    expect(rt.descriptor.models).toHaveLength(0);
  });

  test("models can be provided", () => {
    const rt = createCodexRuntimeDescriptorOnly([
      { value: "gpt-5.5", label: "gpt-5.5" },
    ]);
    expect(rt.descriptor.models).toHaveLength(1);
    expect(rt.descriptor.models[0].value).toBe("gpt-5.5");
  });
});

describe("resolveResumeRef", () => {
  test("returns unknown for non-existent session", async () => {
    const rt = createCodexRuntimeDescriptorOnly();
    const tmpDir = mkdtempSync(join(tmpdir(), "kbbl-codex-test-"));
    try {
      const ref = await rt.resolveResumeRef(tmpDir, randomUUID());
      expect(ref.kind).toBe("unknown");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("returns no_runtime_sid when JSONL has no runtime_session_observed", async () => {
    const rt = createCodexRuntimeDescriptorOnly();
    const tmpDir = mkdtempSync(join(tmpdir(), "kbbl-codex-test-"));
    try {
      const sid = randomUUID();
      const jsonlPath = join(tmpDir, `${sid}.jsonl`);
      await Bun.write(
        jsonlPath,
        JSON.stringify({
          id: 0,
          type: "session_started",
          ts: "2026-01-01T00:00:00Z",
          payload: { workdir: "/tmp" },
        }) + "\n",
      );
      const ref = await rt.resolveResumeRef(tmpDir, sid);
      expect(ref.kind).toBe("no_runtime_sid");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("extracts threadId from runtime_session_observed with runtime_sid", async () => {
    const rt = createCodexRuntimeDescriptorOnly();
    const tmpDir = mkdtempSync(join(tmpdir(), "kbbl-codex-test-"));
    try {
      const sid = randomUUID();
      const threadId = "019e5d59-ab67-7a60-9778-27600d80f3df";
      const jsonlPath = join(tmpDir, `${sid}.jsonl`);
      const lines = [
        JSON.stringify({
          id: 0,
          type: "session_started",
          ts: "2026-01-01T00:00:00Z",
          payload: { workdir: "/tmp/project" },
        }),
        JSON.stringify({
          id: 1,
          type: "runtime_session_observed",
          ts: "2026-01-01T00:00:01Z",
          payload: { runtime_sid: threadId, runtime_id: "codex" },
        }),
      ];
      await Bun.write(jsonlPath, lines.join("\n") + "\n");

      const ref = await rt.resolveResumeRef(tmpDir, sid);
      expect(ref.kind).toBe("ok");
      if (ref.kind === "ok") {
        expect(ref.runtimeSid).toBe(threadId);
        expect(ref.workdir).toBe("/tmp/project");
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("reconstructSnapshot", () => {
  const rt = createCodexRuntimeDescriptorOnly();

  test("returns zeroed state for empty events", () => {
    const contrib = rt.reconstructSnapshot([]);
    expect(contrib.runtimeSid).toBeNull();
    expect(contrib.yoloMode).toBe(false);
    expect(contrib.allowedTools).toEqual([]);
    expect(contrib.lastResultUsage).toBeNull();
    expect(contrib.observedModel).toBeNull();
  });

  test("reads yolo_mode_changed", () => {
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

  test("reads tool_allowlisted", () => {
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

  test("reads runtime_session_observed → runtimeSid", () => {
    const events = [
      {
        id: 0,
        type: "runtime_session_observed",
        ts: "2026-01-01T00:00:00Z",
        payload: { runtime_sid: "thread-xyz", runtime_id: "codex" },
      },
    ];
    const contrib = rt.reconstructSnapshot(events);
    expect(contrib.runtimeSid).toBe("thread-xyz");
  });

  test("reads model_observed", () => {
    const events = [
      {
        id: 0,
        type: "model_observed",
        ts: "2026-01-01T00:00:00Z",
        payload: { model: "gpt-5.5" },
      },
    ];
    const contrib = rt.reconstructSnapshot(events);
    expect(contrib.observedModel).toBe("gpt-5.5");
  });
});

describe("isAllowedModel", () => {
  test("returns true for models in the list", () => {
    const rt = createCodexRuntimeDescriptorOnly([
      { value: "gpt-5.5", label: "gpt-5.5" },
      { value: "o3", label: "o3" },
    ]);
    expect(rt.isAllowedModel?.("gpt-5.5")).toBe(true);
    expect(rt.isAllowedModel?.("o3")).toBe(true);
  });

  test("returns false for models not in the list", () => {
    const rt = createCodexRuntimeDescriptorOnly([
      { value: "gpt-5.5", label: "gpt-5.5" },
    ]);
    expect(rt.isAllowedModel?.("claude-opus-4-5")).toBe(false);
  });

  test("isAllowedModel is undefined when no models provided (no gating)", () => {
    const rt = createCodexRuntimeDescriptorOnly([]);
    expect(rt.isAllowedModel).toBeUndefined();
  });
});

describe("nonPersistedEventTypes", () => {
  test("includes assistant_delta", () => {
    const rt = createCodexRuntimeDescriptorOnly();
    expect(rt.nonPersistedEventTypes?.has("assistant_delta")).toBe(true);
  });

  test("includes codex_approval_server_request", () => {
    const rt = createCodexRuntimeDescriptorOnly();
    expect(rt.nonPersistedEventTypes?.has("codex_approval_server_request")).toBe(true);
  });

  test("is a Set", () => {
    const rt = createCodexRuntimeDescriptorOnly();
    expect(rt.nonPersistedEventTypes instanceof Set).toBe(true);
  });

  test("matches CODEX_NON_PERSISTED_EVENT_TYPES", () => {
    const rt = createCodexRuntimeDescriptorOnly();
    for (const type of CODEX_NON_PERSISTED_EVENT_TYPES) {
      expect(rt.nonPersistedEventTypes?.has(type)).toBe(true);
    }
  });
});
