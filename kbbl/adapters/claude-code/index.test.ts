/**
 * Tests for the CC adapter's AgentRuntime implementation.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { createClaudeCodeRuntime } from "./index";
import type { EnvelopeEvent } from "../../core/session/session";

let tmpRoot: string;
let dataDir: string;
let sessionsDir: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "kbbl-cc-test-"));
  dataDir = join(tmpRoot, "data");
  sessionsDir = join(tmpRoot, "sessions");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(sessionsDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

async function makeRuntime() {
  return createClaudeCodeRuntime({
    claudeBin: "claude",
    port: 8788,
    dataDir,
  });
}

describe("CC adapter descriptor", () => {
  test("has id claude-code", async () => {
    const rt = await makeRuntime();
    expect(rt.id).toBe("claude-code");
    expect(rt.descriptor.id).toBe("claude-code");
    expect(rt.descriptor.supportsCompaction).toBe(true);
  });

  test("descriptor.models excludes short aliases", async () => {
    const rt = await makeRuntime();
    const values = rt.descriptor.models.map((m) => m.value);
    // Short aliases (opus, sonnet, haiku) should not appear in the descriptor.
    expect(values.includes("opus")).toBe(false);
    expect(values.includes("sonnet")).toBe(false);
    expect(values.includes("haiku")).toBe(false);
    // At least one pinned model should be present.
    expect(values.some((v) => v.includes("-"))).toBe(true);
  });

  test("descriptor.label is non-empty string", async () => {
    const rt = await makeRuntime();
    expect(typeof rt.descriptor.label).toBe("string");
    expect(rt.descriptor.label.length).toBeGreaterThan(0);
  });
});

describe("CC adapter resolveResumeRef", () => {
  test("returns unknown for non-existent session", async () => {
    const rt = await makeRuntime();
    const ref = await rt.resolveResumeRef(sessionsDir, randomUUID());
    expect(ref.kind).toBe("unknown");
  });

  test("returns no_runtime_sid when cc_session_id_observed is missing", async () => {
    const sid = randomUUID();
    const events: EnvelopeEvent[] = [
      {
        id: 0,
        type: "session_started",
        ts: new Date().toISOString(),
        payload: { workdir: "/tmp", name: "test", sessionId: sid },
      },
    ];
    writeFileSync(
      join(sessionsDir, `${sid}.jsonl`),
      events.map((e) => JSON.stringify(e)).join("\n") + "\n",
    );
    const rt = await makeRuntime();
    const ref = await rt.resolveResumeRef(sessionsDir, sid);
    expect(ref.kind).toBe("no_runtime_sid");
  });

  test("resolves cc_session_id_observed → ok result", async () => {
    const sid = randomUUID();
    const ccSid = "cc-sid-test-123";
    const events: EnvelopeEvent[] = [
      {
        id: 0,
        type: "session_started",
        ts: new Date().toISOString(),
        payload: { workdir: "/tmp/myrepo", name: "test", sessionId: sid },
      },
      {
        id: 1,
        type: "cc_session_id_observed",
        ts: new Date().toISOString(),
        payload: { cc_session_id: ccSid },
      },
    ];
    writeFileSync(
      join(sessionsDir, `${sid}.jsonl`),
      events.map((e) => JSON.stringify(e)).join("\n") + "\n",
    );
    const rt = await makeRuntime();
    const ref = await rt.resolveResumeRef(sessionsDir, sid);
    expect(ref.kind).toBe("ok");
    if (ref.kind === "ok") {
      expect(ref.runtimeSid).toBe(ccSid);
      expect(ref.workdir).toBe("/tmp/myrepo");
    }
  });

  test("resolves runtime_session_observed (new event) → ok result", async () => {
    const sid = randomUUID();
    const runtimeSid = "runtime-sid-xyz";
    const events: EnvelopeEvent[] = [
      {
        id: 0,
        type: "session_started",
        ts: new Date().toISOString(),
        payload: { workdir: "/tmp/project", name: "test", sessionId: sid },
      },
      {
        id: 1,
        type: "runtime_session_observed",
        ts: new Date().toISOString(),
        payload: { runtime_sid: runtimeSid, runtime_id: "claude-code" },
      },
    ];
    writeFileSync(
      join(sessionsDir, `${sid}.jsonl`),
      events.map((e) => JSON.stringify(e)).join("\n") + "\n",
    );
    const rt = await makeRuntime();
    const ref = await rt.resolveResumeRef(sessionsDir, sid);
    expect(ref.kind).toBe("ok");
    if (ref.kind === "ok") {
      expect(ref.runtimeSid).toBe(runtimeSid);
      expect(ref.workdir).toBe("/tmp/project");
    }
  });
});

describe("CC adapter reconstructSnapshot", () => {
  test("extracts runtimeSid from cc_session_id_observed", async () => {
    const rt = await makeRuntime();
    const events: EnvelopeEvent[] = [
      {
        id: 0,
        type: "session_started",
        ts: "2026-01-01T00:00:00Z",
        payload: {},
      },
      {
        id: 1,
        type: "cc_session_id_observed",
        ts: "2026-01-01T00:00:01Z",
        payload: { cc_session_id: "cc-snap-sid" },
      },
    ];
    const contrib = rt.reconstructSnapshot(events);
    expect(contrib.runtimeSid).toBe("cc-snap-sid");
  });

  test("extracts tool_allowlisted entries", async () => {
    const rt = await makeRuntime();
    const events: EnvelopeEvent[] = [
      {
        id: 0,
        type: "session_started",
        ts: "2026-01-01T00:00:00Z",
        payload: {},
      },
      {
        id: 1,
        type: "tool_allowlisted",
        ts: "2026-01-01T00:00:01Z",
        payload: { tool_name: "Read" },
      },
      {
        id: 2,
        type: "tool_allowlisted",
        ts: "2026-01-01T00:00:02Z",
        payload: { tool_name: "Write" },
      },
    ];
    const contrib = rt.reconstructSnapshot(events);
    expect(contrib.allowedTools).toContain("Read");
    expect(contrib.allowedTools).toContain("Write");
  });

  test("extracts yoloMode from yolo_mode_changed", async () => {
    const rt = await makeRuntime();
    const events: EnvelopeEvent[] = [
      {
        id: 0,
        type: "session_started",
        ts: "2026-01-01T00:00:00Z",
        payload: {},
      },
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

  test("extracts initial and current observed models from model_observed", async () => {
    const rt = await makeRuntime();
    const events: EnvelopeEvent[] = [
      {
        id: 0,
        type: "session_started",
        ts: "2026-01-01T00:00:00Z",
        payload: {},
      },
      {
        id: 1,
        type: "model_observed",
        ts: "2026-01-01T00:00:01Z",
        payload: { model: "claude-sonnet-4-6" },
      },
      {
        id: 2,
        type: "model_observed",
        ts: "2026-01-01T00:00:02Z",
        payload: { model: "claude-haiku-4-5-20251001" },
      },
    ];
    const contrib = rt.reconstructSnapshot(events);
    expect(contrib.initialObservedModel).toBe("claude-sonnet-4-6");
    expect(contrib.observedModel).toBe("claude-haiku-4-5-20251001");
  });

  test("empty events → all null/empty", async () => {
    const rt = await makeRuntime();
    const contrib = rt.reconstructSnapshot([]);
    expect(contrib.runtimeSid).toBeNull();
    expect(contrib.yoloMode).toBe(false);
    expect(contrib.allowedTools).toEqual([]);
    expect(contrib.lastResultUsage).toBeNull();
    expect(contrib.initialObservedModel).toBeNull();
    expect(contrib.observedModel).toBeNull();
  });
});

describe("CC adapter nonPersistedEventTypes", () => {
  test("stream_event is not in nonPersistedEventTypes (PTY mode emits no stream_event)", async () => {
    const rt = await makeRuntime();
    // In PTY mode the byte stream is never parsed, so stream_event is never
    // emitted and does not need to be filtered from the transcript.
    expect(rt.nonPersistedEventTypes?.has("stream_event")).toBe(false);
  });
});

describe("CC adapter lookupByCcSid (extension methods)", () => {
  test("lookupByCcSid returns undefined when no sessions registered", async () => {
    const rt = await makeRuntime() as ReturnType<typeof createClaudeCodeRuntime> extends Promise<infer T> ? T : never;
    const lookup = (rt as { lookupByCcSid?: (s: string) => unknown }).lookupByCcSid;
    if (lookup) {
      expect(lookup("cc-xxx")).toBeUndefined();
    }
  });
});
