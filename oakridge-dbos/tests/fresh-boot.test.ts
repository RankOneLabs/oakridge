import { expect, spyOn, test } from "bun:test";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { createProductionComposition } from "../src/runtime/compose";
import { openDatabase, type Database } from "../src/storage/database";
import { migrateEmptyDatabase } from "../src/storage/migrate";
import type { RunInspectView } from "../src/projections/run-view";
import { runWorkflowId, sweepRunsNeedingWork } from "../src/workflows/topology";
import { CoreClient } from "../src/core-client/client";
import { pinSample, sampleWorkflow, scratchDatabase } from "./authority-fixture";

const json = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

type Composition = Awaited<ReturnType<typeof createProductionComposition>>;
/** A production composition booted on a freshly migrated scratch database, closed and dropped after `body`. */
async function booted(body: (context: { readonly app: Composition["app"]; readonly db: Database }) => Promise<void>,
  before?: (db: Database) => Promise<void>): Promise<void> {
  const scratch = await scratchDatabase();
  const db = openDatabase(scratch.url);
  let composition: Composition | null = null;
  try {
    await migrateEmptyDatabase(db);
    await before?.(db);
    composition = await createProductionComposition({ database_url: scratch.url, host: "127.0.0.1", timing: { wake_timeout_seconds: 1 } });
    await body({ app: composition.app, db });
  } finally {
    if (composition) await composition.close();
    await db.destroy();
    await scratch.drop();
  }
}

test("an empty database migrates, boots, pins, launches and carries the first worker to the executor", () => booted(async ({ app, db }) => {
  const definitions = await (await app.request("/api/definitions")).json() as { readonly items: readonly { readonly bundle: { readonly key: string } }[] };
  const empty = { definitions: definitions.items.map((item) => item.bundle.key), runs: await (await app.request("/api/runs")).json() };
  const pinned = await app.request("/api/definitions", json(sampleWorkflow("review-loop")));
  const { digest } = await pinned.json() as { readonly digest: string };
  const launch = (input: unknown) => app.request("/api/runs", json({ digest, input, request_id: "launch-1" }));
  const launched = await launch({ topic: "Oakridge" });
  const created = await launched.json() as { readonly run_id: string; readonly event_id: string };
  const replay = await launch({ topic: "Oakridge" });
  const conflict = await launch({ topic: "Changed" });
  const invalid = await Promise.all([{}, { request_id: "" }, { request_id: 42 }, { request_id: "x".repeat(201) }]
    .map(async (identity) => (await app.request("/api/runs", json({ digest, input: {}, ...identity }))).status));
  let inspect: RunInspectView | null = null;
  for (let poll = 0; poll < 100 && !inspect?.attention.length; poll++) {
    await Bun.sleep(100);
    inspect = await (await app.request(`/api/runs/${created.run_id}/inspect`)).json() as RunInspectView;
  }
  const writers = await db.selectFrom("authority.event").select("writer").where("run_id", "=", created.run_id).orderBy("created_at").execute();
  const runs = await (await app.request("/api/runs")).json() as { readonly items: readonly { readonly run_id: string }[] };
  expect({ empty, pinned: pinned.status, launched: launched.status, replay: [replay.status, (await replay.json() as { event_id: string }).event_id === created.event_id],
    conflict: conflict.status, invalid, runs: runs.items.map((run) => run.run_id),
    attention: inspect?.attention.flatMap((item) => item.kind === "stalled_worker" ? [[item.worker, item.detail]] : []), writers: writers.map((row) => row.writer.kind) })
    .toEqual({ empty: { definitions: ["development"], runs: { items: [], next_cursor: null } }, pinned: 201, launched: 201,
      replay: [200, true], conflict: 409, invalid: [400, 400, 400, 400], runs: [created.run_id],
      attention: [["writer", "agent workers need KBBL_BASE_URL and OAKRIDGE_PUBLICATION_KEY"]], writers: ["operator", "executor"] });
}), 30_000);

test("boot makes the committed workflows the only launchable definitions", () => {
  let stale = "";
  return booted(async ({ app }) => {
    const listed = async (query: string) => ((await (await app.request(`/api/definitions${query}`)).json()) as
      { readonly items: readonly { readonly digest: string; readonly bundle: { readonly key: string } }[] }).items;
    const launch = await app.request("/api/runs", json({ digest: stale, input: { topic: "Oakridge" }, request_id: "launch-stale" }));
    expect({ launchable: (await listed("")).map((item) => item.bundle.key), stale_archived: (await listed("?archived=true")).some((item) => item.digest === stale),
      stale_launch: launch.status }).toEqual({ launchable: ["development"], stale_archived: true, stale_launch: 404 });
  }, async (db) => {
    const started = CoreClient.start();
    if (!started.ok) throw new Error("core WASM did not load");
    try { stale = (await pinSample({ db, core: started.value })).digest; } finally { started.value.close(); }
  });
}, 30_000);

test("a run whose wake failed to start its workflow is carried by the next sweep", () => booted(async ({ app, db }) => {
  const { digest } = await (await app.request("/api/definitions", json(sampleWorkflow("review-loop")))).json() as { readonly digest: string };
  const start = spyOn(DBOS, "startWorkflow").mockImplementationOnce(() => { throw new Error("system database unavailable"); });
  let stranded: string | null;
  let run_id: string;
  try {
    run_id = (await (await app.request("/api/runs", json({ digest, input: { topic: "Oakridge" }, request_id: "launch-1" }))).json() as { readonly run_id: string }).run_id;
    for (let poll = 0; poll < 50 && start.mock.calls.length === 0; poll++) await Bun.sleep(20);
    stranded = (await DBOS.getWorkflowStatus(runWorkflowId(run_id, 0)))?.status ?? null;
  } finally { start.mockRestore(); }
  await sweepRunsNeedingWork(db);
  const carried = (await DBOS.getWorkflowStatus(runWorkflowId(run_id, 0)))?.status ?? null;
  expect({ stranded, is_carried: carried !== null }).toEqual({ stranded: null, is_carried: true });
}), 30_000);
