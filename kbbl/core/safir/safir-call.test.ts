import { describe, expect, test } from "bun:test";

import { SafirHttpError } from "./client";
import type { QueueRequest, SafirQueue, QueueEntry } from "./queue";
import { safirCall } from "./safir-call";

function makeQueueStub(): {
  queue: SafirQueue;
  enqueued: QueueRequest[];
} {
  const enqueued: QueueRequest[] = [];
  const queue: SafirQueue = {
    async enqueue(req) {
      enqueued.push(req);
      return "stub-id";
    },
    async readPending(): Promise<QueueEntry[]> {
      return [];
    },
    async recordSuccess() {},
    async recordFailure() {},
    async compactIfAllDelivered() {},
  };
  return { queue, enqueued };
}

describe("safirCall", () => {
  test("2xx returns value, does not enqueue", async () => {
    const { queue, enqueued } = makeQueueStub();
    const result = await safirCall(
      { queue },
      async () => ({ ok: true }),
      { method: "POST", path: "/x", body: null },
    );
    expect(result).toEqual({ ok: true } as never);
    expect(enqueued).toEqual([]);
  });

  test("5xx enqueues and returns null", async () => {
    const { queue, enqueued } = makeQueueStub();
    const result = await safirCall(
      { queue },
      async () => {
        throw new SafirHttpError(503, { error: "down" });
      },
      { method: "POST", path: "/tasks/1/runs", body: { executor: "x" } },
    );
    expect(result).toBeNull();
    expect(enqueued.length).toBe(1);
    expect(enqueued[0]!.path).toBe("/tasks/1/runs");
  });

  test("network error (TypeError) enqueues and returns null", async () => {
    const { queue, enqueued } = makeQueueStub();
    const result = await safirCall(
      { queue },
      async () => {
        throw new TypeError("fetch failed");
      },
      { method: "PATCH", path: "/runs/abc", body: { status: "completed" } },
    );
    expect(result).toBeNull();
    expect(enqueued.length).toBe(1);
    expect(enqueued[0]!.method).toBe("PATCH");
  });

  test("4xx throws (does not enqueue)", async () => {
    const { queue, enqueued } = makeQueueStub();
    let caught: unknown;
    try {
      await safirCall(
        { queue },
        async () => {
          throw new SafirHttpError(400, { error: "bad" });
        },
        { method: "POST", path: "/x", body: null },
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SafirHttpError);
    expect((caught as SafirHttpError).status).toBe(400);
    expect(enqueued).toEqual([]);
  });

  test("non-SafirHttpError, non-TypeError re-throws", async () => {
    const { queue, enqueued } = makeQueueStub();
    let caught: unknown;
    try {
      await safirCall(
        { queue },
        async () => {
          throw new Error("some other error");
        },
        { method: "POST", path: "/x", body: null },
      );
    } catch (e) {
      caught = e;
    }
    expect((caught as Error).message).toBe("some other error");
    expect(enqueued).toEqual([]);
  });
});
