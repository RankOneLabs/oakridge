import { expect, test } from "bun:test";
import { captureSourceRun } from "../scripts/live-source-run";

// This opt-in spends real ACP turns and may run the input's actual build.
const input_path = process.env.OAKRIDGE_LIVE_RUN_INPUT;
const missing = [
  ...(!process.env.OAKRIDGE_TEST_DATABASE_URL ? ["OAKRIDGE_TEST_DATABASE_URL"] : []),
  ...(!input_path ? ["OAKRIDGE_LIVE_RUN_INPUT (and the installed Codex agent's authentication)"] : []),
];
const liveTest = missing.length ? test.skip : test;
if (missing.length) console.warn(`SKIP: live committed-definition source run; missing ${missing.join(", ")}`);
liveTest("the real committed development run emits a durable ordered production capture", async () => {
  if (!input_path) throw new Error("OAKRIDGE_LIVE_RUN_INPUT disappeared");
  const result = await captureSourceRun({ input: await Bun.file(input_path).json(),
    output: "observation/verification", through: "brief" });
  expect((await Bun.file(result.capture_path).json()).length).toBeGreaterThan(0);
}, 1_800_000);
