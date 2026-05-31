import { describe, expect, test } from "bun:test";
import { runExclusive } from "./keyed-mutex";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("runExclusive", () => {
  test("serializes calls sharing a key", async () => {
    const order: string[] = [];
    const gateA = deferred();
    const gateB = deferred();
    let active = 0;
    let maxActive = 0;

    const a = runExclusive("repo", async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      order.push("a:start");
      await gateA.promise;
      order.push("a:end");
      active--;
    });
    const b = runExclusive("repo", async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      order.push("b:start");
      await gateB.promise;
      order.push("b:end");
      active--;
    });

    // Flush microtasks: only the first holder may have started; the second is
    // queued behind it and cannot run until gateA releases.
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["a:start"]);

    gateA.resolve();
    gateB.resolve();
    await Promise.all([a, b]);

    expect(maxActive).toBe(1);
    expect(order).toEqual(["a:start", "a:end", "b:start", "b:end"]);
  });

  test("different keys run concurrently", async () => {
    const order: string[] = [];
    const gate = deferred();

    const blocked = runExclusive("repo-1", async () => {
      order.push("k1:start");
      await gate.promise;
      order.push("k1:end");
    });
    const free = runExclusive("repo-2", async () => {
      order.push("k2:done");
    });

    await free;
    expect(order).toContain("k2:done");
    expect(order).not.toContain("k1:end");

    gate.resolve();
    await blocked;
    expect(order).toContain("k1:end");
  });

  test("a rejected call does not poison later waiters on the same key", async () => {
    const failing = runExclusive("repo", async () => {
      throw new Error("boom");
    });
    await expect(failing).rejects.toThrow("boom");

    const next = runExclusive("repo", async () => "ok");
    expect(await next).toBe("ok");
  });
});
