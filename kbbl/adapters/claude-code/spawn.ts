import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Session, SpawnCmd } from "../../core/session/session";
import type { SafirClient } from "../../core/safir/client";
import type { PermissionProfile } from "../../core/safir/types";
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
 * manager only needs `(session) => Promise<SpawnCmd>`.
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
        `Bash(curl -s -X POST ${ctx.safirBaseUrl}/tasks :*)`,
      );
      cmd.push("--append-system-prompt", backlogBlock);
    }

    // Profile-driven flag injection (Phase 4). Translatable rules go to CC
    // flags; complex rules (path_glob, input_regex, deny_patterns) fall
    // through to the kbbl gate where evaluateRule is the final arbiter.
    const {
      allowedTools: profileAllowedTools,
      disallowedTools: profileDisallowedTools,
      dangerouslySkipPermissions,
    } = translateProfileToFlags(session.permissionProfile);

    if (dangerouslySkipPermissions) {
      cmd.push("--dangerously-skip-permissions");
    }
    for (const tool of profileAllowedTools) {
      cmd.push("--allowedTools", tool);
    }
    for (const tool of profileDisallowedTools) {
      cmd.push("--disallowedTools", tool);
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

/**
 * Minimal tool-call shape evaluateRule needs. Matches the relevant fields
 * of HookInput without creating a circular import with hook-route.ts.
 */
export interface ToolCallInfo {
  tool_name: string;
  tool_input: unknown;
}

/**
 * Single source of truth for permission-profile rule evaluation. Used by
 * both translateProfileToFlags (spawn-time, best-effort) and the hook gate
 * (runtime, definitive). Returns the most specific matching decision.
 *
 * Decision priority (first match wins):
 *   1. deny list → "deny"
 *   2. deny_patterns → "deny" (hard deny, wins over always_prompt)
 *   3. always_prompt → "prompt"
 *   4. allow_all → "auto_approve"
 *   5. auto_approve rules → "auto_approve" if a rule matches
 *   6. default → "prompt"
 */
export function evaluateRule(
  profile: PermissionProfile | null,
  call: ToolCallInfo,
): "auto_approve" | "deny" | "prompt" {
  if (!profile) return "prompt";
  const { rules } = profile;

  if (rules.deny.includes(call.tool_name)) return "deny";

  if (rules.deny_patterns) {
    for (const dp of rules.deny_patterns) {
      if (dp.tool !== call.tool_name) continue;
      if (matchesDenyPattern(call.tool_input, dp.input_match)) return "deny";
    }
  }

  if (rules.always_prompt.includes(call.tool_name)) return "prompt";

  if (rules.allow_all) return "auto_approve";

  for (const rule of rules.auto_approve) {
    if (rule.tool !== call.tool_name) continue;
    if (matchesInputMatch(call.tool_input, rule.input_match)) return "auto_approve";
  }

  return "prompt";
}

// Shell-operator characters that turn a safe prefix into a chained command.
// Includes \n and \r because newline is a command separator in POSIX shells.
const SHELL_OPERATORS = /[;&|><`$\n\r]/;

function matchesCommandPrefix(command: string, prefix: string): boolean {
  if (command !== prefix && !command.startsWith(`${prefix} `)) return false;
  return !SHELL_OPERATORS.test(command.slice(prefix.length));
}

function matchesInputMatch(
  toolInput: unknown,
  inputMatch:
    | {
        command_prefix?: string[];
        path_glob?: string[];
        input_regex?: string;
      }
    | undefined,
): boolean {
  if (!inputMatch) return true;

  const inp =
    typeof toolInput === "object" && toolInput !== null
      ? (toolInput as Record<string, unknown>)
      : {};

  if (inputMatch.command_prefix !== undefined) {
    const command = typeof inp["command"] === "string" ? inp["command"] : null;
    if (command === null) return false;
    if (!inputMatch.command_prefix.some((p) => matchesCommandPrefix(command, p))) return false;
  }

  if (inputMatch.path_glob !== undefined) {
    const filePath = typeof inp["file_path"] === "string" ? inp["file_path"] : null;
    if (filePath === null) return false;
    if (!inputMatch.path_glob.some((pattern) => new Bun.Glob(pattern).match(filePath))) return false;
  }

  if (inputMatch.input_regex !== undefined) {
    try {
      if (!new RegExp(inputMatch.input_regex).test(JSON.stringify(toolInput))) return false;
    } catch {
      return false;
    }
  }

  return true;
}

function matchesDenyPattern(
  toolInput: unknown,
  inputMatch: { command_prefix?: string[]; input_regex?: string },
): boolean {
  const inp =
    typeof toolInput === "object" && toolInput !== null
      ? (toolInput as Record<string, unknown>)
      : {};

  if (inputMatch.command_prefix !== undefined) {
    const command = typeof inp["command"] === "string" ? inp["command"] : null;
    if (command === null) return false;
    if (!inputMatch.command_prefix.some((p) => matchesCommandPrefix(command, p))) return false;
  }

  if (inputMatch.input_regex !== undefined) {
    try {
      if (!new RegExp(inputMatch.input_regex).test(JSON.stringify(toolInput))) return false;
    } catch {
      return false;
    }
  }

  return true;
}

/**
 * Translate a PermissionProfile into CC spawn flags. Only rules that map
 * cleanly to CC's `--allowedTools` / `--disallowedTools` syntax are emitted
 * here; `path_glob`, `input_regex`, and `deny_patterns` rules are left to
 * the kbbl gate (evaluateRule) for definitive enforcement at runtime.
 */
export function translateProfileToFlags(profile: PermissionProfile | null): {
  allowedTools: string[];
  disallowedTools: string[];
  dangerouslySkipPermissions: boolean;
} {
  if (!profile) {
    return { allowedTools: [], disallowedTools: [], dangerouslySkipPermissions: false };
  }
  const { rules } = profile;

  // allow_all with no deny rules of any kind → skip all gate checks
  if (
    rules.allow_all &&
    rules.deny.length === 0 &&
    rules.always_prompt.length === 0 &&
    (!rules.deny_patterns || rules.deny_patterns.length === 0)
  ) {
    return { allowedTools: [], disallowedTools: [], dangerouslySkipPermissions: true };
  }

  const allowedTools: string[] = [];
  const disallowedTools: string[] = [];

  for (const tool of rules.deny) {
    disallowedTools.push(tool);
  }

  for (const rule of rules.auto_approve) {
    if (rules.always_prompt.includes(rule.tool)) continue;
    if (rules.deny.includes(rule.tool)) continue;

    if (!rule.input_match) {
      allowedTools.push(rule.tool);
    }
    // command_prefix, path_glob, input_regex: CC's prefix matching can't
    // enforce word-boundary or shell-operator checks, so leave these to
    // evaluateRule() at gate time rather than emitting a too-broad allowlist.
  }

  return { allowedTools, disallowedTools, dangerouslySkipPermissions: false };
}
