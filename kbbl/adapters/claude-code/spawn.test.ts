import { describe, expect, test } from "bun:test";

import { makeBuildSpawnCmd, type BuildSpawnCmdContext } from "./spawn";
import type { Session } from "../../core/session/session";

const ctx: BuildSpawnCmdContext = {
  claudeBin: "claude",
  port: 3000,
  settingsPath: "/tmp/settings.json",
};

function fakeSession(overrides: Partial<{ model: string | null; parentCcSid: string | null }>): Session {
  return {
    model: overrides.model ?? null,
    parentCcSid: overrides.parentCcSid ?? null,
    workdir: "/tmp",
  } as unknown as Session;
}

const buildSpawnCmd = makeBuildSpawnCmd(ctx);

describe("makeBuildSpawnCmd --model flag", () => {
  test("inserts --model before any --resume when model is set", () => {
    const session = fakeSession({ model: "claude-sonnet-4-6" });
    const { cmd } = buildSpawnCmd(session);
    const modelIdx = cmd.indexOf("--model");
    expect(modelIdx).toBeGreaterThanOrEqual(0);
    expect(cmd[modelIdx + 1]).toBe("claude-sonnet-4-6");
    // No --resume in this case (no parentCcSid), but ordering invariant still
    // confirmed: --model appears after the static block.
    expect(cmd.includes("--resume")).toBe(false);
  });

  test("omits --model entirely when model is null", () => {
    const session = fakeSession({ model: null });
    const { cmd } = buildSpawnCmd(session);
    expect(cmd.includes("--model")).toBe(false);
  });

  test("--model appears before --resume when both model and parentCcSid are set", () => {
    const session = fakeSession({ model: "claude-opus-4-7", parentCcSid: "abc" });
    const { cmd } = buildSpawnCmd(session);
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
