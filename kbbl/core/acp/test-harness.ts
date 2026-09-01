// Shared test wiring: an AcpSessionService backed by the fake ACP agent
// (§24.1) over real SQLite, optionally with the real git worktree
// provider. Used by handler tests, orchestrator tests, and the DBOS
// contract fixture — production code never imports this module.

import { join } from "node:path";
import type { Database } from "bun:sqlite";

import { openTestDb } from "../db/test-db";
import { GitWorktreeProvider } from "../worktree/service";
import type { AgentProfile, AgentProfileId } from "./agent-profile";
import { AcpControllerRegistry } from "./controller-registry";
import { AcpProcessSupervisor } from "./process-supervisor";
import { AcpSessionService } from "./session-service";
import { AcpSessionStore } from "./store";
import { ok, type KbblSessionId, type WorktreeProvider } from "./types";

export const FAKE_AGENT_FIXTURE = join(
  import.meta.dir,
  "__fixtures__",
  "fake-acp-agent.ts",
);

export interface AcpTestHarnessOptions {
  /** Fake agent transcript dir (session/load replay across restarts). */
  stateDir: string;
  /** When set, sessions get real git worktrees rooted here. */
  worktreesRoot?: string;
  db?: Database;
  behavior?: string;
  delayMs?: number;
  /** Profile ids all mapped to the fake agent. */
  profileIds?: readonly string[];
  defaultAgent?: string;
  onSessionEnded?: (sid: KbblSessionId) => void;
}

export interface AcpTestHarness {
  db: Database;
  store: AcpSessionStore;
  registry: AcpControllerRegistry;
  service: AcpSessionService;
}

export function makeAcpTestService(
  options: AcpTestHarnessOptions,
): AcpTestHarness {
  const db = options.db ?? openTestDb();
  const store = new AcpSessionStore(db);
  const registry = new AcpControllerRegistry();
  const supervisor = new AcpProcessSupervisor({
    graceful_kill_ms: 1000,
    hard_kill_ms: 1000,
  });
  const profileIds = options.profileIds ?? ["claude-code", "codex", "fake"];
  const profiles = new Map<AgentProfileId, AgentProfile>();
  for (const id of profileIds) {
    profiles.set(id, {
      id,
      label: `Fake agent (${id})`,
      command: process.execPath,
      args: [FAKE_AGENT_FIXTURE],
      env_policy: {
        inherit: true,
        set: {
          FAKE_ACP_BEHAVIOR: options.behavior ?? "happy",
          FAKE_ACP_STATE_DIR: options.stateDir,
          ...(options.delayMs !== undefined
            ? { FAKE_ACP_DELAY_MS: String(options.delayMs) }
            : {}),
        },
      },
      enabled: true,
      requireLoadSession: true,
    });
  }
  const worktrees: WorktreeProvider = options.worktreesRoot
    ? new GitWorktreeProvider({ worktreesRoot: options.worktreesRoot, store })
    : {
        resolve: async (_sid, spec) =>
          ok({
            worktree_path: spec.workdir,
            worktree_branch: null,
            worktree_base_ref: null,
            parent_sid: null,
          }),
      };
  const service = new AcpSessionService({
    store,
    controllers: registry,
    profiles,
    supervisor,
    worktrees,
    config: {
      default_agent: options.defaultAgent ?? profileIds[0] ?? "claude-code",
      graceful_kill_ms: 1000,
      idle_child_ttl_ms: 900_000,
      live_event_buffer: 2000,
    },
    ...(options.onSessionEnded ? { onSessionEnded: options.onSessionEnded } : {}),
  });
  return { db, store, registry, service };
}
