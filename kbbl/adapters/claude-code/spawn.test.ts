import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  assertA1Invariants,
  buildCcArgv,
  ensureWorkspaceTrusted,
  writeCcSettings,
} from "./spawn";

const BASE_ARGV_OPTS = {
  claudeBin: "claude",
  settingsPath: "/tmp/settings.json",
  mcpConfigPath: "/tmp/mcp-servers.json",
};

describe("buildCcArgv construction", () => {
  test("inserts --model when model is set", () => {
    const cmd = buildCcArgv({ ...BASE_ARGV_OPTS, model: "claude-sonnet-4-6" });
    const modelIdx = cmd.indexOf("--model");
    expect(modelIdx).toBeGreaterThanOrEqual(0);
    expect(cmd[modelIdx + 1]).toBe("claude-sonnet-4-6");
    expect(cmd.includes("--resume")).toBe(false);
  });

  test("omits --model entirely when model is null", () => {
    const cmd = buildCcArgv({ ...BASE_ARGV_OPTS, model: null });
    expect(cmd.includes("--model")).toBe(false);
  });

  test("loads the gated-review MCP config via --mcp-config --strict-mcp-config", () => {
    const cmd = buildCcArgv(BASE_ARGV_OPTS);
    const mcpIdx = cmd.indexOf("--mcp-config");
    expect(mcpIdx).toBeGreaterThanOrEqual(0);
    expect(cmd[mcpIdx + 1]).toBe("/tmp/mcp-servers.json");
    expect(cmd.includes("--strict-mcp-config")).toBe(true);
    // Must sit after --settings so the static prefix mirrors oakridge-core's
    // build_argv byte/arg parity.
    expect(mcpIdx).toBeGreaterThan(cmd.indexOf("--settings"));
  });

  test("--model appears before --resume when both are set", () => {
    const cmd = buildCcArgv({ ...BASE_ARGV_OPTS, model: "claude-opus-4-7", parentCcSid: "abc" });
    const modelIdx = cmd.indexOf("--model");
    const resumeIdx = cmd.indexOf("--resume");
    expect(modelIdx).toBeGreaterThanOrEqual(0);
    expect(cmd[modelIdx + 1]).toBe("claude-opus-4-7");
    expect(resumeIdx).toBeGreaterThanOrEqual(0);
    expect(cmd[resumeIdx + 1]).toBe("abc");
    expect(cmd.includes("--fork-session")).toBe(true);
    expect(modelIdx).toBeLessThan(resumeIdx);
  });

  test("injects --session-id (before --model) when sessionId is set", () => {
    const cmd = buildCcArgv({ ...BASE_ARGV_OPTS, sessionId: "forced-sid", model: "claude-opus-4-7" });
    const sidIdx = cmd.indexOf("--session-id");
    expect(sidIdx).toBeGreaterThanOrEqual(0);
    expect(cmd[sidIdx + 1]).toBe("forced-sid");
    // Forced id precedes --model so the static prefix stays stable.
    expect(sidIdx).toBeLessThan(cmd.indexOf("--model"));
  });

  test("omits --session-id when not provided", () => {
    const cmd = buildCcArgv(BASE_ARGV_OPTS);
    expect(cmd.includes("--session-id")).toBe(false);
  });

  test("does not contain --print or stream-json flags (interactive PTY mode)", () => {
    const cmd = buildCcArgv({
      ...BASE_ARGV_OPTS,
      sessionId: "forced-sid",
      model: "claude-opus-4-7",
      parentCcSid: "parent-sid",
    });
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
    // The A.1 identity check runs `<bin> --version` and requires it to report
    // "(Claude Code)", so the fake must emit a CC-shaped version string.
    writeFileSync(fakeBin, "#!/bin/sh\necho '2.1.177 (Claude Code)'", { mode: 0o755 });
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("passes with a valid CC binary and no API key, returning the resolved path", async () => {
    const resolved = await assertA1Invariants({
      claudeBin: fakeBin,
      argv: ["claude"],
      env: {},
    });
    // Returns the realpath-resolved binary so the caller spawns exactly what
    // was validated (guards against relative-path resolution drift).
    expect(resolved).toContain("@anthropic-ai/claude-code");
    expect(resolved).toBe(realpathSync(fakeBin));
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

  test("rejects when the binary does not self-report as Claude Code", async () => {
    // /bin/true runs cleanly but its --version output is not Claude Code, so
    // the identity check must reject it regardless of its path.
    await expect(
      assertA1Invariants({ claudeBin: "/bin/true", argv: ["claude"], env: {} }),
    ).rejects.toThrow("A.1");
  });

  test("rejects a binary on the CC path whose --version is not Claude Code", async () => {
    // Path alone is no longer trusted: an impostor sitting at the right path
    // must still fail the --version identity check.
    const impostorDir = join(tmpRoot, "node_modules/@anthropic-ai/claude-code/impostor");
    mkdirSync(impostorDir, { recursive: true });
    const impostor = join(impostorDir, "claude");
    writeFileSync(impostor, "#!/bin/sh\necho 'totally-not-cc 9.9.9'", { mode: 0o755 });
    await expect(
      assertA1Invariants({ claudeBin: impostor, argv: ["claude"], env: {} }),
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

describe("ensureWorkspaceTrusted", () => {
  let homeDir: string;
  let configPath: string;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), "kbbl-home-"));
    configPath = join(homeDir, ".claude.json");
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
  });

  const wt = "/home/steve/codes/rol/oakridge/kbbl/data/worktrees/abc-123";

  test("seeds hasTrustDialogAccepted for an untrusted worktree", async () => {
    writeFileSync(configPath, JSON.stringify({ projects: {} }));
    await ensureWorkspaceTrusted(wt, configPath);
    const cfg = JSON.parse(readFileSync(configPath, "utf8"));
    expect(cfg.projects[wt].hasTrustDialogAccepted).toBe(true);
  });

  test("preserves existing project fields when seeding trust", async () => {
    writeFileSync(
      configPath,
      JSON.stringify({ projects: { [wt]: { lastCost: 42, allowedTools: ["X"] } } }),
    );
    await ensureWorkspaceTrusted(wt, configPath);
    const cfg = JSON.parse(readFileSync(configPath, "utf8"));
    expect(cfg.projects[wt].hasTrustDialogAccepted).toBe(true);
    expect(cfg.projects[wt].lastCost).toBe(42);
    expect(cfg.projects[wt].allowedTools).toEqual(["X"]);
  });

  test("is a no-op (no rewrite) when already trusted", async () => {
    writeFileSync(
      configPath,
      JSON.stringify({ projects: { [wt]: { hasTrustDialogAccepted: true } } }),
    );
    const before = readFileSync(configPath, "utf8");
    await ensureWorkspaceTrusted(wt, configPath);
    expect(readFileSync(configPath, "utf8")).toBe(before);
  });

  test("creates the projects map when the config lacks one", async () => {
    writeFileSync(configPath, JSON.stringify({ numStartups: 7 }));
    await ensureWorkspaceTrusted(wt, configPath);
    const cfg = JSON.parse(readFileSync(configPath, "utf8"));
    expect(cfg.numStartups).toBe(7);
    expect(cfg.projects[wt].hasTrustDialogAccepted).toBe(true);
  });

  test("non-fatal when the config file is missing", async () => {
    // No file written — must not throw, and must not create one (best-effort).
    await ensureWorkspaceTrusted(wt, configPath);
    expect(() => readFileSync(configPath, "utf8")).toThrow();
  });

  test("recovers when the parsed config is not an object", async () => {
    // Valid JSON, unexpected top-level shape — must not throw, seeds anyway.
    writeFileSync(configPath, JSON.stringify(null));
    await ensureWorkspaceTrusted(wt, configPath);
    const cfg = JSON.parse(readFileSync(configPath, "utf8"));
    expect(cfg.projects[wt].hasTrustDialogAccepted).toBe(true);
  });

  test("recovers when projects (or the workdir entry) is not an object", async () => {
    writeFileSync(configPath, JSON.stringify({ projects: "corrupt" }));
    await ensureWorkspaceTrusted(wt, configPath);
    const cfg = JSON.parse(readFileSync(configPath, "utf8"));
    expect(cfg.projects[wt].hasTrustDialogAccepted).toBe(true);
  });

  test("preserves the existing config file mode (does not widen)", async () => {
    writeFileSync(configPath, JSON.stringify({ projects: {} }));
    chmodSync(configPath, 0o600);
    await ensureWorkspaceTrusted(wt, configPath);
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
    const cfg = JSON.parse(readFileSync(configPath, "utf8"));
    expect(cfg.projects[wt].hasTrustDialogAccepted).toBe(true);
  });

  test("writes through a symlinked config without replacing the link", async () => {
    const realPath = join(homeDir, "real-claude.json");
    const linkPath = join(homeDir, "link-claude.json");
    writeFileSync(realPath, JSON.stringify({ projects: {} }));
    symlinkSync(realPath, linkPath);
    await ensureWorkspaceTrusted(wt, linkPath);
    // The link is still a symlink (not clobbered into a regular file)...
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
    // ...and the seed landed in the real target.
    const cfg = JSON.parse(readFileSync(realPath, "utf8"));
    expect(cfg.projects[wt].hasTrustDialogAccepted).toBe(true);
  });
});
