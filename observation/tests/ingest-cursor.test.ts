import { sql } from "kysely";
import { deliverSourceEvent, readSourceCursor } from "../src/storage/capture-store";
import { readRunWorkflowStages } from "../src/storage/run-capture-store";
import { NO_CAPTURE_PINS } from "../src/grading/evidence";
import { expect, test } from "bun:test";
import { Client } from "pg";
import { createApp } from "../src/http/app";
import { oakridgeProfile } from "./grading-fixture";
import { decodeSourceEventDelivery, type SourceEventDelivery } from "../src/ingest/cursor";
import { openDatabase, withTenant } from "../src/storage/database";
import { migrateEmptyDatabase } from "../src/storage/migrate";
import { dropScratchDatabase } from "./database-fixture";

const serverUrl = process.env.OAKRIDGE_TEST_DATABASE_URL;
const integration = serverUrl || process.env.CI === "true" ? test : test.skip;
const tenant = { producer: "oakridge", namespace: "cursor-test" };
const credentials = { ingest: [{ ...tenant, token: "ingest-secret" }], read: [{ ...tenant, token: "read-secret" }] };

test("the cursor decoder rejects an outcome that names a different event", () => {
  expect(decodeSourceEventDelivery({ previous: { commit_txid: "0", id: "" }, cursor: { commit_txid: "1", id: "event-1" },
    outcome: { format: "observation.source-event/v2", definition_id: null, artifact_schema_version: null,
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
      const app = createApp({ db, credentials, profile: oakridgeProfile });
      const auth = { authorization: "Bearer ingest-secret" };
      const first = await app.request("/v1/sources/oakridge/cursor", { headers: auth });
      expect(await first.json()).toEqual({ cursor: { commit_txid: "0", id: "" } });
      const delivery = { previous: { commit_txid: "0", id: "" }, cursor: { commit_txid: "20", id: "event-1" },
        outcome: { format: "observation.source-event/v2", definition_id: null, artifact_schema_version: null,
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
        cursor: { cursor: delivery.cursor }, unmapped: { items: [delivery.outcome], total: 1, limit: 50, offset: 0 }, stored: ["event-1"] });
    } finally { await db.destroy(); await dropScratchDatabase(admin, name); }
  } finally { await admin.end(); }
});


const launchDelivery: SourceEventDelivery = {
  previous: { commit_txid: "0", id: "" }, cursor: { commit_txid: "1", id: "launch" },
  outcome: { format: "observation.source-event/v2", definition_id: "definition-1", artifact_schema_version: null,
    kind: "run_input", event_kind: "launched", run_id: "run-1", event_id: "launch", input: {}, input_schema_version: "schema-1", config: null,
    stages: [{ stage: "10", artifact_kinds: ["second", "first"] }, { stage: "2", artifact_kinds: [] }] },
};
test("source events accept only v2 and require valid ordered launch metadata", () => {
  expect(decodeSourceEventDelivery(launchDelivery)).toEqual(launchDelivery);
  expect(decodeSourceEventDelivery({ ...launchDelivery, outcome: { ...launchDelivery.outcome,
    format: "observation.source-event/v1" } })).toBeNull();
});
for (const stages of [undefined, null, {}, [{ stage: "", artifact_kinds: [] }], [{ stage: "one" }],
  [{ stage: "one", artifact_kinds: [""] }], [{ stage: "one", artifact_kinds: [1] }],
  [{ stage: "one", artifact_kinds: [] }, { stage: "one", artifact_kinds: [] }]]) {
  test(`launch rejects malformed stages ${JSON.stringify(stages)}`, () => {
    expect(decodeSourceEventDelivery({ ...launchDelivery, outcome: { ...launchDelivery.outcome, stages } })).toBeNull();
  });
}
async function withStageDatabase(work: (db: ReturnType<typeof openDatabase>) => Promise<void>): Promise<void> {
  if (!serverUrl) throw new Error("OAKRIDGE_TEST_DATABASE_URL is required");
  const admin = new Client({ connectionString: serverUrl });
  const name = `observation_stages_${crypto.randomUUID().replaceAll("-", "")}`;
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(serverUrl); url.pathname = `/${name}`;
    const db = openDatabase(url.href);
    try { await migrateEmptyDatabase(db); await work(db); }
    finally { await db.destroy(); await dropScratchDatabase(admin, name); }
  } finally { await admin.end(); }
}

integration("launch stages are ordered, tenant scoped and absent until launch capture", () => withStageDatabase(async (db) => {
  expect(await readRunWorkflowStages(db, tenant, "run-1")).toEqual([]);
  expect((await deliverSourceEvent(db, tenant, launchDelivery, { extraction: oakridgeProfile.extraction, configuration: NO_CAPTURE_PINS })).status).toBe(200);
  expect(await readRunWorkflowStages(db, tenant, "run-1")).toEqual([
    { position: 0, stage: "10", artifact_kinds: ["second", "first"] }, { position: 1, stage: "2", artifact_kinds: [] }]);
  expect(await readRunWorkflowStages(db, { ...tenant, namespace: "other" }, "run-1")).toEqual([]);
  expect(await readRunWorkflowStages(db, { ...tenant, producer: "other" }, "run-1")).toEqual([]);
  expect(await readRunWorkflowStages(db, tenant, "missing")).toEqual([]);
  expect((await deliverSourceEvent(db, tenant, launchDelivery, { extraction: oakridgeProfile.extraction, configuration: NO_CAPTURE_PINS })).status).toBe(409);
  expect(await readRunWorkflowStages(db, tenant, "run-1")).toHaveLength(2);
}));

integration("duplicate launch stage names roll back stages, outcome and cursor together", () => withStageDatabase(async (db) => {
  if (launchDelivery.outcome.kind !== "run_input") throw new Error("expected launch");
  const duplicate: SourceEventDelivery = { ...launchDelivery, outcome: { ...launchDelivery.outcome,
    stages: [{ stage: "one", artifact_kinds: [] }, { stage: "one", artifact_kinds: ["draft"] }] } };
  await expect(deliverSourceEvent(db, tenant, duplicate, { extraction: oakridgeProfile.extraction, configuration: NO_CAPTURE_PINS })).rejects.toThrow("unique constraint");
  expect(await readRunWorkflowStages(db, tenant, "run-1")).toEqual([]);
  expect(await readSourceCursor(db, tenant)).toEqual({ cursor: launchDelivery.previous });
  expect(await withTenant(db, tenant, (trx) => trx.selectFrom("observation.source_event_outcome").selectAll().execute())).toEqual([]);
  expect((await deliverSourceEvent(db, tenant, launchDelivery, { extraction: oakridgeProfile.extraction, configuration: NO_CAPTURE_PINS })).status).toBe(200);
}));

integration("workflow stages reject duplicate positions, updates and deletes", () => withStageDatabase(async (db) => {
  await deliverSourceEvent(db, tenant, launchDelivery, { extraction: oakridgeProfile.extraction, configuration: NO_CAPTURE_PINS });
  await expect(withTenant(db, tenant, (trx) => trx.insertInto("observation.run_workflow_stage").values({ ...tenant,
    run_id: "run-1", position: 0, stage: "other", artifact_kinds: [] }).execute())).rejects.toThrow("unique constraint");
  await expect(withTenant(db, tenant, (trx) => trx.insertInto("observation.run_workflow_stage").values({ ...tenant,
    run_id: "run-1", position: 2, stage: "", artifact_kinds: [] }).execute())).rejects.toThrow("check constraint");
  await expect(withTenant(db, tenant, (trx) => sql`UPDATE observation.run_workflow_stage SET stage = 'changed'`.execute(trx)))
    .rejects.toThrow("append-only");
  await expect(withTenant(db, tenant, (trx) => sql`DELETE FROM observation.run_workflow_stage`.execute(trx)))
    .rejects.toThrow("append-only");
}));
