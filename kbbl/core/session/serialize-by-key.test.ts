/**
 * The per-key serializer that keeps two ensures of one resumable session, or an
 * advance racing an ensure, from interleaving.
 */
import { expect, test } from "bun:test";

import { serializeByKey } from "./serialize-by-key";

const deferred = <Value>() => {
  let resolve: (value: Value) => void = () => undefined;
  let reject: (reason: Error) => void = () => undefined;
  const promise = new Promise<Value>((settle, fail) => { resolve = settle; reject = fail; });
  return { promise, resolve, reject };
};

test("work queued under one key runs in call order, never concurrently", async () => {
  const chains = new Map<string, Promise<unknown>>();
  const order: string[] = [];
  const first = deferred<void>();

  const a = serializeByKey(chains, "key", async () => { order.push("a:start"); await first.promise; order.push("a:end"); });
  const b = serializeByKey(chains, "key", async () => { order.push("b:start"); });

  // Queueing is synchronous but the work itself starts on a microtask, so let
  // the first one begin before asserting the second has not.
  await Promise.resolve();
  expect(order).toEqual(["a:start"]);
  first.resolve();
  await Promise.all([a, b]);
  expect(order).toEqual(["a:start", "a:end", "b:start"]);
});

test("different keys do not wait on each other", async () => {
  const chains = new Map<string, Promise<unknown>>();
  const blocked = deferred<void>();
  const held = serializeByKey(chains, "held", () => blocked.promise);
  expect(await serializeByKey(chains, "free", async () => "done")).toBe("done");
  blocked.resolve();
  await held;
});

test("a rejection is delivered to its own caller without poisoning the queue behind it", async () => {
  const chains = new Map<string, Promise<unknown>>();
  const failing = serializeByKey(chains, "key", async () => { throw new Error("boom"); });
  const following = serializeByKey(chains, "key", async () => "survived");
  await expect(failing).rejects.toThrow("boom");
  expect(await following).toBe("survived");
});

test("the chain entry is dropped once drained, so the map does not grow without bound", async () => {
  const chains = new Map<string, Promise<unknown>>();
  await serializeByKey(chains, "key", async () => undefined);
  // The cleanup runs on the tail's own continuation, one turn after the result.
  await Promise.resolve();
  await Promise.resolve();
  expect(chains.size).toBe(0);
});

test("a caller that already chained on is never dropped by a later cleanup", async () => {
  const chains = new Map<string, Promise<unknown>>();
  const results: string[] = [];
  const first = serializeByKey(chains, "key", async () => { results.push("first"); });
  const second = serializeByKey(chains, "key", async () => { results.push("second"); });
  await Promise.all([first, second]);
  expect(results).toEqual(["first", "second"]);
});
