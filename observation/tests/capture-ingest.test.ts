import { expect, test } from "bun:test";
import { createApp } from "../src/http/app";
import { decodeRevisionDelivery, selectCaptures } from "../src/ingest/capture";
import { withTenant } from "../src/storage/database";
import { createFeed, fixtureDelivery, integration, revisionOutcome, scratchDatabase, tenant, oakridgeProfile } from "./grading-fixture";

const revision = { revision_id: "run/a:spec:3", predecessor_id: "run/a:spec:2", subject_id: "run/a:draft:7",
  artifact_kind: "spec", body: { requirements: [] }, input_bindings: [{ input: "$subject", unit: "run/a", revision_id: "run/a:draft:7" }] };
const delivery = fixtureDelivery(tenant, revisionOutcome(revision));
const credentials = { ingest: [{ ...tenant, token: "ingest" }], read: [{ ...tenant, token: "read" }] };

test("the decoder verifies revision body digests and event identity", () => {
  const decoded = decodeRevisionDelivery(delivery);
  expect(decoded.ok && selectCaptures(decoded.value)[0]).toMatchObject({ revision_id: revision.revision_id });
  const event = delivery.event;
  if (event.kind !== "revisions") throw new Error("expected revision event");
  expect(decodeRevisionDelivery({ ...delivery, event: { ...event, revisions: [{ ...event.revisions[0], body: "tampered" }] } }).ok).toBe(false);
  expect(decodeRevisionDelivery({ ...delivery, event_id: "another-event" }).ok).toBe(false);
});

integration("storage and the read API preserve all three DBOS revision ids byte for byte", async () => scratchDatabase(async (db) => {
  const app = createApp({ db, profile: oakridgeProfile, credentials });
  const response = await app.request("/v1/sources/oakridge/events", { method: "POST",
    headers: { authorization: "Bearer ingest", "content-type": "application/json" }, body: JSON.stringify(delivery) });
  expect(response.status).toBe(200);
  const stored = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.source_revision").selectAll().executeTakeFirstOrThrow());
  const result = await app.request(`/v1/source-revisions/${encodeURIComponent(revision.revision_id)}`, { headers: { authorization: "Bearer read" } });
  expect(result.status).toBe(200);
  const expected = { ...tenant, revision_id: revision.revision_id, predecessor_id: revision.predecessor_id,
    subject_id: revision.subject_id, input_bindings: revision.input_bindings, origin: { kind: "operator_edit" } };
  expect(stored).toMatchObject(expected);
  expect(await result.json()).toMatchObject(expected);
}));

integration("a revision's bindings are immutable across repeated deliveries", async () => scratchDatabase(async (db) => {
  const feed = createFeed(db);
  await feed.revision(revision);
  await feed.send(revisionOutcome(revision, "same"));
  await expect(feed.send(revisionOutcome({ ...revision, input_bindings: [] }, "changed"))).rejects.toThrow("cursor_conflict");
  const row = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.source_revision").select("input_bindings").executeTakeFirstOrThrow());
  expect(row.input_bindings).toEqual(revision.input_bindings);
}));
