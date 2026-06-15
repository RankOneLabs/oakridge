import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * CC-specific spawn-command construction and settings-file generation.
 *
 * Builds the interactive `claude` command line (PTY launch; no --print /
 * stream-json) and provides the A.1 billing invariant guard that must be
 * satisfied before the PTY is opened.
 */

export interface CcSettingsOpts {
  dataDir: string;
  /** HTTP port of the kbbl server — baked into hook URLs at settings-generation time. */
  port: number;
}

/**
 * Writes the settings.json file the spawned CC subprocess will read via
 * `--settings <path>`. Returns the absolute settings-file path.
 *
 * The file is regenerated on every server startup (no idempotence check)
 * so a port change or relocated dataDir is picked up without operator action.
 *
 * All eight CC hook events are registered as native type:http hooks POSTing
 * to the kbbl server at the port known at settings-generation time. No shell
 * wrapper (gate.sh) is involved — CC posts event JSON directly.
 *
 * permissions.allow pre-authorizes Agent(*) and Task(*) (Task is the legacy
 * alias) so subagent delegation flows never hit the PermissionRequest hook.
 * Everything else goes through the PermissionRequest hook for operator review.
 */
export async function writeCcSettings(opts: CcSettingsOpts): Promise<string> {
  const settingsPath = join(opts.dataDir, "settings.json");
  const base = `http://127.0.0.1:${opts.port}`;
  function httpHook(route: string) {
    return { type: "http", url: `${base}${route}` };
  }
  await writeFile(
    settingsPath,
    JSON.stringify(
      {
        hooks: {
          PermissionRequest: [
            {
              matcher: ".*",
              hooks: [
                {
                  ...httpHook("/hook/permission"),
                  // PermissionRequest blocks until the operator approves or denies.
                  // Explicit 3600s matches the previous gate behavior so approval
                  // latency is "time to tap" regardless of CC default changes.
                  timeout: 3600,
                },
              ],
            },
          ],
          PostToolUse: [
            { matcher: ".*", hooks: [httpHook("/hook/tool")] },
          ],
          Stop: [{ hooks: [httpHook("/hook/stop")] }],
          SessionStart: [{ hooks: [httpHook("/hook/session-start")] }],
          SessionEnd: [{ hooks: [httpHook("/hook/session-end")] }],
          Notification: [{ hooks: [httpHook("/hook/notification")] }],
          SubagentStart: [{ hooks: [httpHook("/hook/subagent-start")] }],
          SubagentStop: [{ hooks: [httpHook("/hook/subagent-stop")] }],
        },
        permissions: {
          allow: ["Agent(*)", "Task(*)"],
        },
      },
      null,
      2,
    ),
  );
  return settingsPath;
}

/**
 * URL of the gated-review MCP server kbbl injects into every CC session.
 *
 * Mirrors the repo's committed `.mcp.json` — keep the two in sync. They exist
 * in parallel on purpose: interactive `claude` runs in the repo read
 * `.mcp.json` (a project setting source, loaded by default), but kbbl launches
 * CC with `--setting-sources user` — a deliberate gate-integrity choice, since
 * project setting sources can carry permission allowlists that would let a
 * session bypass the PermissionRequest hook gate. That same flag excludes the
 * project-scoped `.mcp.json`, so the server never registers in kbbl sessions
 * unless we load it through `--mcp-config`, which is independent of
 * `--setting-sources`. (oakridge-core's session_agent mirrors this URL.)
 */
const GATED_REVIEW_MCP_URL = "http://otto:3555/mcp";

/**
 * Writes the MCP-config file the spawned CC subprocess reads via
 * `--mcp-config <path>`. Returns the absolute path.
 *
 * Regenerated on every server startup (like settings.json) so a changed URL is
 * picked up without operator action. We generate a kbbl-owned file in dataDir
 * rather than pointing `--mcp-config` at the session's checked-out `.mcp.json`
 * so registration doesn't depend on the branch actually containing that file
 * (forked or older sessions may predate it).
 */
export async function writeCcMcpConfig(opts: {
  dataDir: string;
}): Promise<string> {
  const mcpConfigPath = join(opts.dataDir, "mcp-servers.json");
  await writeFile(
    mcpConfigPath,
    JSON.stringify(
      {
        mcpServers: {
          "gated-review": { type: "http", url: GATED_REVIEW_MCP_URL },
        },
      },
      null,
      2,
    ),
  );
  return mcpConfigPath;
}

export interface CcArgvOpts {
  claudeBin: string;
  /** Absolute path to the settings.json from writeCcSettings(). */
  settingsPath: string;
  /** Absolute path to the mcp-servers.json from writeCcMcpConfig(). */
  mcpConfigPath: string;
  /** Pinned model, or null/omitted for CC's default. */
  model?: string | null;
  /** Parent CC session id to fork from (continue-in-place / live fork). */
  parentCcSid?: string | null;
  /**
   * Forced CC session id (`--session-id`). The PTY transport assigns this
   * before launch so the ccSid→oakridgeSid mapping is known by the time the
   * first hook fires. Omit it and CC picks its own id.
   */
  sessionId?: string | null;
}

/**
 * Builds the interactive `claude` argv (PTY launch; no --print / stream-json).
 *
 * Pure and order-stable so it is testable in isolation and shared by the only
 * production launcher (the AgentRuntime PTY `spawn()` path): the static prefix
 * mirrors oakridge-core's build_argv for byte/arg parity, then optional
 * `--session-id`, `--model`, and `--resume`/`--fork-session` in that order.
 */
export function buildCcArgv(opts: CcArgvOpts): string[] {
  const argv = [
    opts.claudeBin,
    "--setting-sources",
    "user",
    "--settings",
    opts.settingsPath,
    // Load the gated-review MCP server. `--setting-sources user` (above)
    // excludes the project-scoped .mcp.json, so without this the server never
    // registers in kbbl sessions. --strict-mcp-config makes the MCP set
    // hermetic — exactly what kbbl declares, ignoring user/project configs and
    // their needs-auth noise.
    "--mcp-config",
    opts.mcpConfigPath,
    "--strict-mcp-config",
  ];
  // Forced session id (PTY mode), assigned before launch. --fork-session below
  // is required for CC to accept --session-id alongside --resume.
  if (opts.sessionId) {
    argv.push("--session-id", opts.sessionId);
  }
  if (opts.model) {
    argv.push("--model", opts.model);
  }
  // Resume in a fresh session id so multiple live forks off the same parent
  // don't collide on CC's internal session id.
  if (opts.parentCcSid) {
    argv.push("--resume", opts.parentCcSid, "--fork-session");
  }
  return argv;
}

/**
 * A.1 billing invariant guard — must pass before the PTY is opened.
 *
 * Verifies:
 *   1. No -p / --print in the argv (interactive mode only; print = metered API path).
 *   2. ANTHROPIC_API_KEY is absent (subscription OAuth only; an API key forces
 *      per-token billing regardless of the OAuth login state).
 *   3. The realpath-resolved binary self-reports as Claude Code via `--version`
 *      (the real subscription CLI, not an impostor). We verify the reported
 *      identity rather than match the install path: the layout is not stable
 *      (npm `node_modules/@anthropic-ai/claude-code/…` vs the native installer's
 *      `~/.local/share/claude/versions/<ver>`), so a path heuristic
 *      false-negatives the genuine CLI whenever the install layout changes.
 *   4. Real TTY: guaranteed by the caller using bun-pty — this function
 *      documents the invariant but cannot check it pre-spawn.
 *
 * Throws with an "A.1:" prefix on any violation so callers can surface the
 * reason without additional parsing.
 *
 * Returns the realpath-resolved binary path so the caller spawns exactly the
 * file that was validated. Spawning the un-resolved `claudeBin` instead would
 * reopen the guard: a relative path validates against the server's lookup but,
 * executed under the session's working directory, could resolve to a different
 * binary — defeating invariant 3.
 */
export async function assertA1Invariants(opts: {
  claudeBin: string;
  argv: string[];
  env: Record<string, string | undefined>;
}): Promise<string> {
  if (opts.argv.includes("-p") || opts.argv.includes("--print")) {
    throw new Error("A.1: interactive mode forbids -p / --print in argv");
  }
  if (opts.env.ANTHROPIC_API_KEY !== undefined) {
    throw new Error(
      "A.1: ANTHROPIC_API_KEY is set — only subscription OAuth auth is permitted (unset the key)",
    );
  }
  let resolvedBin: string;
  try {
    const fullPath = opts.claudeBin.startsWith("/")
      ? opts.claudeBin
      : (Bun.which(opts.claudeBin) ?? opts.claudeBin);
    resolvedBin = realpathSync(fullPath);
  } catch {
    throw new Error(`A.1: cannot resolve binary '${opts.claudeBin}'`);
  }
  // Identity check: the resolved binary must self-report as Claude Code.
  // `--version` is a fast, non-billing invocation (no session, no tokens) and
  // is installer-layout independent — unlike the prior path-substring heuristic.
  let versionOut: string;
  try {
    versionOut = execFileSync(resolvedBin, ["--version"], {
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    throw new Error(
      `A.1: '${resolvedBin}' failed to run '--version' — refusing to launch (interactive mode requires the subscription CLI)`,
    );
  }
  if (!/\(Claude Code\)/.test(versionOut)) {
    throw new Error(
      `A.1: '${resolvedBin}' does not self-report as Claude Code (--version: ${JSON.stringify(versionOut.trim())}) — refusing to launch (interactive mode requires the subscription CLI)`,
    );
  }
  return resolvedBin;
}

