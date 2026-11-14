import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTestDb } from "../db/test-db";
import { GitWorktreeProvider } from "../worktree/service";
import { builtinAgentProfiles } from "./default-profiles";
import { AcpControllerRegistry } from "./controller-registry";
import { AcpProcessSupervisor } from "./process-supervisor";
import { AcpSessionService } from "./session-service";
import { AcpSessionStore } from "./store";

const runtime = process.env.KBBL_ACP_REAL_AGENT;
const realTest = runtime === "claude-code" || runtime === "codex" ? test : test.skip;
if (!runtime) console.warn("SKIP: real PR skill delivery smoke; set KBBL_ACP_REAL_AGENT=claude-code or codex and run test:acp:skills:real");

realTest(`real ${runtime}: pinned PR skill discovery with existing login`, async () => {
  const root = mkdtempSync(join(tmpdir(), "real-pr-skill-"));
  const repo = join(root, "repo");
  await Bun.$`mkdir -p ${repo}`.quiet();
  for (const args of [["init", "-q", "-b", "main"], ["config", "user.email", "smoke@example.com"], ["config", "user.name", "skill-smoke"], ["config", "commit.gpgsign", "false"], ["commit", "--allow-empty", "-qm", "init"]]) {
    await Bun.$`git -C ${repo} ${args}`.quiet();
  }
  const kbblRoot = join(import.meta.dir, "../..");
  const store = new AcpSessionStore(openTestDb());
  const controllers = new AcpControllerRegistry();
  const profiles = builtinAgentProfiles(kbblRoot);
  const integration = { default_integration: "none" as const, gated_review_url: null,
    skill_store_root: join(kbblRoot, "../workflow-config/definitions/skills"), session_skills_root: join(root, "session-skills") };
  const service = new AcpSessionService({ store, controllers, profiles,
    supervisor: new AcpProcessSupervisor({ graceful_kill_ms: 3000, hard_kill_ms: 5000 }),
    worktrees: new GitWorktreeProvider({ worktreesRoot: join(root, "worktrees"), store }), integration,
    config: { default_agent: runtime!, graceful_kill_ms: 3000, idle_child_ttl_ms: 900000, live_event_buffer: 2000 } });
  try {
    const index = JSON.parse(readFileSync(join(integration.skill_store_root, "../skills.json"), "utf8")) as { "github-cli": string };
    const identity = { run_id: "skill-smoke", unit_id: "skill-smoke/unit", worker: "builder", pr_integration: "github-cli" as const, pr_skill_digest: index["github-cli"] };
    const spec = { runtime: runtime!, workdir: repo, initial_prompt: "List your available skills and explicitly name pr-operations if available. Do not run tools or modify files." };
    const ensured = await service.ensureResumableSession("skill-smoke", spec, identity);
    if (!ensured.ok) throw new Error(`${ensured.error.code}: ${ensured.error.detail}`);
    const sid = ensured.value.session.sid;
    const observed = await service.observeInitialTurn(sid, 120000);
    expect(observed.ok && observed.value.kind).toBe("succeeded");
    const history = await service.loadHistory(sid);
    if (!history.ok) throw new Error(history.error.detail);
    const response = history.value.events.flatMap(event => event.kind === "agent_message" ? event.content.map(content => content.text) : []).join("");
    console.log(`[pr-skill-smoke] runtime=${runtime} digest=${index["github-cli"]} skill_listing=${response}`);
    expect(response).toContain("pr-operations");
    const row = store.getSession(sid)!;
    const status = await Bun.$`git -C ${row.worktree_path} status --porcelain`.text();
    console.log(`[pr-skill-smoke] runtime=${runtime} worktree_status=${status.trim() || "clean"}`);
    for (const container of [".agents", ".claude"]) expect(await Bun.file(join(row.worktree_path, container, "skills/pr-operations/SKILL.md")).exists()).toBe(false);
    expect(readFileSync(join(root, "session-skills", sid, ".agents/skills/pr-operations/SKILL.md")))
      .toEqual(readFileSync(join(integration.skill_store_root, index["github-cli"], "SKILL.md")));
    // Cold recovery must reproduce the pin while preserving the user's login.
    await controllers.getLive(sid)?.closeChild();
    expect((await service.loadHistory(sid)).ok).toBe(true);
    expect((await service.ensureResumableSession("skill-smoke", spec, identity)).ok).toBe(true);
  } finally {
    await service.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
}, 180000);
