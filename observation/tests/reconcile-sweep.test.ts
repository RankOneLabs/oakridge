import { expect, test } from "bun:test";
import { startReconcileSweep } from "../src/main";
import type { TenantScope } from "../src/storage/database";

const tenant: TenantScope = { producer: "oakridge", namespace: "sweep-test" };

test("a sweep slower than its interval is never overlapped or queued behind", async () => {
  let running = 0;
  let overlapped = false;
  let started = 0;
  const slow = { async reconcileAll() {
    started++;
    running++;
    if (running > 1) overlapped = true;
    await Bun.sleep(120);
    running--;
    return [];
  } };
  const sweep = startReconcileSweep(slow, [tenant], 10);
  await Bun.sleep(300);
  const stopping = performance.now();
  await sweep.stop();
  // About 300 ms of 120 ms sweeps on a 10 ms tick: a few sweeps, never thirty queued ones.
  expect([overlapped, started >= 2 && started <= 4]).toEqual([false, true]);
  // Stopping waits for at most the one sweep in progress.
  expect(performance.now() - stopping).toBeLessThan(200);
});
