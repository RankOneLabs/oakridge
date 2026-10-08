import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { createProductionComposition } from "../src/runtime/compose";
import { runWorkflowId, wakeRun } from "../src/workflows/topology";
import { withDatabase } from "./effect-fixture";

const CORE_BINARY = resolve(import.meta.dir, "../../workflow-core/target/debug/workflow-cli");

async function cli(args: readonly string[], url: string): Promise<unknown> {
  const child = Bun.spawn({ cmd: ["bun", "run", "src/ops.ts", "--", ...args], cwd: resolve(import.meta.dir, ".."),
    env: { ...process.env, DBOS_SYSTEM_DATABASE_URL: url, OAKRIDGE_CORE_BINARY: CORE_BINARY }, stdout: "pipe", stderr: "pipe" });
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

test("ops lists and inspects a live run, forks an ERROR run, and migrates idempotently", async () => withDatabase(async ({ url, db }) => {
  let composition = await createProductionComposition({ database_url: url,
    core_binary: resolve(import.meta.dir, "../../workflow-core/target/debug/workflow-cli"), host: "127.0.0.1",
    timing: { wake_timeout_seconds: 5 } });
  try {
    const bundle = await Bun.file(resolve(import.meta.dir, "../../workflow-core/fixtures/bundles/minimal.json")).json();
    const response = await composition.app.request("http://localhost/runs", { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ bundle, input: {} }) });
    expect(response.status).toBe(201);
    const run: { run_id: string; root_scope_id: string } = await response.json();
    const id = runWorkflowId(run.run_id);
    await eventually(async () => (await DBOS.getWorkflowStatus(id))?.status === "PENDING");
    const list = await cli(["workflows", "list"], url) as { workflowID: string; status: string }[];
    expect(list).toContainEqual(expect.objectContaining({ workflowID: id, status: "PENDING" }));
    expect(await cli(["workflows", "inspect", id], url)).toMatchObject({ status: { workflowID: id, status: "PENDING" } });
    expect(await cli(["migrate"], url)).toEqual({ migrated: true });
    expect(await cli(["migrate"], url)).toEqual({ migrated: true });

    await composition.close();
    await db.query("UPDATE dbos.workflow_status SET status='ERROR' WHERE workflow_uuid=$1", [id]);
    const recovered = await cli(["workflows", "recover", id], url);
    expect(recovered).toMatchObject({ workflowID: runWorkflowId(run.run_id, 1), action: "forked" });
    expect((await db.query<{ current_generation: string }>("SELECT current_generation FROM authority.run WHERE id=$1", [run.run_id]))[0]?.current_generation).toBe("1");

    composition = await createProductionComposition({ database_url: url,
      core_binary: resolve(import.meta.dir, "../../workflow-core/target/debug/workflow-cli"), host: "127.0.0.1",
      timing: { wake_timeout_seconds: 5 } });
    await db.query("UPDATE authority.scope_instance SET is_terminal=true WHERE id=$1", [run.root_scope_id]);
    await wakeRun(run.run_id);
    await eventually(async () => (await DBOS.getWorkflowStatus(runWorkflowId(run.run_id, 1)))?.status === "SUCCESS");
  } finally { await composition.close(); }
}), 45_000);
