import { Hono } from "hono";
import { join, resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { AcpSessionService } from "../../kbbl/core/acp/session-service";
import { AcpSessionStore } from "../../kbbl/core/acp/store";
import { AcpControllerRegistry } from "../../kbbl/core/acp/controller-registry";
import { AcpProcessSupervisor } from "../../kbbl/core/acp/process-supervisor";
import { builtinAgentProfiles } from "../../kbbl/core/acp/default-profiles";
import { openDb } from "../../kbbl/core/db/connection";
import { applyMigrations } from "../../kbbl/core/db/migrations";
import { GitWorktreeProvider } from "../../kbbl/core/worktree/service";
import { mountSessionsRoutes } from "../../kbbl/core/server/handlers/sessions";
import type { WorktreeProvider } from "../../kbbl/core/acp/types";
import type { LiveSourceGit } from "./live-source-git";

/** Real installed ACP agents with a durable ledger, isolated from the operator's kbbl. */
export async function openLiveSourceAgent(directory: string, git: LiveSourceGit) {
  await mkdir(join(directory, "worktrees"), { recursive: true });
  const root = resolve(import.meta.dir, "../../kbbl");
  const ledger = openDb(join(directory, "kbbl.db"));
  applyMigrations(ledger, join(root, "core/db/migrations"));
  const store = new AcpSessionStore(ledger);
  const local = new GitWorktreeProvider({ worktreesRoot: join(directory, "worktrees"), store });
  // Refresh via the review gate, then hand kbbl an immutable SHA. Its ordinary
  // origin/<branch> shell-fetch path is never used by this isolated launcher.
  const worktrees: WorktreeProvider = { async resolve(sid, spec) {
    const base = spec.worktree?.base_ref;
    if (!base?.startsWith("origin/")) return local.resolve(sid, spec);
    const refreshed = await git.run(spec.workdir, ["fetch", "origin", `+refs/heads/${base.slice(7)}:refs/remotes/${base}`]);
    if (refreshed.exit_code) throw new Error(refreshed.stderr);
    const head = await git.run(spec.workdir, ["rev-parse", `refs/remotes/${base}`]);
    if (head.exit_code) throw new Error(head.stderr);
    return local.resolve(sid, { ...spec, worktree: { ...spec.worktree!, base_ref: head.stdout.trim() } });
  } };
  const service = new AcpSessionService({ store, controllers: new AcpControllerRegistry(),
    profiles: builtinAgentProfiles(root), supervisor: new AcpProcessSupervisor({ graceful_kill_ms: 3000, hard_kill_ms: 5000 }),
    worktrees, config: { default_agent: "codex", graceful_kill_ms: 3000, idle_child_ttl_ms: 900_000, live_event_buffer: 2000 } });
  const app = new Hono();
  mountSessionsRoutes(app, { acp: service, defaultWorkdir: null });
  return { app, async close() { try { await service.shutdown(); } finally { ledger.close(); } } };
}
