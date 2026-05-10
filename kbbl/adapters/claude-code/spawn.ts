import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Session, SpawnCmd } from "../../core/session/session";
import type { SafirClient } from "../../core/safir/client";
import { buildSafirBacklogPromptBlock } from "./safir-backlog-prompt";

/**
 * CC-specific spawn-command construction and settings-file generation.
 *
 * NOTE: This module is Claude Code-specific. It builds a `claude --print
 * --input-format stream-json ...` command line and writes the settings.json
 * file that registers the PreToolUse hook. In PR 3 of the restructure it
 * moves into kbbl/adapters/claude-code/ and is invoked through the
 * runtime-interface.ts AgentRuntime.spawn() contract.
 */

export interface CcSettingsOpts {
  dataDir: string;
  /** Absolute path to the PreToolUse gate script. */
  gatePath: string;
}

/**
 * Writes the settings.json file the spawned CC subprocess will read via
 * `--settings <path>`. Returns the absolute settings-file path.
 *
 * The file is regenerated on every server startup (no idempotence check)
 * so a moved gate script or relocated dataDir is picked up without operator
 * action.
 *
 * The gate path is shell-quoted before serialization because CC executes
 * `hooks[].command` as a bash command. A checkout path containing spaces or
 * other shell-significant characters would otherwise be split by the shell
 * and break the approval gate.
 */
export async function writeCcSettings(opts: CcSettingsOpts): Promise<string> {
  const settingsPath = join(opts.dataDir, "settings.json");
  await writeFile(
    settingsPath,
    JSON.stringify(
      {
        hooks: {
          PreToolUse: [
            {
              matcher: ".*",
              hooks: [
                {
                  type: "command",
                  command: shellQuote(opts.gatePath),
                  // CC's default PreToolUse hook timeout (~10 min) silently
                  // cancels the gate when the operator's away from the PWA;
                  // the deny that comes back as "you haven't granted it yet"
                  // confuses the agent. Match gate.sh's curl --max-time so
                  // approval latency really is "time to tap".
                  timeout: 3600,
                },
              ],
            },
          ],
        },
      },
      null,
      2,
    ),
  );
  return settingsPath;
}

/**
 * Wrap a string in single quotes for safe inclusion in a bash command.
 * Embedded single quotes are escaped via the standard `'\''` close-reopen
 * idiom. Single-quoted strings in bash don't interpret any metacharacters,
 * so wrapping is sufficient for any filesystem path.
 */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export interface BuildSpawnCmdContext {
  claudeBin: string;
  /** The server's HTTP port — passed to the gate via KBBL_PORT env var. */
  port: number;
  /** Absolute path to the settings.json from writeCcSettings(). */
  settingsPath: string;
  /** Used to pre-fetch project_id for safir-task-bound sessions. */
  safirClient: SafirClient;
  /**
   * Base URL with no trailing slash, e.g. "http://localhost:7145".
   * The same value the SafirClient was constructed with — fed into both
   * the system-prompt block and the --allowedTools pattern so the
   * literal-prefix match works.
   */
  safirBaseUrl: string;
}

/**
 * Returns a function that constructs the per-session SpawnCmd consumed by
 * SessionManager. The returned closure captures the static context so the
 * manager only needs `(session) => SpawnCmd`.
 */
export function makeBuildSpawnCmd(
  ctx: BuildSpawnCmdContext,
): (session: Session) => Promise<SpawnCmd> {
  return async function buildSpawnCmd(session: Session): Promise<SpawnCmd> {
    const cmd = [
      ctx.claudeBin,
      "--print",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--include-hook-events",
      // Without partial-messages, kbbl only sees the final assistant message
      // when the model is fully done — a long thinking phase is indistinguishable
      // from a wedge. Partial events let the PWA stream incremental thinking +
      // text and surface a live token counter.
      "--include-partial-messages",
      "--replay-user-messages",
      "--verbose",
      "--setting-sources",
      "user",
      "--settings",
      ctx.settingsPath,
    ];

    // Resolve project_id for safir-task-bound sessions. A failed lookup
    // (network error, 404, timeout) leaves projectId undefined; the prompt
    // builder returns null and the allowlist is skipped — the session
    // still spawns successfully, just without backlog integration.
    let projectId: string | undefined;
    if (session.taskId !== undefined) {
      try {
        const task = await ctx.safirClient.getTask(session.taskId);
        projectId = task.project_id;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(
          `kbbl: safir.getTask(${session.taskId}) failed for session ${session.oakridgeSid}; spawning without backlog integration: ${msg}`,
        );
      }
    }

    const backlogBlock = buildSafirBacklogPromptBlock({
      taskId: session.taskId,
      projectId,
      sid: session.oakridgeSid,
      safirBaseUrl: ctx.safirBaseUrl,
    });

    if (backlogBlock) {
      // Allowlist + prompt are paired: only emit the allowlist when the
      // prompt is actually being delivered. Avoids advertising a curl
      // shape the model was never told to use.
      cmd.push(
        "--allowedTools",
        `Bash(curl -s -X POST ${ctx.safirBaseUrl}/tasks:*)`,
      );
      cmd.push("--append-system-prompt", backlogBlock);
    }

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
      env: {
        ...process.env,
        KBBL_PORT: String(ctx.port),
      } as Record<string, string>,
    };
  };
}
