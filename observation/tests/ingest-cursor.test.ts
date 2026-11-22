import { expect, test } from "bun:test";
import { decodeRevisionDelivery } from "../src/ingest/capture";
import { readSourceCursor } from "../src/storage/capture-store";
import { withTenant } from "../src/storage/database";
import { createFeed, fixtureDelivery, integration, scratchDatabase, tenant } from "./grading-fixture";

const empty = { event_id: "empty", run_id: "run-1", event: { kind: "revisions" as const, revisions: [] } };
test("source event cursor requires the delivered id and a decimal transaction id", () => {
  const delivery = fixtureDelivery(tenant, empty);
  expect(decodeRevisionDelivery(delivery).ok).toBe(true);
  for (const cursor of [{ commit_txid: "1.5", event_id: "empty" }, { commit_txid: "1", event_id: "different" }])
    expect(decodeRevisionDelivery({ ...delivery, cursor }).ok).toBe(false);
});

integration("events without captures advance the durable cursor and journal exactly one outcome each", async () => scratchDatabase(async (db) => {
  const feed = createFeed(db);
  expect(await feed.send(empty)).toEqual({ commit_txid: "1", event_id: "empty" });
  const added = await feed.decide("operator_decided");
  expect((await readSourceCursor(db, tenant)).cursor).toEqual(added);
  const outcomes = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.source_event_outcome")
    .select("outcome_kind").orderBy("commit_txid").execute());
  expect(outcomes.map((outcome) => outcome.outcome_kind)).toEqual(["revisions", "other"]);
}));
