import { expect, test } from "bun:test";
import { withScratchStack, waitForHealth } from "./scratch-stack";

test("fresh PostgreSQL baselines boot Oakridge, observation and kbbl", async () => {
  await withScratchStack({}, async ({ core, observation, kbbl }) => {
    for (const url of [core, observation, kbbl]) {
      expect(await waitForHealth(url)).toMatchObject({ status: "ok" });
    }
  });
}, 60_000);
