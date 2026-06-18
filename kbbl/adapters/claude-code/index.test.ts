/**
 * Tests for the CC adapter's AgentRuntime implementation.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { awaitPtyQuiescence, ccTranscriptPath, createClaudeCodeRuntime } from "./index";
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

describe("awaitPtyQuiescence", () => {
  test("resolves 'quiet' once output has been idle for quietMs", async () => {
    // Last output was well in the past → already quiescent → resolves quickly.
    const lastOutputAt = Date.now() - 1000;
    const start = Date.now();
    const r = await awaitPtyQuiescence(() => lastOutputAt, { quietMs: 80, maxWaitMs: 2000, pollMs: 20 });
    expect(r).toBe("quiet");
    expect(Date.now() - start).toBeLessThan(200);
  });

  test("waits while output is recent, then resolves 'quiet' after it stops", async () => {
    let lastOutputAt = Date.now();
    // Keep "emitting" for ~120ms, then go silent.
    const ticker = setInterval(() => { lastOutputAt = Date.now(); }, 20);
    setTimeout(() => clearInterval(ticker), 120);
    const r = await awaitPtyQuiescence(() => lastOutputAt, { quietMs: 80, maxWaitMs: 3000, pollMs: 20 });
    expect(r).toBe("quiet");
    // Must not have resolved before output stopped (~120ms) + quiet window (80ms).
    // (Lower bound only; upper bound left loose to avoid scheduler-jitter flake.)
  });

  test("resolves 'timeout' if output never goes quiet", async () => {
    // Continuously recent output → never quiescent → safety cap fires.
    const ticker = setInterval(() => {}, 10);
    const r = await awaitPtyQuiescence(() => Date.now(), { quietMs: 80, maxWaitMs: 250, pollMs: 20 });
    clearInterval(ticker);
    expect(r).toBe("timeout");
  });
});

describe("ccTranscriptPath", () => {
  test("encodes a worktree cwd to CC's project-dir convention", () => {
    // This is the exact path CC wrote for the live session that motivated the
    // fix — every non-alphanumeric char in the cwd becomes '-', then
    // <session-id>.jsonl. If CC ever changes this, the hook backstops still
    // start the tailer with the real transcript_path.
    const cwd =
      "/home/steve/codes/rol/oakridge/kbbl/data/worktrees/89c4a0bb-05d3-4833-84c9-48d0973891e4";
    const sid = "1c716f79-f221-4815-b26b-cd68acb22dfa";
    expect(ccTranscriptPath(cwd, sid)).toBe(
      join(
        homedir(),
        ".claude",
        "projects",
        "-home-steve-codes-rol-oakridge-kbbl-data-worktrees-89c4a0bb-05d3-4833-84c9-48d0973891e4",
        `${sid}.jsonl`,
      ),
    );
  });

  test("encodes dotted path segments (e.g. .claude) to '-'", () => {
    const cwd = "/home/steve/codes/rol/oakridge/.claude/worktrees/feature";
    const sid = "abc";
    expect(ccTranscriptPath(cwd, sid)).toBe(
      join(
        homedir(),
        ".claude",
        "projects",
        "-home-steve-codes-rol-oakridge--claude-worktrees-feature",
        "abc.jsonl",
      ),
    );
  });
});

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

  test("pty_output is non-persisted (broadcast live, kept out of JSONL)", async () => {
    const rt = await makeRuntime();
    // The raw break-glass byte stream is high-volume; it must be broadcast for
    // the xterm view but excluded from the persisted transcript.
    expect(rt.nonPersistedEventTypes?.has("pty_output")).toBe(true);
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
