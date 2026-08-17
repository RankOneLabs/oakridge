import { expect, test } from "bun:test";

import { sharedCursor } from "../src/http/shared-cursor";

test("concurrent clients share one read instead of each issuing their own", async () => {
  let reads = 0;
  const cursor = sharedCursor(async () => { reads += 1; return "cursor-1"; });
  expect(await Promise.all([cursor(), cursor(), cursor()])).toEqual(["cursor-1", "cursor-1", "cursor-1"]);
  expect(reads).toBe(1);
});

test("a cursor is re-read once its window has passed", async () => {
  let reads = 0;
  let clock = 0;
  const cursor = sharedCursor(async () => { reads += 1; return `cursor-${reads}`; }, { ttl_ms: 100, now: () => clock });
  expect(await cursor()).toBe("cursor-1");
  clock = 50;
  expect(await cursor()).toBe("cursor-1");
  clock = 150;
  expect(await cursor()).toBe("cursor-2");
  expect(reads).toBe(2);
});

test("a failed read is reported and never cached, so the next poll retries", async () => {
  let reads = 0;
  const cursor = sharedCursor(async () => { reads += 1; if (reads === 1) throw new Error("database down"); return "cursor-1"; });
  await expect(cursor()).rejects.toThrow("database down");
  expect(await cursor()).toBe("cursor-1");
});
