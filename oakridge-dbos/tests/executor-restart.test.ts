import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { Subprocess } from "bun";
import { openDatabase, type Database } from "../src/storage/database";
import { sampleWorkflow, scratchDatabase } from "./authority-fixture";
import { eventually, startStubKbbl, type StubKbbl } from "./stub-kbbl";

/**
 * Part 1 §11 I4: kill the server mid-run and restart it. The run finishes,
 * and no kbbl session is started twice: the stub counts the sessions it
 * creates per key. The server is the real process (`src/main.ts`), killed
 * with SIGKILL by its own PID, so nothing gets to park its workflows first.
 */

let scratch: Awaited<ReturnType<typeof scratchDatabase>>;
let db: Database;
let stub: StubKbbl;
let released = false;
const started = new Set<string>();
const workdir = mkdtempSync(resolve(tmpdir(), "oakridge-restart-"));
let server: Subprocess | null = null;
let port = 0;

beforeAll(async () => {
  scratch = await scratchDatabase();
  db = openDatabase(scratch.url);
  stub = startStubKbbl(async (turn) => {
    started.add(turn.session_key);
    await eventually("release", async () => released, 120_000);
    const published = await turn.publish("result", `done: ${turn.task.length}`);
    return published.ok ? "succeeded" : "failed";
  });
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  port = probe.port ?? 0;
  void probe.stop(true);
});
afterAll(async () => {
  server?.kill(9);
  stub.stop();
  await db.destroy();
  await scratch.drop();
  rmSync(workdir, { recursive: true, force: true });
});

const base_url = (): string => `http://127.0.0.1:${port}`;
async function startServer(): Promise<Subprocess> {
  const child = Bun.spawn(["bun", "run", resolve(import.meta.dir, "../src/main.ts")], { stdout: "ignore", stderr: "ignore",
    env: { ...process.env, DBOS_SYSTEM_DATABASE_URL: scratch.url, PORT: String(port), OAKRIDGE_DBOS_HOST: "127.0.0.1",
      KBBL_BASE_URL: stub.url, OAKRIDGE_PUBLICATION_KEY: "restart-key", OAKRIDGE_PUBLIC_URL: base_url(), OAKRIDGE_AGENT_WORKDIR: workdir,
      OAKRIDGE_CONTROL_TOKEN: "", DBOS_APPLICATION_VERSION: "" } });
  await eventually("the server to listen", async () => (await fetch(`${base_url()}/api/runs`).catch(() => null))?.ok, 60_000);
  return child;
}
async function git(path: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn(["git", "-C", path, ...args], { stdout: "pipe", stderr: "ignore" });
  const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed`);
  return stdout.trim();
}

test("I4: a run survives a killed server, with no session started twice", async () => {
  const repo = mkdtempSync(resolve(tmpdir(), "oakridge-restart-repo-"));
  try {
    await git(repo, "init", "-q", "-b", "main");
    await git(repo, "-c", "user.email=e2e@oakridge.test", "-c", "user.name=e2e", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "base");
    await git(repo, "remote", "add", "origin", "git@github.com:oakridge-e2e/restart.git");
    server = await startServer();
    const json = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const { digest } = await (await fetch(`${base_url()}/api/definitions`, json(sampleWorkflow("fan-out")))).json() as { readonly digest: string };
    const items = ["a", "b", "c", "d"].map((key) => ({ key, text: key, after: [] }));
    const launched = await fetch(`${base_url()}/api/runs`, json({ request_id: crypto.randomUUID(), digest,
      input: { repository: { repository_path: repo, expected_head: null }, items } }));
    const { run_id } = await launched.json() as { readonly run_id: string };
    await eventually("two item sessions working", async () => started.size === 2, 60_000);

    server.kill(9);
    await server.exited;
    server = await startServer();
    released = true;

    await eventually("the run to finish", async () =>
      (await db.selectFrom("authority.run").select("status").where("id", "=", run_id).executeTakeFirst())?.status.kind === "done", 150_000);
    expect({ sessions: stub.sessions.size, created_twice: [...stub.creates.values()].filter((count) => count > 1).length })
      .toEqual({ sessions: 4, created_twice: 0 });
  } finally { rmSync(repo, { recursive: true, force: true }); }
}, 240_000);
