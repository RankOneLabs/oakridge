import type { Hono } from "hono";

import type { Session, SpawnCmd } from "../../core/session/session";
import type { SessionManager } from "../../core/session/session-manager";
import type { AppRuntime } from "../../core/runtime";

import { classifyCcEvent } from "./event-classifier";
import { hookApprovalHandler } from "./hook-route";
import { makeBuildSpawnCmd, writeCcSettings } from "./spawn";

export interface CreateClaudeCodeRuntimeOpts {
  claudeBin: string;
  /** Server's HTTP port — passed into the gate via KBBL_PORT env var. */
  port: number;
  /** Directory where the generated settings.json lives. */
  dataDir: string;
  /** Absolute path to the PreToolUse gate script. */
  gatePath: string;
}

/**
 * Constructs the Claude Code adapter. The async factory writes the CC
 * settings.json (so the spawn flag `--settings <path>` resolves) and
 * captures the static spawn context. The returned object implements the
 * AppRuntime interface that core consumes.
 *
 * Adapters are registered manually in core/server.ts for v0 — there is no
 * plugin loader. A second adapter (codex) would either replace or live
 * alongside this one via a small registry, depending on how heterogeneous
 * the spawn / event semantics turn out to be.
 */
export async function createClaudeCodeRuntime(
  opts: CreateClaudeCodeRuntimeOpts,
): Promise<AppRuntime> {
  const settingsPath = await writeCcSettings({
    dataDir: opts.dataDir,
    gatePath: opts.gatePath,
  });
  const buildSpawnCmd = makeBuildSpawnCmd({
    claudeBin: opts.claudeBin,
    port: opts.port,
    settingsPath,
  });

  return {
    id: "claude-code",
    buildSpawnCmd: (session: Session): SpawnCmd => buildSpawnCmd(session),
    mountRoutes: (app: Hono, deps: {
      manager: SessionManager;
      getBunServer: () => import("bun").Server<unknown> | null;
    }) => {
      // CC's PreToolUse gate posts to this loopback-only route.
      app.post(
        "/hook/approval",
        hookApprovalHandler({
          manager: deps.manager,
          getBunServer: deps.getBunServer,
        }),
      );
    },
    classifyEvent: classifyCcEvent,
  };
}
