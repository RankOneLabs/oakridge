import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { assertA1Invariants, buildResumeArgs, makeBuildSpawnCmd, writeCcSettings, type BuildSpawnCmdContext } from "./spawn";
import type { Session } from "../../core/session/session";

function makeCtx(): BuildSpawnCmdContext {
  return {
    claudeBin: "claude",
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

describe("buildResumeArgs", () => {
  test("fork mode appends --resume <ccSid> --fork-session", () => {
    expect(buildResumeArgs("cc-abc", "fork")).toEqual(["--resume", "cc-abc", "--fork-session"]);
  });

  test("continue-in-place mode appends --resume <ccSid> only", () => {
    expect(buildResumeArgs("cc-abc", "continue-in-place")).toEqual(["--resume", "cc-abc"]);
  });
});

describe("makeBuildSpawnCmd — fork via parentCcSid", () => {
  test("parentCcSid produces --resume --fork-session (fork mode unchanged)", async () => {
    const cmd = makeBuildSpawnCmd(makeCtx());
    const { cmd: argv } = await cmd(fakeSession({ parentCcSid: "sid-xyz" }));
    const resumeIdx = argv.indexOf("--resume");
    expect(resumeIdx).toBeGreaterThanOrEqual(0);
    expect(argv[resumeIdx + 1]).toBe("sid-xyz");
    expect(argv.includes("--fork-session")).toBe(true);
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

  test("rejects when ANTHROPIC_API_KEY is set to empty string", async () => {
    await expect(
      assertA1Invariants({
        claudeBin: fakeBin,
        argv: ["claude"],
        env: { ANTHROPIC_API_KEY: "" },
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

describe("writeCcSettings", () => {
  let settingsDir: string;

  beforeEach(() => {
    settingsDir = mkdtempSync(join(tmpdir(), "cc-settings-test-"));
  });

  afterEach(() => {
    rmSync(settingsDir, { recursive: true, force: true });
  });

  test("writes native http hooks for all 8 events with baked port URL", async () => {
    const settingsPath = await writeCcSettings({ dataDir: settingsDir, port: 3456 });
    const raw = JSON.parse(readFileSync(settingsPath, "utf8")) as {
      hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ type: string; url: string }> }>>;
      permissions: { allow: string[] };
    };
    expect(raw.hooks.PermissionRequest?.[0]?.hooks?.[0]).toMatchObject({
      type: "http",
      url: "http://127.0.0.1:3456/hook/permission",
      timeout: 3600,
    });
    expect(raw.hooks.PostToolUse?.[0]?.hooks?.[0]).toMatchObject({
      type: "http",
      url: "http://127.0.0.1:3456/hook/tool",
    });
    expect(raw.hooks.Stop?.[0]?.hooks?.[0]?.url).toBe("http://127.0.0.1:3456/hook/stop");
    expect(raw.hooks.SessionStart?.[0]?.hooks?.[0]?.url).toBe("http://127.0.0.1:3456/hook/session-start");
    expect(raw.hooks.SessionEnd?.[0]?.hooks?.[0]?.url).toBe("http://127.0.0.1:3456/hook/session-end");
    expect(raw.hooks.Notification?.[0]?.hooks?.[0]?.url).toBe("http://127.0.0.1:3456/hook/notification");
    expect(raw.hooks.SubagentStart?.[0]?.hooks?.[0]?.url).toBe("http://127.0.0.1:3456/hook/subagent-start");
    expect(raw.hooks.SubagentStop?.[0]?.hooks?.[0]?.url).toBe("http://127.0.0.1:3456/hook/subagent-stop");
    // All 8 hook event types present
    expect(Object.keys(raw.hooks)).toHaveLength(8);
  });

  test("includes permissions.allow with Agent(*) and Task(*)", async () => {
    const settingsPath = await writeCcSettings({ dataDir: settingsDir, port: 8788 });
    const raw = JSON.parse(readFileSync(settingsPath, "utf8")) as {
      permissions: { allow: string[] };
    };
    expect(raw.permissions.allow).toContain("Agent(*)");
    expect(raw.permissions.allow).toContain("Task(*)");
  });

  test("no shell command hooks — no gate.sh reference", async () => {
    const settingsPath = await writeCcSettings({ dataDir: settingsDir, port: 8788 });
    const content = readFileSync(settingsPath, "utf8");
    expect(content).not.toContain('"command"');
    expect(content).not.toContain("gate.sh");
    expect(content).not.toContain("PreToolUse");
  });

  test("port is baked into URL at write time", async () => {
    const settingsPath = await writeCcSettings({ dataDir: settingsDir, port: 9999 });
    const content = readFileSync(settingsPath, "utf8");
    expect(content).toContain("9999");
    expect(content).not.toContain("8788");
  });
});
