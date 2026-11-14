import { expect, test } from "bun:test";
import { canonicalDigest } from "canonical-json";
import { sql } from "kysely";
import { createApp } from "../src/http/app";
import { decodeCapture } from "../src/ingest/capture";
import type { SourceEventDelivery } from "../src/ingest/cursor";
import { startObservation } from "../src/main";
import { oakridgeProfile, fixtureDefinitions, createFeed, credentialEnv, databaseUrl, fixtureBody, integration, revisionOutcome, scratchDatabase, tenant } from "./grading-fixture";
import { withTenant, type Database } from "../src/storage/database";
import { CaptureArtifactSource } from "../src/storage/capture-artifact-source";
import { readCapturedRunInput } from "../src/storage/run-capture-store";

const credentials = { ingest: [{ ...tenant, token: "ingest-secret" }], read: [{ ...tenant, token: "read-secret" }] };
const auth = { authorization: "Bearer ingest-secret", "content-type": "application/json" };
const first = { commit_txid: "1", id: "event:rev-1" };
const initial = { commit_txid: "0", id: "" };
const delivery = (body = { z: 1, a: ["x"] }): SourceEventDelivery => ({ previous: initial, cursor: first,
  outcome: revisionOutcome({ revision_id: "rev-1", artifact_kind: "build_result", body }) });
const post = (app: ReturnType<typeof createApp>, input: unknown) => app.request("/v1/sources/oakridge/events",
  { method: "POST", headers: auth, body: JSON.stringify(input) });
const revisionCount = (db: Database) => withTenant(db, tenant, async (trx) =>
  (await sql<{ count: number }>`SELECT count(*)::integer AS count FROM observation.source_revision`.execute(trx)).rows[0]?.count);

test("a capture's body digest and tenant prefix are checked before storage", () => {
  const outcome = revisionOutcome({ revision_id: "rev-1", artifact_kind: "build_result", body: { value: 1 } });
  if (outcome.kind !== "artifact_revision") throw new Error("fixture is a revision");
  expect(decodeCapture(outcome.revision).ok).toBe(true);
  expect(decodeCapture({ ...outcome.revision, body: { value: 2 } })).toMatchObject({ ok: false, error: { entity_id: "body_digest" } });
  expect(decodeCapture({ ...outcome.revision, source: { ...outcome.revision.source, revision_id: "other:space:rev-1" } }))
    .toMatchObject({ ok: false, error: { entity_id: "source.revision_id" } });
});

integration("an ordered delivery captures its revision and reads back its provenance", async () => scratchDatabase(async (db) => {
  const app = createApp({ db, credentials, profile: oakridgeProfile });
  const accepted = await post(app, delivery());
  expect({ status: accepted.status, body: await accepted.json() }).toEqual({ status: 200, body: { cursor: first } });
  const read = await app.request(`/v1/source-revisions/oakridge:${tenant.namespace}:rev-1`, { headers: { authorization: "Bearer read-secret" } });
  const revision = await read.json() as { readonly body: unknown; readonly body_digest: string };
  expect(revision).toMatchObject({ id: `oakridge:${tenant.namespace}:rev-1`, producer: "oakridge", namespace: tenant.namespace,
    run_id: "run-1", unit_id: "build_result", stage: "build_result", artifact_kind: "build_result", definition_id: "definition-1", body: { z: 1, a: ["x"] } });
  const rehashed = canonicalDigest(revision.body);
  expect(rehashed.ok && String(rehashed.value)).toBe(revision.body_digest);
}));

integration("a replayed delivery is refused at the cursor and stores nothing twice", async () => scratchDatabase(async (db) => {
  const app = createApp({ db, credentials, profile: oakridgeProfile });
  await post(app, delivery());
  const replay = await post(app, delivery());
  expect({ status: replay.status, body: await replay.json() }).toEqual({ status: 409, body: { error: { code: "cursor_conflict", cursor: first } } });
  expect(await revisionCount(db)).toBe(1);
}));

integration("a revision id keeps one body: a repeat is harmless, a different body holds the feed", async () => scratchDatabase(async (db) => {
  const feed = createFeed(db);
  const body = await fixtureBody("build-result");
  await feed.revision({ revision_id: "rev-1", artifact_kind: "build_result", body });
  await feed.send(revisionOutcome({ revision_id: "rev-1", artifact_kind: "build_result", body }, tenant, "event:repeat"));
  expect(await revisionCount(db)).toBe(1);
  await expect(feed.send(revisionOutcome({ revision_id: "rev-1", artifact_kind: "build_result", body: { changed: true } }, tenant, "event:conflict")))
    .rejects.toThrow("cursor_conflict");
  const stored = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.source_event_cursor").select("event_id").executeTakeFirstOrThrow());
  expect(stored.event_id).toBe("event:repeat");
}));

integration("a revision outside the credential's tenant is refused", async () => scratchDatabase(async (db) => {
  const app = createApp({ db, credentials, profile: oakridgeProfile });
  const foreign = revisionOutcome({ revision_id: "rev-1", artifact_kind: "build_result", body: { value: 1 } }, { producer: "oakridge", namespace: "other" }, first.id);
  const response = await post(app, { previous: initial, cursor: first, outcome: foreign });
  expect(response.status).toBe(403);
  expect(await revisionCount(db)).toBe(0);
}));

integration("the captured launch input is the durable run input", async () => scratchDatabase(async (db) => {
  const feed = createFeed(db);
  await feed.launch({ title: "Run", spec: "The whole spec", repositories: [] });
  await feed.launch({ title: "Other", spec: "Another spec", repositories: [] }, "run-2");
  expect(await readCapturedRunInput(db, tenant, "run-1")).toEqual({ title: "Run", spec: "The whole spec", repositories: [] });
  expect(await readCapturedRunInput(db, tenant, "run-2")).toMatchObject({ spec: "Another spec" });
  expect(await readCapturedRunInput(db, tenant, "run-3")).toBeNull();
  expect(await readCapturedRunInput(db, { ...tenant, namespace: "other" }, "run-1")).toBeNull();
}));

integration("the service starts on a fresh database and stops cleanly", async () => scratchDatabase(async (db) => {
  const service = await startObservation({ ...credentialEnv(await fixtureDefinitions()), OBSERVATION_DATABASE_URL: await databaseUrl(db), OBSERVATION_PORT: "0", OBSERVATION_GRADING_CONFIG_DIR: `/tmp/observation-empty-${crypto.randomUUID()}`,
    OBSERVATION_INGEST_CREDENTIALS: JSON.stringify(credentials.ingest), OBSERVATION_READ_CREDENTIALS: JSON.stringify(credentials.read) });
  try {
    const cursor = await fetch(`http://127.0.0.1:${service.port}/v1/sources/oakridge/cursor`, { headers: { authorization: "Bearer ingest-secret" } });
    expect(await cursor.json()).toEqual({ cursor: initial });
  } finally { await service.stop(); }
}));


test("capture accepts only v3 and requires a nonempty publishing stage", () => {
  const outcome = revisionOutcome({ revision_id: "rev-1", artifact_kind: "build_result", body: {} });
  if (outcome.kind !== "artifact_revision") throw new Error("fixture is a revision");
  expect(decodeCapture(outcome.revision).ok).toBe(true);
  expect(decodeCapture({ ...outcome.revision, format: "observation.artifact-revision/v2" }))
    .toMatchObject({ ok: false, error: { entity_id: "envelope" } });
  for (const stage of [undefined, ""]) {
    expect(decodeCapture({ ...outcome.revision, source: { ...outcome.revision.source, stage } }))
      .toMatchObject({ ok: false, error: { entity_id: "source.stage" } });
  }
});

integration("captured revision readers retain the publishing stage and reject a changed stage", async () => scratchDatabase(async (db) => {
  const feed = createFeed(db);
  const body = await fixtureBody("build-result");
  await feed.revision({ revision_id: "rev-1", artifact_kind: "build_result", stage: "custom-stage", body });
  const sources = new CaptureArtifactSource({ db, tenant, run_id: "run-1", collector: oakridgeProfile.evidence,
    repository: { hasCommit: async () => false, readFile: async () => ({ state: "absent" }) } });
  expect(await sources.readRevision("rev-1")).toMatchObject({ stage: "custom-stage" });
  expect(await sources.readRevisionAt("build_result", "rev-1" as import("../src/domain/identity").ArtifactRevisionId))
    .toMatchObject({ stage: "custom-stage" });
  await expect(feed.send(revisionOutcome({ revision_id: "rev-1", artifact_kind: "build_result", stage: "different", body }, tenant, "event:changed-stage")))
    .rejects.toThrow("cursor_conflict");
}));

test("v4 validates recorded revision references while v3 always reads null provenance", () => {
  const outcome = revisionOutcome({ revision_id: "assessment", artifact_kind: "assessment", body: { findings: [] } });
  if (outcome.kind !== "artifact_revision") throw new Error("fixture");
  const source = { ...outcome.revision.source, brief_revision_ids: ["oakridge:grading-test:brief-1"] };
  const current = decodeCapture({ ...outcome.revision, format: "observation.artifact-revision/v4", source });
  expect(current.ok && current.value.envelope.source.brief_revision_ids).toEqual(source.brief_revision_ids);
  const legacy = decodeCapture({ ...outcome.revision, source });
  expect(legacy.ok && legacy.value.envelope.source.brief_revision_ids).toBeNull();
  expect(decodeCapture({ ...outcome.revision, format: "observation.artifact-revision/v4", source: { ...source, brief_revision_ids: ["oakridge:other:brief"] } }).ok).toBe(false);
  const absent = decodeCapture({ ...outcome.revision, format: "observation.artifact-revision/v4", source: { ...source, brief_revision_ids: null } });
  expect(absent.ok && absent.value.envelope.source.brief_revision_ids).toBeNull();
});
