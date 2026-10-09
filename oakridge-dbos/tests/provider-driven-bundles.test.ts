import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createProductionComposition } from "../src/runtime/compose";
import type { DefinitionBundle } from "../src/core-client/generated-contracts";
import type { PullRequestReader } from "../src/runtime/github-pull-requests";
import type { ScopeInstanceRecord } from "../src/storage/schema-records";
import { withDatabase } from "./effect-fixture";

const names = ["development", "development-independent-siblings", "development-verification"] as const;
const binary = resolve(import.meta.dir, "../../workflow-core/target/debug/workflow-cli");

function localRepository(): string {
  const path = mkdtempSync(resolve(tmpdir(), "oakridge-provider-bundle-"));
  for (const args of [["init"], ["-c", "commit.gpgsign=false", "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "initial"],
    ["remote", "add", "origin", "https://github.com/owner/repo.git"]]) {
    const result = Bun.spawnSync({ cmd: ["git", ...args], cwd: path, stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  }
  return path;
}

async function eventually<T>(read: () => Promise<T | null | undefined>, label: string, detail?: () => Promise<string>): Promise<T> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== null && value !== undefined) return value;
    await Bun.sleep(30);
  }
  // The detail is read at timeout so it reports the stalled state, not the state at the call.
  throw new Error(`timed out awaiting ${label}${detail ? `; ${await detail()}` : ""}`);
}

for (const name of names) test(`${name}: shipped bundle starts through the production provider`, async () => {
  const repository_path = localRepository();
  // Mirrors kbbl's resumable routes: the session key is a decoded route parameter
  // and kbbl answers with its own sid, which later requests address.
  const sessions = new Map<string, { completed: boolean; failed: boolean }>();
  const sids = new Map<string, string>();
  const kbbl = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (request) => {
    const segments = new URL(request.url).pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const target = segments[0] === "sessions" && segments[1] === "resumable" ? segments[2] ?? "" : segments[1] ?? "";
    if (request.method === "PUT") {
      const sid = sids.get(target) ?? crypto.randomUUID();
      sids.set(target, sid);
      sessions.set(sid, { completed: true, failed: false });
      return Response.json({ kind: "attached", session: { sid, status: "live" } });
    }
    if (request.method === "DELETE") return Response.json({ stopped: true });
    const session = sessions.get(target);
    return session?.completed ? Response.json({ session: { endReason: "subprocess_exited" }, exit_code: session.failed ? 1 : 0 })
      : Response.json({ pending: true }, { status: 202 });
  } });
  const pull_requests: PullRequestReader = { read: async () => ({ ok: true, value: null }), find_for_branches: async () => ({ ok: true, value: [] }) };
  try {
    await withDatabase(async ({ url, db }) => {
      const bundle: DefinitionBundle = await Bun.file(resolve(import.meta.dir, `../../workflow-config/definitions/${name}.json`)).json();
      const repository = { key: "repo", preparation: { repository_path, expected_head: null },
        build: { runtime: "codex", workdir: repository_path, session_name: "build" },
        integration: { runtime: "codex", workdir: repository_path, session_name: "integration" },
        forge: { owner: "owner", name: "repo", build_base: "cohort", final_base: "main" } };
      const session = { runtime: "codex", workdir: repository_path, session_name: "test" };
      const input = { spec: "Feature", repositories: [repository], analysis: session, planning: session, briefs: session,
        ...(name === "development-verification" ? { verification_note: "verify" } : {}) };
      const options = { database_url: url, core_binary: binary, host: "127.0.0.1",
        kbbl_base_url: kbbl.url.href, pull_requests,
        provider_capabilities: { probe: async () => ({ ok: true as const, value: true as const }),
          check_github: async () => ({ ok: true as const, value: true as const }) },
        timing: { observe_interval_seconds: 0.05, wake_timeout_seconds: 1 } };
      const composition = await createProductionComposition(options);
      try {
        const created = await composition.app.request("/runs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ bundle, input }) });
        expect(created.status).toBe(201);
        const run: { run_id: string; root_scope_id: string } = await created.json();
        const first = await eventually(async () => (await db.query<ScopeInstanceRecord>(
          "SELECT * FROM authority.scope_instance WHERE parent_id=$1 AND scope_key='repository_preparation' LIMIT 1", [run.root_scope_id]))[0], "repository child");
        await eventually(async () => (await db.query<{ status: string }>(
          "SELECT status FROM authority.execution WHERE scope_id=$1 ORDER BY id LIMIT 1", [first.id]))[0]?.status === "terminal" ? true : null, "prepared repository");
        const analysis = await eventually(async () => (await db.query<ScopeInstanceRecord>(
          "SELECT * FROM authority.scope_instance WHERE parent_id=$1 AND scope_key='spec_analysis' LIMIT 1", [run.root_scope_id]))[0], "analysis child");
        // The declared entry command is dispatched by the run workflow.
        // Issuing another begin here races that automatic transition.
        await eventually(async () => (await db.query<{ status: string }>(
          "SELECT status FROM authority.execution WHERE scope_id=$1 ORDER BY id LIMIT 1", [analysis.id]))[0]?.status === "terminal" ? true : null,
          "analysis session terminal", async () => `sessions=${JSON.stringify([...sessions])}; executions=${JSON.stringify(await db.query("SELECT id,status FROM authority.execution WHERE scope_id=$1", [analysis.id]))}; intents=${JSON.stringify(await db.query("SELECT id,status FROM authority.effect_intent WHERE scope_id=$1", [analysis.id]))}`);
        expect((await db.query<{ result: unknown }>("SELECT result FROM authority.execution WHERE scope_id=$1", [analysis.id]))[0]?.result)
          .toMatchObject({ schema: "unit", data: { kind: "record" } });
      } finally { await composition.close(); }
    });
  } finally { kbbl.stop(true); rmSync(repository_path, { recursive: true, force: true }); }
}, 40_000);
