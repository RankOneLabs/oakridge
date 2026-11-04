import { expect, test } from "bun:test";
import { createApp } from "../src/http/app";
import { withTenant } from "../src/storage/database";
import { scratchGrading, tenant } from "./grading-fixture";
import { canonicalDigest } from "canonical-json";

const integration = process.env.OAKRIDGE_TEST_DATABASE_URL ? test : test.skip;
integration("unknown events cannot block later capture; launch metadata is distinct, auditable and idempotent", () => scratchGrading(async (db) => {
  const app = createApp({ db, credentials: { ingest: [{ ...tenant, token: "ingest" }], read: [{ ...tenant, token: "read" }] } });
  const headers = { authorization: "Bearer read" };
  const path = "/v1/runs/reviewed-run/grading-configuration";
  expect(await (await app.request(path, { headers })).json()).toEqual({ state: "unknown", grading_enabled: false, provenance: null });
  const provenance = { format: "observation.source-event/v1", definition_id: "def", artifact_schema_version: "1", run_id: "reviewed-run" };
  let previous = { commit_txid: "0", id: "" };
  const send = async (event_id: string, outcome: object) => {
    const cursor = { commit_txid: String(Number(previous.commit_txid) + 1), id: event_id };
    const delivery = { previous, cursor, outcome: { ...provenance, event_id, ...outcome } };
    const response = await app.request("/v1/sources/oakridge/events", { method: "POST", headers: { authorization: "Bearer ingest" },
      body: JSON.stringify(delivery) });
    expect(response.status).toBe(200);
    previous = cursor;
    return delivery;
  };
  await send("future", { kind: "producer_future", event_kind: "future" });
  const body = { findings: [{ id: "f", description: "finding", severity: "info" }], requirements: [], spec_updates: [] };
  const digest = canonicalDigest(body); if (!digest.ok) throw new Error(digest.error.detail);
  await send("revision", { kind: "artifact_revision", event_kind: "revision_published", revision: {
    format: "observation.artifact-revision/v2", source: { ...tenant, definition_id: "def", artifact_schema_version: "1",
      run_id: "reviewed-run", revision_id: `${tenant.producer}:${tenant.namespace}:reviewed-revision`, unit_id: "analysis", artifact_kind: "analysis",
      predecessor_id: null, subject_id: null }, body, body_digest: digest.value, recorded_at: "2026-11-01T00:00:00Z",
  } });
  const metadata = await send("metadata", { kind: "run_metadata", event_kind: "launched", metadata_version: "producer/v1", grading_settings: { grading_enabled: false } });
  const replay = await app.request("/v1/sources/oakridge/events", { method: "POST", headers: { authorization: "Bearer ingest" }, body: JSON.stringify(metadata) });
  expect(replay.status).toBe(409); // The ordered delivery protocol reports its already advanced cursor.
  expect(await (await app.request(path, { headers })).json()).toMatchObject({ state: "declared", grading_enabled: false,
    provenance: { metadata_version: "producer/v1", cursor: metadata.cursor, event_id: "metadata" } });
  expect(await withTenant(db, tenant, (trx) => trx.selectFrom("observation.run_metadata").selectAll().execute())).toHaveLength(1);
  expect(await (await app.request("/v1/sources/oakridge/unmapped", { headers })).json()).toMatchObject({ items: [{ kind: "unmapped", reason: "producer_future" }] });
  expect(await withTenant(db, tenant, (trx) => trx.selectFrom("observation.item_occurrence").selectAll().where("run_id", "=", "reviewed-run").execute())).toHaveLength(1);
  await send("metadata-later", { kind: "run_metadata", event_kind: "launched", metadata_version: "producer/v1", grading_settings: { grading_enabled: true } });
  expect(await (await app.request(path, { headers })).json()).toMatchObject({ state: "declared", grading_enabled: true });
}));
