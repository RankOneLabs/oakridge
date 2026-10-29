import { expect, test } from "bun:test";
import { Client } from "pg";
import { createApp } from "../src/http/app";
import { decodeSourceEventDelivery } from "../src/ingest/cursor";
import { openDatabase, withTenant } from "../src/storage/database";
import { migrateEmptyDatabase } from "../src/storage/migrate";
import { dropScratchDatabase } from "./database-fixture";

const serverUrl = process.env.OAKRIDGE_TEST_DATABASE_URL;
const integration = serverUrl || process.env.CI === "true" ? test : test.skip;
const tenant = { producer: "oakridge", namespace: "cursor-test" };
const credentials = { ingest: [{ ...tenant, token: "ingest-secret" }], read: [{ ...tenant, token: "read-secret" }] };

test("the cursor decoder rejects an outcome that names a different event", () => {
  expect(decodeSourceEventDelivery({ previous: { commit_txid: "0", id: "" }, cursor: { commit_txid: "1", id: "event-1" },
    outcome: { format: "observation.source-event/v1", definition_bundle: null, artifact_schema_version: null,
      kind: "unmapped", event_kind: "future", run_id: "run-1", event_id: "event-2", reason: "unknown" } })).toBeNull();
});

integration("acknowledgement commits outcome and cursor together; stale delivery cannot advance", async () => {
  if (!serverUrl) throw new Error("OAKRIDGE_TEST_DATABASE_URL is required");
  const admin = new Client({ connectionString: serverUrl });
  const name = `observation_cursor_${crypto.randomUUID().replaceAll("-", "")}`;
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(serverUrl); url.pathname = `/${name}`;
    const db = openDatabase(url.href);
    try {
      await migrateEmptyDatabase(db);
      const app = createApp({ db, credentials });
      const auth = { authorization: "Bearer ingest-secret" };
      const first = await app.request("/v1/sources/oakridge/cursor", { headers: auth });
      expect(await first.json()).toEqual({ cursor: { commit_txid: "0", id: "" } });
      const delivery = { previous: { commit_txid: "0", id: "" }, cursor: { commit_txid: "20", id: "event-1" },
        outcome: { format: "observation.source-event/v1", definition_bundle: null, artifact_schema_version: null,
          kind: "unmapped", event_kind: "future", run_id: "run-1", event_id: "event-1", reason: "unknown variant" } };
      const send = () => app.request("/v1/sources/oakridge/events", { method: "POST", headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify(delivery) });
      const accepted = await send();
      expect({ status: accepted.status, body: await accepted.json() }).toEqual({ status: 200, body: { cursor: delivery.cursor } });
      expect((await send()).status).toBe(409);
      const cursor = await app.request("/v1/sources/oakridge/cursor", { headers: auth });
      const unmapped = await app.request("/v1/sources/oakridge/unmapped", { headers: { authorization: "Bearer read-secret" } });
      const stored = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.source_event_outcome").select("event_id").execute());
      expect({ cursor: await cursor.json(), unmapped: await unmapped.json(), stored: stored.map((row) => row.event_id) }).toEqual({
        cursor: { cursor: delivery.cursor }, unmapped: { items: [delivery.outcome] }, stored: ["event-1"] });
    } finally { await db.destroy(); await dropScratchDatabase(admin, name); }
  } finally { await admin.end(); }
});
