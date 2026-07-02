import { execFile } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** True for a non-null, non-array object — the shape we can safely index/spread. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Monotonic suffix so concurrent ensureWorkspaceTrusted() calls in the same
// process never collide on one temp file (process.pid alone is identical across
// calls, so two simultaneous spawns could rename away each other's temp).
let trustSeedTmpCounter = 0;

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
 *
 * Includes the kbbl-channel stdio MCP server alongside gated-review. The
 * channel server receives the per-session outbox path via KBBL_CHANNEL_OUTBOX
 * so it can tail it and push each line as a `notifications/claude/channel`.
 * `--strict-mcp-config` (set in buildCcArgv) makes this the complete MCP set.
 */
export async function writeCcMcpConfig(opts: {
  dataDir: string;
  /** Absolute path to the per-session channel outbox file. */
  channelOutboxPath: string;
  /** Absolute path to the bun binary. */
  bunBin: string;
  /** Absolute path to channel-server.ts (resolved relative to this module). */
  channelServerPath: string;
}): Promise<string> {
  // Per-session config filename, derived from the per-session outbox stem, so
  // concurrent session startups don't overwrite each other's outbox pointer in
  // a shared file (which would cross-route channel messages between sessions).
  const outboxStem = basename(opts.channelOutboxPath, ".jsonl");
  const mcpConfigPath = join(opts.dataDir, `mcp-servers-${outboxStem}.json`);
  await writeFile(
    mcpConfigPath,
    JSON.stringify(
      {
        mcpServers: {
          "gated-review": { type: "http", url: GATED_REVIEW_MCP_URL },
          "kbbl-channel": {
            type: "stdio",
            command: opts.bunBin,
            args: [opts.channelServerPath],
            env: {
              KBBL_CHANNEL_OUTBOX: opts.channelOutboxPath,
              KBBL_CHANNEL_NAME: "kbbl-channel",
            },
          },
        },
      },
      null,
      2,
    ),
  );
  return mcpConfigPath;
}

/**
 * Pre-trust `workdir` in CC's global config so the interactive launch skips
 * the "Is this a project you trust?" workspace-trust modal.
 *
 * Why this is needed: kbbl spawns CC in a fresh per-session git worktree, and
 * CC keys workspace trust on the absolute directory path (stored in
 * ~/.claude.json under `projects[dir].hasTrustDialogAccepted`). Every new
 * worktree is therefore untrusted, so the modal blocks the prompt on launch.
 * In PTY mode the operator's first message is swallowed by that modal — it
 * never reaches the CC prompt and no turn ever starts, so the session looks
 * permanently empty. (The prior --print/headless transport never showed the
 * modal, which is why this only surfaced once PTY mode landed.)
 *
 * Best-effort and non-fatal: on any IO/parse failure we log and return so the
 * launch still proceeds — the Session input-queue watchdog recovers the queue
 * if the modal does appear. The write is atomic (temp file + rename) so a
 * crash mid-write can't truncate the operator's global config. Concurrent
 * writers (CC itself, other kbbl sessions) are a small unguarded race;
 * ~/.claude.json has no lock protocol and trust writes are infrequent, so
 * last-writer-wins is acceptable here.
 *
 * `configPath` defaults to the operator's real `~/.claude.json`; it is a
 * parameter only so this IO boundary can be exercised against a temp file in
 * tests without touching the real config.
 */
export async function ensureWorkspaceTrusted(
  workdir: string,
  configPath: string = join(homedir(), ".claude.json"),
): Promise<void> {
  let config: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(await readFile(configPath, "utf8"));
    // A valid-but-unexpected top-level shape (null, array, scalar) must not
    // throw downstream — treat it as empty and let CC rewrite the rest.
    config = isPlainObject(parsed) ? parsed : {};
  } catch (err) {
    // A missing config is the normal first-run state — treat it as empty and
    // fall through to create it below, so trust is still seeded and the modal
    // is skipped on the very first launch (returning here would reintroduce
    // the swallowed-first-message bug). Silent: ENOENT isn't an error worth
    // logging on every spawn. Genuine failures (corrupt file, permissions)
    // are unexpected — log and bail without touching the file.
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      console.error(
        `kbbl: workspace-trust seed skipped — cannot read or parse ${configPath}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return;
    }
    config = {};
  }
  // Guard the nested shapes too: a corrupt `projects` (or a non-object entry
  // for this workdir) would otherwise throw on index/spread and, since spawn()
  // awaits this function, abort the launch — defeating the best-effort contract.
  const projects = isPlainObject(config.projects)
    ? (config.projects as Record<string, unknown>)
    : {};
  const candidate = projects[workdir];
  const existing = isPlainObject(candidate) ? candidate : undefined;
  // Already trusted — no write, no race window.
  if (existing?.hasTrustDialogAccepted === true) return;
  projects[workdir] = { ...existing, hasTrustDialogAccepted: true };
  config.projects = projects;
  // Resolve through a symlink so rename() replaces the link's target rather
  // than the symlink itself (dotfile managers commonly symlink ~/.claude.json),
  // and preserve the existing file's mode so a token-bearing config isn't
  // widened past its prior permissions by the temp file's default umask.
  // Default to 0o600 — private — if the mode can't be read.
  let targetPath = configPath;
  let mode = 0o600;
  try {
    targetPath = realpathSync(configPath);
    mode = statSync(targetPath).mode & 0o777;
  } catch {
    // Keep the given path / restrictive default — best-effort.
  }
  const tmpPath = `${targetPath}.kbbl-${process.pid}-${trustSeedTmpCounter++}.tmp`;
  try {
    await writeFile(tmpPath, JSON.stringify(config, null, 2), { mode });
    await rename(tmpPath, targetPath);
  } catch (err) {
    console.error(
      `kbbl: workspace-trust seed failed for ${workdir}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

export interface CcArgvOpts {
  claudeBin: string;
  /** Absolute path to the settings.json from writeCcSettings(). */
  settingsPath: string;
  /** Absolute path to the mcp-servers.json from writeCcMcpConfig(). */
  mcpConfigPath: string;
  /** Pinned model, or null/omitted for CC's default. */
  model?: string | null;
  /** Reasoning/effort level (`--effort`), or null/omitted for CC's default. */
  effort?: string | null;
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
 * `--session-id`, `--model`, `--effort`, and `--resume`/`--fork-session` in
 * that order.
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
  if (opts.effort) {
    argv.push("--effort", opts.effort);
  }
  // Resume in a fresh session id so multiple live forks off the same parent
  // don't collide on CC's internal session id.
  if (opts.parentCcSid) {
    argv.push("--resume", opts.parentCcSid, "--fork-session");
  }
  // Channel transport: register kbbl-channel as a development channel so CC
  // accepts push notifications from our stdio MCP server. Must be last: the
  // flag is variadic (commander consumes tokens until the next `-`) so placing
  // it earlier would swallow subsequent flags. Do NOT add --channels — that
  // flag is for the Anthropic plugin allowlist and rejects "server:" entries
  // with "server: entries need --dangerously-load-development-channels".
  // Passing the same value to both flags creates a duplicate dev:false entry
  // that CC rejects, so pass it to the dev flag only.
  argv.push("--dangerously-load-development-channels", "server:kbbl-channel");
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
  // Async exec (not execFileSync): this runs on the runtime spawn path, so a
  // blocking call would stall hook handling and other concurrent sessions for
  // the duration of CC's startup (or the full timeout on a hang).
  let versionOut: string;
  try {
    const result = await execFileAsync(resolvedBin, ["--version"], {
      encoding: "utf8",
      timeout: 10_000,
    });
    versionOut = result.stdout;
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

