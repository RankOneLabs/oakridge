import { describe, expect, test } from "bun:test";

import { makeBuildSpawnCmd, type BuildSpawnCmdContext } from "./spawn";
import type { Session } from "../../core/session/session";

function makeCtx(): BuildSpawnCmdContext {
  return {
    claudeBin: "claude",
    port: 3000,
    settingsPath: "/tmp/settings.json",
  };
}

function fakeSession(
  overrides: Partial<{
    model: string | null;
    parentCcSid: string | null;
    oakridgeSid: string;
  }>,
): Session {
  return {
    model: overrides.model ?? null,
    parentCcSid: overrides.parentCcSid ?? null,
    workdir: "/tmp",
    oakridgeSid: overrides.oakridgeSid ?? "sess-test-sid",
  } as unknown as Session;
}

describe("makeBuildSpawnCmd --model flag", () => {
  const buildSpawnCmd = makeBuildSpawnCmd(makeCtx());

  test("inserts --model when model is set", async () => {
    const session = fakeSession({ model: "claude-sonnet-4-6" });
    const { cmd } = await buildSpawnCmd(session);
    const modelIdx = cmd.indexOf("--model");
    expect(modelIdx).toBeGreaterThanOrEqual(0);
    expect(cmd[modelIdx + 1]).toBe("claude-sonnet-4-6");
    expect(cmd.includes("--resume")).toBe(false);
  });

  test("omits --model entirely when model is null", async () => {
    const session = fakeSession({ model: null });
    const { cmd } = await buildSpawnCmd(session);
    expect(cmd.includes("--model")).toBe(false);
  });

  test("--model appears before --resume when both are set", async () => {
    const session = fakeSession({ model: "claude-opus-4-7", parentCcSid: "abc" });
    const { cmd } = await buildSpawnCmd(session);
    const modelIdx = cmd.indexOf("--model");
    const resumeIdx = cmd.indexOf("--resume");
    expect(modelIdx).toBeGreaterThanOrEqual(0);
    expect(cmd[modelIdx + 1]).toBe("claude-opus-4-7");
    expect(resumeIdx).toBeGreaterThanOrEqual(0);
    expect(cmd[resumeIdx + 1]).toBe("abc");
    expect(cmd.includes("--fork-session")).toBe(true);
    expect(modelIdx).toBeLessThan(resumeIdx);
  });
});
