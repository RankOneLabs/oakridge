import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { prepareAgentWorkdir } from "../src/runtime/agent-workdir";
import { createProductionComposition } from "../src/runtime/compose";
import { BunGitCommandRunner } from "../src/runtime/git-command-runner";
import { openDatabase, type Database } from "../src/storage/database";
import { migrateEmptyDatabase } from "../src/storage/migrate";
import { sampleWorkflow, scratchDatabase } from "./authority-fixture";
import { eventually } from "./stub-kbbl";

/**
 * Part 1 §11 I5: sample A once against a real kbbl with a real agent. Opt-in,
 * like kbbl's own real-agent smoke tests: it spends agent turns, so it runs
 * only when OAKRIDGE_REAL_KBBL_URL names a kbbl to use, never the live one.
 *
 *   OAKRIDGE_REAL_KBBL_URL=http://127.0.0.1:8798 OAKRIDGE_TEST_DATABASE_URL=… \
 *     bun test --timeout=1200000 tests/real-agent.smoke.test.ts
 */
const kbbl_url = process.env.OAKRIDGE_REAL_KBBL_URL;

let scratch: Awaited<ReturnType<typeof scratchDatabase>>;
let db: Database;
let server: ReturnType<typeof Bun.serve>;
let composition: Awaited<ReturnType<typeof createProductionComposition>>;
let base_url = "";
const workdir = mkdtempSync(resolve(tmpdir(), "oakridge-real-agent-"));

beforeAll(async () => {
  if (!kbbl_url) return;
  const prepared = await prepareAgentWorkdir(workdir, new BunGitCommandRunner());
  if (!prepared.ok) throw new Error(prepared.error.detail);
  scratch = await scratchDatabase();
  db = openDatabase(scratch.url);
  await migrateEmptyDatabase(db);
  let handler: (request: Request) => Response | Promise<Response> = () => new Response("starting", { status: 503 });
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (request) => handler(request) });
  base_url = `http://127.0.0.1:${server.port}`;
  composition = await createProductionComposition({ database_url: scratch.url, host: "127.0.0.1",
    executor: { kbbl_base_url: kbbl_url, publication_key: crypto.randomUUID(), publish_base_url: base_url, agent_workdir: workdir, github_token: null } });
  handler = composition.app.fetch;
}, 120_000);
afterAll(async () => {
  if (!kbbl_url) return;
  await composition.close();
  server.stop(true);
  await db.destroy();
  await scratch.drop();
  rmSync(workdir, { recursive: true, force: true });
});

test.skipIf(!kbbl_url)("I5: sample A runs once against real kbbl with a real agent, revising in the same session", async () => {
  const post = async (path: string, body: unknown): Promise<Response> =>
    fetch(`${base_url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const { digest } = await (await post("/api/definitions", sampleWorkflow("review-loop"))).json() as { readonly digest: string };
  const launched = await post("/api/runs", { request_id: crypto.randomUUID(), digest, input: { topic: "why durable workflows checkpoint each step" } });
  const { run_id } = await launched.json() as { readonly run_id: string };
  const unit = `${run_id}/document`;
  const drafts = () => db.selectFrom("authority.artifact_revision").select(["id", "body"]).where("run_id", "=", run_id).where("artifact", "=", "draft")
    .orderBy("created_at").orderBy("id").execute();
  const critiqued = async (revision: string) => (await db.selectFrom("authority.artifact_revision").select("id").where("run_id", "=", run_id)
    .where("artifact", "=", "critique").where("subject", "=", revision).execute()).length > 0;
  const decide = (decision: string, target: string, payload: unknown) =>
    post(`/api/runs/${encodeURIComponent(run_id)}/units/${encodeURIComponent(unit)}/reviews/editor/decide`, { request_id: crypto.randomUUID(), decision, target, payload });

  const [r1] = await eventually("the first draft, critiqued", async () => {
    const published = await drafts();
    return published[0] && await critiqued(published[0].id) ? published : null;
  }, 600_000);
  expect((await decide("request_changes", r1!.id, { feedback: "Make it at most three sentences." })).status).toBe(201);
  const r2 = await eventually("the revised draft, critiqued", async () => {
    const published = await drafts();
    const latest = published.at(-1);
    return published.length >= 2 && latest && await critiqued(latest.id) ? latest : null;
  }, 600_000);
  expect((await decide("approve", r2.id, {})).status).toBe(201);
  await eventually("the run to finish", async () =>
    (await db.selectFrom("authority.unit").select("status").where("run_id", "=", run_id).where("id", "=", run_id).executeTakeFirstOrThrow()).status.kind === "done", 120_000);
  const writer = await db.selectFrom("authority.attempt").select(["kbbl_session_id", "status"]).where("run_id", "=", run_id).where("worker", "=", "writer").execute();
  expect({ sessions: new Set(writer.map((attempt) => attempt.kbbl_session_id)).size, writer_attempts: writer.length })
    .toEqual({ sessions: 1, writer_attempts: 2 });
}, 1_500_000);
