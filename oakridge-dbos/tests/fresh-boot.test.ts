import { expect, test } from "bun:test";
import { createProductionComposition } from "../src/runtime/compose";
import { openDatabase } from "../src/storage/database";
import { migrateEmptyDatabase } from "../src/storage/migrate";
import type { RunInspectView } from "../src/projections/run-view";
import { sampleWorkflow, scratchDatabase } from "./authority-fixture";

const json = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("an empty database migrates, boots, pins, launches and carries the first worker to the executor", async () => {
  const scratch = await scratchDatabase();
  const db = openDatabase(scratch.url);
  let composition: Awaited<ReturnType<typeof createProductionComposition>> | null = null;
  try {
    await migrateEmptyDatabase(db);
    composition = await createProductionComposition({ database_url: scratch.url, host: "127.0.0.1", timing: { wake_timeout_seconds: 1 } });
    const app = composition.app;
    const empty = { definitions: await (await app.request("/api/definitions")).json(), runs: await (await app.request("/api/runs")).json() };
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
      attention: inspect?.attention.map((item) => [item.worker, item.detail]), writers: writers.map((row) => row.writer.kind) })
      .toEqual({ empty: { definitions: { items: [], next_cursor: null }, runs: { items: [], next_cursor: null } }, pinned: 201, launched: 201,
        replay: [200, true], conflict: 409, invalid: [400, 400, 400, 400], runs: [created.run_id],
        attention: [["writer", "the executor's agent and code worker paths are not ported to effect instructions yet"]], writers: ["operator", "executor"] });
  } finally {
    if (composition) await composition.close();
    await db.destroy();
    await scratch.drop();
  }
}, 30_000);
