import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "kysely";
import type { CoreClient } from "../src/core-client/client";
import type { DefinitionBundleId, RunId } from "../src/domain/primitives";
import { commitEvent } from "../src/storage/commit";
import { listRuns } from "../src/storage/read-store";
import { launch, openAuthority, pinSample, type Authority } from "./authority-fixture";

let authority: Authority;
let bundle_id: DefinitionBundleId;
beforeAll(async () => {
  authority = await openAuthority();
  ({ bundle_id } = await pinSample(authority));
});
afterAll(async () => { await authority.close(); });

async function launched(): Promise<RunId> {
  const { run_id, result } = await launch(authority, { bundle_id, request_id: crypto.randomUUID(), input: { topic: "Oakridge" } });
  if (!result.ok || result.value.kind !== "committed") throw new Error("launch failed");
  return run_id;
}
const counts = async (run_id: string) => {
  const [run, events, units, receipts] = await Promise.all([
    authority.db.selectFrom("authority.run").select(["version", "status", "root_unit_id"]).where("id", "=", run_id).executeTakeFirst(),
    authority.db.selectFrom("authority.event").select("id").where("run_id", "=", run_id).execute(),
    authority.db.selectFrom("authority.unit").select("id").where("run_id", "=", run_id).execute(),
    authority.db.selectFrom("authority.ingress_receipt").select("id").where("run_id", "=", run_id).execute(),
  ]);
  return { version: run?.version ?? null, status: run?.status.kind ?? null, events: events.length, units: units.length, receipts: receipts.length };
};

test("a fault on the receipt rolls back the event, writer, delta, intent stops and wanted log written before it", async () => {
  const run_id = await launched();
  const before = await counts(run_id);
  // The receipt follows the event, delta, intents and wanted log; failing it proves they share its transaction.
  await sql`CREATE FUNCTION authority.fail_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected receipt fault'; END $$`.execute(authority.db);
  await sql`CREATE TRIGGER fail_receipt BEFORE INSERT ON authority.ingress_receipt FOR EACH ROW WHEN (NEW.ingress_id = 'faulted-cancel') EXECUTE FUNCTION authority.fail_receipt()`.execute(authority.db);
  try {
    const result = await commitEvent({ db: authority.db, core: authority.core, wake: () => undefined }, { run_id, ingress_id: "faulted-cancel",
      event: { kind: "cancel_requested" }, writer: { kind: "operator", subject: "credential:test" } });
    const stops = await authority.db.selectFrom("authority.effect_intent").select("status").where("run_id", "=", run_id).execute();
    expect({ is_error: !result.ok, after: await counts(run_id), stops: stops.map((row) => row.status) })
      .toEqual({ is_error: true, after: before, stops: ["pending"] });
  } finally {
    await sql`DROP TRIGGER fail_receipt ON authority.ingress_receipt`.execute(authority.db);
    await sql`DROP FUNCTION authority.fail_receipt()`.execute(authority.db);
  }
});

test("a rejected launch stores its receipt and nothing else, and is not a run to the operator", async () => {
  const request_id = crypto.randomUUID();
  const { run_id, result } = await launch(authority, { bundle_id, request_id, input: { topic: 42 } });
  const runs = await listRuns(authority.db, { after: null, limit: 100, is_archived: false });
  expect({ kind: result.ok && result.value.kind, after: await counts(run_id), listed: runs.items.some((read) => read.run.id === run_id) })
    .toEqual({ kind: "rejected", after: { version: 0, status: "not_started", events: 0, units: 0, receipts: 1 }, listed: false });
});

test("a fault mid-write rolls back the event, writer, delta and receipt together", async () => {
  const run_id = await launched();
  const before = await authority.db.selectFrom("authority.run").select("version").where("id", "=", run_id).executeTakeFirstOrThrow();
  // A step result naming an attempt on a unit that does not exist fails its foreign key after the run row is updated.
  const faulty = { request: async (operation: "compile" | "step", input: never) => {
    const response = await authority.core.request(operation, input);
    if (!response.ok || response.value.kind !== "stepped") return response;
    const step = response.value.value;
    return { ok: true, value: { kind: "stepped", value: { ...step, snapshot: { ...step.snapshot, attempts: [...step.snapshot.attempts,
      { ...step.snapshot.attempts[0]!, action_id: "phantom", unit: `${run_id}/missing` }] } } } };
  } } as unknown as CoreClient;
  const ingress_id = crypto.randomUUID();
  const result = await commitEvent({ db: authority.db, core: faulty, wake: () => undefined }, { run_id, ingress_id,
    event: { kind: "cancel_requested" }, writer: { kind: "operator", subject: "credential:test" } });
  const [after, events, receipt] = await Promise.all([
    authority.db.selectFrom("authority.run").select(["version", "status"]).where("id", "=", run_id).executeTakeFirstOrThrow(),
    authority.db.selectFrom("authority.event").select("id").where("run_id", "=", run_id).execute(),
    authority.db.selectFrom("authority.ingress_receipt").select("id").where("ingress_id", "=", ingress_id).execute(),
  ]);
  expect({ is_error: !result.ok, version: after.version, status: after.status.kind, events: events.length, receipts: receipt.length })
    .toEqual({ is_error: true, version: before.version, status: "active", events: 1, receipts: 0 });
});

