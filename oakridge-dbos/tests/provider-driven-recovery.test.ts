/**
 * A real process, killed mid-run, with a live session already dispatched to
 * the provider.
 *
 * The child process runs the production composition and starts a shipped
 * bundle. The kbbl stub lives in the parent, so the parent can see the exact
 * sessions the child's provider started and can prove the replacement process
 * neither re-dispatched a child that was already live nor dropped one.
 */
import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { withDatabase } from "./effect-fixture";
import { startKbblStub } from "./kbbl-stub";
import {
  CORE_BINARY, eventually, loadBundle, localRepository, pendingSessions, PullRequests, revisionOf, startHarness,
} from "./bundle-harness";
import { analysisBody } from "./bundle-drive";

const url_of = (path: string) => JSON.stringify(new URL(path, import.meta.url).href);

test("a process killed mid-run recovers and completes without re-dispatching or dropping a child", async () => {
  await withDatabase(async ({ url, db }) => {
    const kbbl = startKbblStub(pendingSessions);
    const repository_path = localRepository("recovery");
    const repository_paths = new Map([["repo", repository_path]]);
    const pull_requests = new PullRequests();
    const marker = `/tmp/oakridge-recovery-${crypto.randomUUID()}`;
    const bundle = await loadBundle("development");
    const session_config = { runtime: "codex", workdir: repository_path, session_name: "recovery-repo" };
    const input = {
      spec: "Feature",
      repositories: [{ key: "repo", preparation: { repository_path, expected_head: null },
        build: session_config, integration: session_config,
        forge: { owner: "owner", name: "repo", build_base: "cohort", final_base: "main" } }],
      analysis: session_config, planning: session_config, briefs: session_config,
    };

    // The child is the real thing: production composition, production provider.
    const child_source = `
      import { createProductionComposition } from ${url_of("../src/runtime/compose.ts")};
      const observation = () => ({ provider: "github", owner: "owner", name: "repo", number: 1,
        url: "https://github.com/owner/repo/pull/1", head_branch: "work", base_branch: "cohort",
        head_sha: "head1", state: "open", source: "forge", observed_at: "2026-10-07", merged_at: null });
      const composition = await createProductionComposition({
        database_url: process.env.OAKRIDGE_RECOVERY_URL,
        core_binary: process.env.OAKRIDGE_RECOVERY_CORE,
        host: "127.0.0.1",
        kbbl_base_url: process.env.OAKRIDGE_RECOVERY_KBBL,
        pull_requests: { read: async () => ({ ok: true, value: observation() }),
          find_for_branches: async () => ({ ok: true, value: [observation()] }) },
        provider_capabilities: { probe: async () => ({ ok: true, value: true }),
          check_github: async () => ({ ok: true, value: true }) },
        timing: { observe_interval_seconds: 0.05, wake_timeout_seconds: 1 },
      });
      const created = await composition.app.request("/runs", { method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bundle: ${JSON.stringify(bundle)}, input: ${JSON.stringify(input)} }) });
      if (created.status !== 201) throw new Error("run not created: " + created.status + " " + await created.text());
      await Bun.write(process.env.OAKRIDGE_RECOVERY_MARKER, await created.text());
      await new Promise(() => {});
    `;
    const child_path = `${marker}.ts`;
    await Bun.write(child_path, child_source);
    const child = Bun.spawn({ cmd: ["bun", child_path], stderr: "pipe", stdout: "pipe",
      env: { ...process.env, OAKRIDGE_RECOVERY_URL: url, OAKRIDGE_RECOVERY_CORE: CORE_BINARY,
        OAKRIDGE_RECOVERY_KBBL: kbbl.url, OAKRIDGE_RECOVERY_MARKER: marker } });

    let harness: Awaited<ReturnType<typeof startHarness>> | null = null;
    try {
      const run: { run_id: string; root_scope_id: string } = await eventually(async () => {
        if (!(await Bun.file(marker).exists())) {
          if (child.exitCode !== null) throw new Error(`child exited early: ${await new Response(child.stderr).text()}`);
          return null;
        }
        return Bun.file(marker).json();
      }, "child to start the run", 90_000);

      // Wait until the child has driven the run far enough to hold a live
      // session: that session is the child this recovery must not duplicate.
      const analysis = await eventually(async () => {
        const rows = await db.query<{ id: string }>(
          "SELECT id FROM authority.scope_instance WHERE run_id=$1 AND scope_key='spec_analysis' LIMIT 1", [run.run_id]);
        return rows[0] ?? null;
      }, "analysis child", 90_000);
      const live = await eventually(async () => kbbl.session_for({ scope_id: analysis.id, worker: "author" }),
        "live analysis session", 90_000);
      const intents = await db.query<{ id: string }>(
        "SELECT id FROM authority.effect_intent WHERE scope_id=$1 AND payload->>'action'='start'", [analysis.id]);
      expect(intents).toHaveLength(1);

      // Kill it. No graceful shutdown, so nothing is parked on the way out.
      child.kill("SIGKILL");
      await child.exited;

      // A replacement process of the same engine version takes the run over.
      harness = await startHarness({ bundle: "development", database_url: url, db, label: "recovery",
        reuse: { kbbl, run_id: run.run_id, root_scope_id: run.root_scope_id, repository_paths, pull_requests } });

      // Not dropped: the recovered process carries the same session to a
      // committed terminal state, and the operator can still finish the stage.
      const revision_id = await harness.publish(analysis.id, "author", "analysis", analysisBody);
      await harness.awaitState(analysis.id, "review");
      harness.settle(analysis.id, "author");
      await harness.awaitTerminalExecution(analysis.id);
      await harness.requireCommand(analysis.id, "accept", { revision: revisionOf(revision_id) });
      const done = await harness.awaitTerminalScope(analysis.id);
      expect((done.outcome?.data as { variant?: string }).variant).toBe("complete");

      // Not re-dispatched: still one start intent and one kbbl session for the
      // worker that was already live when the process died.
      expect(kbbl.sessions_for({ scope_id: analysis.id, worker: "author" }).map((item) => item.sid)).toEqual([live.sid]);
      const after = await db.query<{ id: string }>(
        "SELECT id FROM authority.effect_intent WHERE scope_id=$1 AND payload->>'action'='start'", [analysis.id]);
      expect(after.map((row) => row.id)).toEqual(intents.map((row) => row.id));
    } finally {
      if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited; }
      if (harness) await harness.close();
      kbbl.stop();
      rmSync(repository_path, { recursive: true, force: true });
      rmSync(marker, { force: true });
      rmSync(child_path, { force: true });
      rmSync(resolve(`${marker}.ts`), { force: true });
    }
  });
}, 600_000);
