import { expect, test } from "bun:test";
import { startRunSweep } from "../src/runtime/run-sweep";

test("stopping the sweep waits for the sweep in flight and starts no more", async () => {
  const events: string[] = [];
  let finish = (): void => {};
  const sweep = startRunSweep(() => {
    events.push("sweep started");
    return new Promise<void>((resolve) => { finish = () => { events.push("sweep finished"); resolve(); }; });
  }, 5);
  for (let poll = 0; poll < 100 && events.length === 0; poll++) await Bun.sleep(5);
  const stopped = sweep.stop().then(() => { events.push("stopped"); });
  await Bun.sleep(20);
  finish();
  await stopped;
  await Bun.sleep(20);
  expect(events).toEqual(["sweep started", "sweep finished", "stopped"]);
});
