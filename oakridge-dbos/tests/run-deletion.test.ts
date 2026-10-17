import { afterAll, beforeAll, expect, test } from "bun:test";
import type { DefinitionBundleId, RunId } from "../src/domain/primitives";
import { listOwedIntents, settleIntent } from "../src/storage/executor-store";
import { deleteRun, deletionEligibility } from "../src/storage/run-deletion";
import { launch, openAuthority, pinSample, submitter, type Authority } from "./authority-fixture";

let authority: Authority;
let bundle_id: DefinitionBundleId;
beforeAll(async () => {
  authority = await openAuthority();
  ({ bundle_id } = await pinSample(authority));
});
afterAll(async () => { await authority.close(); });

async function launched(): Promise<RunId> {
  const { run_id } = await launch(authority, { bundle_id, request_id: crypto.randomUUID(), input: { topic: "Oakridge" } });
  return run_id;
}

test("deletion is refused while an intent may own an external execution", async () => {
  const run_id = await launched();
  const eligibility = await authority.db.transaction().execute((trx) => deletionEligibility(trx, run_id));
  expect([eligibility, await deleteRun(authority.db, run_id)]).toEqual([{ kind: "refused", obligations: 1 }, { kind: "refused", obligations: 1 }]);
});

test("a run whose intents are settled is deleted with every row, and the stream keeps its events without a run", async () => {
  const run_id = await launched();
  await submitter(authority)({ run_id, event: { kind: "cancel_requested" } });
  for (const intent of await listOwedIntents(authority.db, run_id)) await settleIntent(authority.db, { intent_id: intent.id, status: "stopped", last_error: null });
  const deleted = await deleteRun(authority.db, run_id);
  const [runs, units, events, stream] = await Promise.all([
    authority.db.selectFrom("authority.run").select("id").where("id", "=", run_id).execute(),
    authority.db.selectFrom("authority.unit").select("id").where("run_id", "=", run_id).execute(),
    authority.db.selectFrom("authority.event").select("id").where("run_id", "=", run_id).execute(),
    authority.db.selectFrom("authority.operator_event").select(["run_id", "payload"]).where("run_key", "=", run_id).orderBy("commit_txid").orderBy("id").execute(),
  ]);
  expect({ deleted, rows: runs.length + units.length + events.length, stream: stream.map((row) => [row.run_id, row.payload.kind]).at(-1),
    has_run_reference: stream.some((row) => row.run_id !== null) })
    .toEqual({ deleted: { kind: "deleted" }, rows: 0, stream: [null, "invalidate"], has_run_reference: false });
});

test("deleting a run that does not exist reports it missing", async () => {
  expect(await deleteRun(authority.db, "run-missing" as RunId)).toEqual({ kind: "missing" });
});
