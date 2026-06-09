import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { assertA1Invariants, makeBuildSpawnCmd, type BuildSpawnCmdContext } from "./spawn";
import type { Session } from "../../core/session/session";

function makeCtx(): BuildSpawnCmdContext {
  return {
    claudeBin: "claude",
    port: 3000,
    settingsPath: "/tmp/settings.json",
    mcpConfigPath: "/tmp/mcp-servers.json",
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

describe("makeBuildSpawnCmd argv construction", () => {
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

  test("loads the gated-review MCP config via --mcp-config --strict-mcp-config", async () => {
    const session = fakeSession({ model: null });
    const { cmd } = await buildSpawnCmd(session);
    const mcpIdx = cmd.indexOf("--mcp-config");
    expect(mcpIdx).toBeGreaterThanOrEqual(0);
    expect(cmd[mcpIdx + 1]).toBe("/tmp/mcp-servers.json");
    expect(cmd.includes("--strict-mcp-config")).toBe(true);
    // Must sit after --settings so the static prefix mirrors oakridge-core's
    // build_argv byte/arg parity.
    expect(mcpIdx).toBeGreaterThan(cmd.indexOf("--settings"));
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

  test("does not contain --print or stream-json flags (interactive PTY mode)", async () => {
    const session = fakeSession({ model: null });
    const { cmd } = await buildSpawnCmd(session);
    expect(cmd.includes("--print")).toBe(false);
    expect(cmd.includes("-p")).toBe(false);
    expect(cmd.includes("--input-format")).toBe(false);
    expect(cmd.includes("--output-format")).toBe(false);
    expect(cmd.includes("stream-json")).toBe(false);
    expect(cmd.includes("--include-hook-events")).toBe(false);
    expect(cmd.includes("--include-partial-messages")).toBe(false);
    expect(cmd.includes("--replay-user-messages")).toBe(false);
  });
});

describe("assertA1Invariants", () => {
  let tmpRoot: string;
  let fakeBin: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "cc-a1-test-"));
    const binDir = join(tmpRoot, "node_modules/@anthropic-ai/claude-code/bin");
    mkdirSync(binDir, { recursive: true });
    fakeBin = join(binDir, "claude");
    writeFileSync(fakeBin, "#!/bin/sh\necho fake", { mode: 0o755 });
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("passes with a valid CC binary and no API key", async () => {
    await expect(
      assertA1Invariants({ claudeBin: fakeBin, argv: ["claude"], env: {} }),
    ).resolves.toBeUndefined();
  });

  test("rejects when --print is in argv", async () => {
    await expect(
      assertA1Invariants({ claudeBin: fakeBin, argv: ["claude", "--print"], env: {} }),
    ).rejects.toThrow("A.1");
  });

  test("rejects when -p is in argv", async () => {
    await expect(
      assertA1Invariants({ claudeBin: fakeBin, argv: ["claude", "-p"], env: {} }),
    ).rejects.toThrow("A.1");
  });

  test("rejects when ANTHROPIC_API_KEY is set", async () => {
    await expect(
      assertA1Invariants({
        claudeBin: fakeBin,
        argv: ["claude"],
        env: { ANTHROPIC_API_KEY: "sk-ant-test" },
      }),
    ).rejects.toThrow("A.1");
  });

  test("rejects when binary path does not contain @anthropic-ai/claude-code", async () => {
    await expect(
      assertA1Invariants({ claudeBin: "/bin/true", argv: ["claude"], env: {} }),
    ).rejects.toThrow("A.1");
  });

  test("rejects when binary does not exist", async () => {
    await expect(
      assertA1Invariants({
        claudeBin: "/nonexistent/claude",
        argv: ["claude"],
        env: {},
      }),
    ).rejects.toThrow("A.1");
  });
});
