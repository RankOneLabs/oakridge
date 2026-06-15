import { realpathSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Session, SpawnCmd } from "../../core/session/session";

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

export interface BuildSpawnCmdContext {
  claudeBin: string;
  /** Absolute path to the settings.json from writeCcSettings(). */
  settingsPath: string;
  /** Absolute path to the mcp-servers.json from writeCcMcpConfig(). */
  mcpConfigPath: string;
}

/**
 * Returns a function that constructs the per-session SpawnCmd consumed by
 * SessionManager. The returned closure captures the static context so the
 * manager only needs `(session) => Promise<SpawnCmd>`.
 */
export function makeBuildSpawnCmd(
  ctx: BuildSpawnCmdContext,
): (session: Session) => Promise<SpawnCmd> {
  return async function buildSpawnCmd(session: Session): Promise<SpawnCmd> {
    const cmd = [
      ctx.claudeBin,
      "--setting-sources",
      "user",
      "--settings",
      ctx.settingsPath,
      // Load the gated-review MCP server. `--setting-sources user` (above)
      // excludes the project-scoped .mcp.json, so without this the server never
      // registers in kbbl sessions. --strict-mcp-config makes the MCP set
      // hermetic — exactly what kbbl declares, ignoring user/project configs and
      // their needs-auth noise.
      "--mcp-config",
      ctx.mcpConfigPath,
      "--strict-mcp-config",
    ];

    if (session.model) {
      cmd.push("--model", session.model);
    }
    // Resume in a fresh session id so multiple live forks off the same parent
    // don't collide on CC's internal session id.
    if (session.parentCcSid) {
      cmd.push("--resume", session.parentCcSid, "--fork-session");
    }
    return {
      cmd,
      cwd: session.workdir,
      env: { ...process.env } as Record<string, string>,
    };
  };
}

/**
 * A.1 billing invariant guard — must pass before the PTY is opened.
 *
 * Verifies:
 *   1. No -p / --print in the argv (interactive mode only; print = metered API path).
 *   2. ANTHROPIC_API_KEY is absent (subscription OAuth only; an API key forces
 *      per-token billing regardless of the OAuth login state).
 *   3. The binary resolves (via symlinks) to a path containing
 *      @anthropic-ai/claude-code (the real subscription CLI, not an impostor).
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
  if (!/\/@anthropic-ai\/claude-code(\/|$)/.test(resolvedBin)) {
    throw new Error(
      `A.1: '${resolvedBin}' is not @anthropic-ai/claude-code — refusing to launch (interactive mode requires the subscription CLI)`,
    );
  }
  return resolvedBin;
}

