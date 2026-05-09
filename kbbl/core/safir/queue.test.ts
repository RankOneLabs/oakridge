import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSafirQueue, type QueueEntry } from "./queue";

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "kbbl-safir-queue-"));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe("createSafirQueue", () => {
  test("missing file = empty queue", async () => {
    const q = createSafirQueue({ dataDir });
    const pending = await q.readPending(new Date());
    expect(pending).toEqual([]);
  });

  test("enqueue creates file; readPending returns entry", async () => {
    const q = createSafirQueue({ dataDir });
    const id = await q.enqueue({
      method: "POST",
      path: "/tasks/1/runs",
      body: { executor: "claude_code" },
    });
    expect(typeof id).toBe("string");
    const pending = await q.readPending(new Date());
    expect(pending.length).toBe(1);
    expect(pending[0]!.id).toBe(id);
    expect(pending[0]!.attempts).toBe(0);
    expect(pending[0]!.request.path).toBe("/tasks/1/runs");
  });

  test("recordSuccess sets delivered_at; readPending excludes it", async () => {
    const q = createSafirQueue({ dataDir });
    const id = await q.enqueue({ method: "POST", path: "/x", body: null });
    await q.recordSuccess(id);
    const pending = await q.readPending(new Date());
    expect(pending).toEqual([]);
    const raw = await readFile(join(dataDir, "safir-queue.jsonl"), "utf8");
    const entry = JSON.parse(raw.trim()) as QueueEntry;
    expect(typeof entry.delivered_at).toBe("string");
  });

  test("recordFailure bumps attempts and pushes next_attempt_at by 2^n * 30s", async () => {
    const q = createSafirQueue({ dataDir });
    const now = new Date("2026-05-09T00:00:00.000Z");
    const id = await q.enqueue({ method: "POST", path: "/x", body: null });

    await q.recordFailure(id, "boom", now);
    let entries = await q.readPending(new Date(now.getTime() + 365 * 24 * 3600 * 1000));
    let entry = entries.find((e) => e.id === id)!;
    expect(entry.attempts).toBe(1);
    // 2^1 * 30 = 60s
    expect(new Date(entry.next_attempt_at).getTime() - now.getTime()).toBe(
      60 * 1000,
    );
    expect(entry.last_error).toBe("boom");

    await q.recordFailure(id, "again", now);
    entries = await q.readPending(new Date(now.getTime() + 365 * 24 * 3600 * 1000));
    entry = entries.find((e) => e.id === id)!;
    expect(entry.attempts).toBe(2);
    // 2^2 * 30 = 120s
    expect(new Date(entry.next_attempt_at).getTime() - now.getTime()).toBe(
      120 * 1000,
    );
  });

  test("recordFailure backoff caps at 30 minutes", async () => {
    const q = createSafirQueue({ dataDir });
    const now = new Date("2026-05-09T00:00:00.000Z");
    const id = await q.enqueue({ method: "POST", path: "/x", body: null });
    // Push attempts to a value where 2^n * 30s > 30min.
    for (let i = 0; i < 8; i++) {
      await q.recordFailure(id, "e", now);
    }
    const entries = await q.readPending(
      new Date(now.getTime() + 365 * 24 * 3600 * 1000),
    );
    const entry = entries.find((e) => e.id === id)!;
    expect(entry.attempts).toBe(8);
    expect(new Date(entry.next_attempt_at).getTime() - now.getTime()).toBe(
      30 * 60 * 1000,
    );
  });

  test("readPending honors next_attempt_at", async () => {
    const q = createSafirQueue({ dataDir });
    const now = new Date("2026-05-09T00:00:00.000Z");
    const id = await q.enqueue({ method: "POST", path: "/x", body: null });
    await q.recordFailure(id, "boom", now);
    // 60s from now — not yet ready.
    const tooEarly = new Date(now.getTime() + 30 * 1000);
    expect(await q.readPending(tooEarly)).toEqual([]);
    const ready = new Date(now.getTime() + 61 * 1000);
    expect((await q.readPending(ready)).length).toBe(1);
  });

  test("compactIfAllDelivered rewrites file empty when all delivered", async () => {
    const q = createSafirQueue({ dataDir });
    const id1 = await q.enqueue({ method: "POST", path: "/a", body: null });
    const id2 = await q.enqueue({ method: "POST", path: "/b", body: null });
    await q.recordSuccess(id1);
    await q.recordSuccess(id2);
    await q.compactIfAllDelivered();
    const raw = await readFile(join(dataDir, "safir-queue.jsonl"), "utf8");
    expect(raw).toBe("");
  });

  test("compactIfAllDelivered no-op when any entry pending", async () => {
    const q = createSafirQueue({ dataDir });
    const id1 = await q.enqueue({ method: "POST", path: "/a", body: null });
    await q.enqueue({ method: "POST", path: "/b", body: null });
    await q.recordSuccess(id1);
    await q.compactIfAllDelivered();
    const raw = await readFile(join(dataDir, "safir-queue.jsonl"), "utf8");
    // Two lines remain (the delivered one + the still-pending one).
    expect(raw.split("\n").filter((l) => l.length > 0).length).toBe(2);
  });

  test("entries with 5+ failures stay readable (worker enforces cap)", async () => {
    const q = createSafirQueue({ dataDir });
    const now = new Date("2026-05-09T00:00:00.000Z");
    const id = await q.enqueue({ method: "POST", path: "/x", body: null });
    for (let i = 0; i < 6; i++) {
      await q.recordFailure(id, "e", now);
    }
    // The queue itself still surfaces it (worker is responsible for the
    // 5-strike skip) — readable, not delivered.
    const farFuture = new Date(now.getTime() + 365 * 24 * 3600 * 1000);
    const pending = await q.readPending(farFuture);
    expect(pending.length).toBe(1);
    expect(pending[0]!.attempts).toBe(6);
    expect(pending[0]!.delivered_at).toBeUndefined();
  });
});
