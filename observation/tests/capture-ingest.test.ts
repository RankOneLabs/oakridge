import { expect, test } from "bun:test";
import { canonicalDigest } from "canonical-json";
import { decodeCapture, type CaptureDelivery, type CaptureEnvelope } from "../src/ingest/capture";
import { captureDelivery, readSourceRevision } from "../src/storage/capture-store";
import { withTenant } from "../src/storage/database";
import { scratchGrading, tenant } from "./grading-fixture";

function delivery(): CaptureDelivery {
  const digest = canonicalDigest({ text: "captured" });
  if (!digest.ok) throw new Error(digest.error.detail);
  return { request_key: "event-1", local_revision_id: "revision-1", envelope: {
    format: "observation.artifact-revision/v2", source: { ...tenant, revision_id: `oakridge:${tenant.namespace}:revision-1`,
      run_id: "run-1", unit_id: "analysis", artifact_kind: "analysis", artifact_schema_version: "fixture-v1",
      definition_id: "1".repeat(64), predecessor_id: null, subject_id: null },
    recorded_at: "2026-11-01T00:00:00Z", body: { text: "captured" }, body_digest: digest.value } };
}
test("redelivery with the same digest, predecessor and subject is a no-op", () => scratchGrading(async (db) => {
  const input = delivery();
  const first = await captureDelivery(db, input);
  const replay = await captureDelivery(db, { ...input, request_key: "another-event" });
  const revisions = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.source_revision")
    .select("revision_id").where("revision_id", "=", "revision-1").execute());
  expect({ first, replay, revisions }).toEqual({ first, replay: first, revisions: [{ revision_id: "revision-1" }] });
}));
for (const field of ["body", "predecessor_id", "subject_id"] as const) {
  test(`a different ${field} conflicts without changing the captured revision`, () => scratchGrading(async (db) => {
    const input = delivery();
    await captureDelivery(db, input);
    const digest = canonicalDigest("different");
    if (!digest.ok) throw new Error(digest.error.detail);
    const envelope: CaptureEnvelope = field === "body" ? { ...input.envelope, body: "different", body_digest: digest.value }
      : { ...input.envelope, source: { ...input.envelope.source, [field]: `oakridge:${tenant.namespace}:other` } };
    const conflict = await captureDelivery(db, { ...input, envelope });
    expect({ conflict, stored: await readSourceRevision(db, tenant, input.envelope.source.revision_id) }).toMatchObject({
      conflict: { status: 409, body: { error: { code: "revision_identity_conflict", stored_digest: input.envelope.body_digest } } },
      stored: { body: input.envelope.body, predecessor_id: null, subject_id: null },
    });
  }));
}
test("capture failure rolls back the revision before retry", () => scratchGrading(async (db) => {
  const input = delivery();
  await expect(captureDelivery(db, input, { afterMirror: async () => { throw new Error("injected crash"); } })).rejects.toThrow("injected crash");
  expect(await readSourceRevision(db, tenant, input.envelope.source.revision_id)).toBeNull();
  expect((await captureDelivery(db, input)).status).toBe(201);
}));
test("capture requires v2 provenance and a matching canonical digest", () => {
  const input = delivery();
  const invalid = [{ ...input.envelope, format: "observation.artifact-revision/v1" },
    { ...input.envelope, source: { ...input.envelope.source, definition_id: "" } },
    { ...input.envelope, source: { ...input.envelope.source, artifact_schema_version: "" } },
    { ...input.envelope, body: "different" }];
  expect([decodeCapture(input.envelope, "key").ok, ...invalid.map((value) => decodeCapture(value, "key").ok)])
    .toEqual([true, false, false, false, false]);
});

test("the ordered feed replays identical revisions and preserves revision_identity_conflict without advancing its cursor", () => scratchGrading(async (db) => {
  const { createApp } = await import("../src/http/app");
  const { readSourceCursor } = await import("../src/storage/capture-store");
  const app = createApp({ db, credentials: { ingest: [{ ...tenant, token: "ingest" }], read: [] } });
  const input = delivery();
  const send = async (index: number, revision: CaptureEnvelope) => app.request("/v1/sources/oakridge/events", { method: "POST",
    headers: { authorization: "Bearer ingest", "content-type": "application/json" },
    body: JSON.stringify({ previous: { commit_txid: String(index - 1), id: index === 1 ? "" : `event-${index - 1}` },
      cursor: { commit_txid: String(index), id: `event-${index}` }, outcome: { format: "observation.source-event/v1",
        definition_id: revision.source.definition_id, artifact_schema_version: revision.source.artifact_schema_version,
        kind: "artifact_revision", event_kind: "revision_published", run_id: revision.source.run_id, event_id: `event-${index}`, revision } }) });
  expect((await send(1, input.envelope)).status).toBe(200);
  expect((await send(2, input.envelope)).status).toBe(200);
  const conflicting = { ...input.envelope, source: { ...input.envelope.source, subject_id: `oakridge:${tenant.namespace}:different` } };
  const response = await send(3, conflicting);
  expect({ status: response.status, body: await response.json(), cursor: await readSourceCursor(db, tenant) })
    .toMatchObject({ status: 409, body: { error: { code: "revision_identity_conflict" } },
      cursor: { cursor: { commit_txid: "2", id: "event-2" } } });
  expect((await send(3, input.envelope)).status).toBe(200);
}));
