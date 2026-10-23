import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { sql } from "kysely";
import { createProductionComposition } from "../src/runtime/compose";
import { openDatabase } from "../src/storage/database";
import { migrateEmptyDatabase } from "../src/storage/migrate";
import { runWorkflowId, wakeRun } from "../src/workflows/topology";
import { sampleWorkflow, scratchDatabase } from "./authority-fixture";

async function cli(args: readonly string[], url: string): Promise<unknown> {
  const child = Bun.spawn({ cmd: ["bun", "run", "src/ops.ts", "--", ...args], cwd: resolve(import.meta.dir, ".."),
    env: { ...process.env, DBOS_SYSTEM_DATABASE_URL: url }, stdout: "pipe", stderr: "pipe" });
  const [output, errors, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (exit !== 0) throw new Error(`ops exited ${exit}: ${errors}\n${output}`);
  const lines = output.split("\n");
  const start = lines.findLastIndex((line) => line === "[" || line === "{");
  if (start < 0) throw new Error(`ops returned no JSON: ${output}`);
  return JSON.parse(lines.slice(start).join("\n")) as unknown;
}

async function eventually(predicate: () => Promise<boolean>): Promise<void> {
  const until = Date.now() + 10_000;
  while (Date.now() < until) {
    if (await predicate()) return;
    await Bun.sleep(25);
  }
  throw new Error("timed out waiting for ops recovery");
}
const json = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("ops lists and inspects a live run, forks an ERROR run, and migrates idempotently", async () => {
  const scratch = await scratchDatabase();
  const db = openDatabase(scratch.url);
  await migrateEmptyDatabase(db);
  const compose = () => createProductionComposition({ database_url: scratch.url, host: "127.0.0.1", timing: { wake_timeout_seconds: 5 } });
  let composition = await compose();
  try {
    const pinned = await (await composition.app.request("/api/definitions", json(sampleWorkflow("review-loop")))).json() as { readonly digest: string };
    const launched = await composition.app.request("/api/runs", json({ digest: pinned.digest, input: { topic: "Oakridge" }, request_id: "ops-live" }));
    const { run_id } = await launched.json() as { readonly run_id: string };
    const id = runWorkflowId(run_id);
    await eventually(async () => (await DBOS.getWorkflowStatus(id))?.status === "PENDING");
    const list = await cli(["workflows", "list"], scratch.url) as { workflowID: string; status: string }[];
    expect(list).toContainEqual(expect.objectContaining({ workflowID: id, status: "PENDING" }));
    expect(await cli(["workflows", "inspect", id], scratch.url)).toMatchObject({ status: { workflowID: id, status: "PENDING" } });
    expect(await cli(["migrate"], scratch.url)).toEqual({ migrated: true });
    expect(await cli(["migrate"], scratch.url)).toEqual({ migrated: true });

    await composition.close();
    await sql`UPDATE dbos.workflow_status SET status='ERROR' WHERE workflow_uuid=${id}`.execute(db);
    expect(await cli(["workflows", "recover", id], scratch.url)).toMatchObject({ workflowID: runWorkflowId(run_id, 1), action: "forked" });

    composition = await compose();
    await composition.app.request(`/api/runs/${run_id}/cancel`, json({ request_id: "ops-live-cancel" }));
    await wakeRun(run_id);
    await eventually(async () => (await DBOS.getWorkflowStatus(runWorkflowId(run_id, 1)))?.status === "SUCCESS");
  } finally { await composition.close(); await db.destroy(); await scratch.drop(); }
}, 45_000);
