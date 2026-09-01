/**
 * Real-agent smoke tests (§24.2). Opt-in, never default CI:
 *
 *   bun run test:acp:codex:real
 *   bun run test:acp:claude:real
 *
 * Runs the full production path — AcpSessionService, real git worktree,
 * real installed agent binary (billing/auth exactly as production) — in a
 * throwaway repo, and prints a concise capability/behavior report.
 */

import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openTestDb } from "../db/test-db";
import { GitWorktreeProvider } from "../worktree/service";
import { builtinAgentProfiles } from "./default-profiles";
import { AcpControllerRegistry } from "./controller-registry";
import { AcpProcessSupervisor } from "./process-supervisor";
import { AcpSessionService } from "./session-service";
import { AcpSessionStore } from "./store";

const REAL_AGENT = process.env.KBBL_ACP_REAL_AGENT ?? "";
const realTest = REAL_AGENT === "claude-code" || REAL_AGENT === "codex" ? test : test.skip;

const cleanups: Array<() => Promise<void> | void> = [];
afterAll(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function gitInitRepo(dir: string): Promise<void> {
  const cmds: string[][] = [
    ["git", "-C", dir, "init", "-q", "-b", "main"],
    ["git", "-C", dir, "config", "user.email", "smoke@example.com"],
    ["git", "-C", dir, "config", "user.name", "acp-smoke"],
    ["git", "-C", dir, "config", "commit.gpgsign", "false"],
    ["git", "-C", dir, "commit", "--allow-empty", "-q", "-m", "init"],
  ];
  for (const cmd of cmds) {
    const p = Bun.spawn({ cmd, stdout: "pipe", stderr: "pipe" });
    const [stderr, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
    if (code !== 0) throw new Error(`${cmd.join(" ")} failed (exit ${code}): ${stderr}`);
  }
}

realTest(
  `real ${REAL_AGENT}: ensure → prompt → config options → history reload`,
  async () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), `acp-real-${REAL_AGENT}-`));
    const repoDir = join(tmpRoot, "repo");
    await Bun.$`mkdir -p ${repoDir} ${join(tmpRoot, "worktrees")}`.quiet();
    await gitInitRepo(repoDir);

    // The kbbl package root: this file lives at kbbl/core/acp/.
    const kbblRoot = join(import.meta.dir, "..", "..");
    const profiles = builtinAgentProfiles(kbblRoot);
    const db = openTestDb();
    const store = new AcpSessionStore(db);
    const registry = new AcpControllerRegistry();
    const service = new AcpSessionService({
      store,
      controllers: registry,
      profiles,
      supervisor: new AcpProcessSupervisor({ graceful_kill_ms: 3000, hard_kill_ms: 5000 }),
      worktrees: new GitWorktreeProvider({ worktreesRoot: join(tmpRoot, "worktrees"), store }),
      config: {
        default_agent: REAL_AGENT,
        graceful_kill_ms: 3000,
        idle_child_ttl_ms: 900_000,
        live_event_buffer: 2000,
      },
    });
    cleanups.push(async () => {
      await service.shutdown();
      rmSync(tmpRoot, { recursive: true, force: true });
    });

    const report: string[] = [`agent=${REAL_AGENT}`];

    const ensured = await service.ensureResumableSession("smoke-1", {
      initial_prompt:
        'Reply with exactly the text SMOKE-OK and nothing else. Do not run tools.',
      workdir: repoDir,
      runtime: REAL_AGENT,
    });
    if (!ensured.ok) throw new Error(`ensure failed: ${ensured.error.code} ${ensured.error.detail}`);
    const sid = ensured.value.session.sid;
    report.push(`sid=${sid}`, `worktree=${ensured.value.session.worktree_branch}`);

    const observed = await service.observeInitialTurn(sid, 120_000);
    if (!observed.ok) throw new Error(`observe failed: ${observed.error.code}`);
    report.push(`initial_turn=${observed.value.kind}`);
    expect(observed.value.kind).toBe("succeeded");

    const controller = registry.getLive(sid as never);
    const options = controller?.liveConfigOptions ?? [];
    report.push(
      `config_options=${options.map((option) => `${option.id}(${option.category ?? "-"})`).join(",") || "none"}`,
    );

    const history = await service.loadHistory(sid);
    if (!history.ok) throw new Error(`history failed: ${history.error.code}`);
    const reply = history.value.events.find(
      (event) =>
        event.kind === "agent_message" &&
        event.content.some((content) => content.text.includes("SMOKE-OK")),
    );
    report.push(`agent_reply=${reply ? "SMOKE-OK" : "MISSING"}`);
    expect(reply).toBeDefined();

    // Kill the child, then rebuild history through session/load — the §10.3
    // production restart path, against the real agent's own store.
    const before = registry.getLive(sid as never);
    if (before) await before.closeChild();
    const reloaded = await service.loadHistory(sid);
    if (!reloaded.ok) throw new Error(`reload failed: ${reloaded.error.code}`);
    report.push(`load_replay=${reloaded.value.expired ? "EXPIRED" : `${reloaded.value.events.length} events`}`);
    expect(reloaded.value.expired).toBe(false);

    console.log(`[acp-real-smoke] ${report.join(" | ")}`);
  },
  180_000,
);
