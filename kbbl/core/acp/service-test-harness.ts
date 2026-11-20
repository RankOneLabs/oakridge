// Integration tests for the ACP substrate: real child processes running
// the fake ACP agent over stdio, real SQLite, the full
// service -> registry -> controller -> client -> supervisor path.

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";

import { openTestDb } from "../db/test-db";
import type { AgentProfile, AgentProfileId } from "./agent-profile";
import { AcpControllerRegistry } from "./controller-registry";
import { AcpProcessSupervisor } from "./process-supervisor";
import { AcpSessionService } from "./session-service";
import { AcpSessionStore } from "./store";
import {
  ok,
  type AcpSessionStartSpec,
  type WorktreeProvider,
} from "./types";

const FIXTURE = join(import.meta.dir, "__fixtures__", "fake-acp-agent.ts");

interface Harness {
  db: Database;
  store: AcpSessionStore;
  registry: AcpControllerRegistry;
  service: AcpSessionService;
}

interface HarnessOptions {
  behavior?: string;
  stateDir: string;
  delayMs?: number;
  liveItemBuffer?: number;
  db?: Database;
  command?: string;
  /** Profile `sessionMode` for the fake agent(s); default null. */
  sessionMode?: string | null;
}

const openHarnesses: Harness[] = [];

export async function shutdownHarnesses() {
  for (const harness of openHarnesses.splice(0)) {
    await harness.service.shutdown();
  }
}

export function makeHarness(options: HarnessOptions): Harness {
  const db = options.db ?? openTestDb();
  const store = new AcpSessionStore(db);
  const registry = new AcpControllerRegistry();
  const supervisor = new AcpProcessSupervisor({
    graceful_kill_ms: 1000,
    hard_kill_ms: 1000,
  });
  const profile: AgentProfile = {
    skillDiscovery: { kind: "additionalDirectories" },
    id: "fake",
    label: "Fake agent",
    command: options.command ?? process.execPath,
    args: options.command ? [] : [FIXTURE],
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
    sessionMode: options.sessionMode ?? null,
  };
  const profiles = new Map<AgentProfileId, AgentProfile>([["fake", profile]]);
  const worktrees: WorktreeProvider = {
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
      default_agent: "fake",
      graceful_kill_ms: 1000,
      idle_child_ttl_ms: 900000,
      live_item_buffer: options.liveItemBuffer ?? 5000,
      initial_item_window: Math.min(options.liveItemBuffer ?? 5000, 200),
      item_page_limit: 100,
      item_page_limit_max: 500,
    },
  });
  const harness: Harness = { db, store, registry, service };
  openHarnesses.push(harness);
  return harness;
}

export async function makeDirs(): Promise<{ stateDir: string; workdir: string }> {
  return {
    stateDir: await mkdtemp(join(tmpdir(), "fake-acp-state-")),
    workdir: await mkdtemp(join(tmpdir(), "fake-acp-work-")),
  };
}


export function spec(workdir: string, prompt = "build the thing"): AcpSessionStartSpec {
  return { initial_prompt: prompt, workdir, runtime: "fake" };
}

export async function until<T>(
  probe: () => T | null | undefined | false,
  timeoutMs = 8000,
  what = "condition",
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
