import { expect, test } from "bun:test";
import { claimStart, listOwedIntents } from "../src/storage/executor-store";
import { ensureKeyedExecution } from "../src/storage/keyed-execution-store";
import { openAuthority } from "./authority-fixture";
import { openStudy, prepareSlice } from "./study-fixture";

test("one execution key per approved revision and reconciliation pauses starts", async () => {
  const authority = await openAuthority();
  try {
    const run = await openStudy(authority);
    const spend = await prepareSlice(run);
    await run.end("spend_requester");
    expect((await run.decide("spend_request_review", "approve", "spend_request")).status).toBe(201);
    const runner = await run.startRunner();
    const owner = { run_id: run.run_id, unit_id: run.unit(), authorizing_revision_id: spend.id, worker: "slice_runner" };
    const key = await authority.db.transaction().execute((trx) => ensureKeyedExecution(trx, owner));
    expect(key).toBe(runner.key);
    const claim = () => run.request("POST", `/executions/${key}/claim`, { request_id: crypto.randomUUID() }, runner.secret).then((r) => r.json());
    expect(await claim()).toEqual({ kind: "launch" });
    expect(await claim()).toEqual({ kind: "reconcile_required" });
    expect(await authority.db.selectFrom("authority.keyed_execution").select(["id", "state", "claim_count"]).execute())
      .toEqual([{ id: key, state: "reconcile", claim_count: 1 }]);
    expect(await claimStart(authority.db, { intent_id: runner.intent.id, max_tries: 3 })).toMatchObject({ kind: "not_pending" });
    expect(await listOwedIntents(authority.db, run.run_id)).not.toContainEqual({ id: runner.intent.id, status: "pending" });
    expect(await (await run.request("GET", "")).json()).toMatchObject({ awaiting_execution_reconciliation: [{ id: key, worker: "slice_runner" }] });
  } finally {
    await authority.close();
  }
});
