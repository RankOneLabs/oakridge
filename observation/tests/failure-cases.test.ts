import { decodeCapture } from "../src/ingest/capture";
import { captureDelivery } from "../src/storage/capture-store";
import type { CaptureEnvelope } from "../src/ingest/capture";
import { randomBytes } from "node:crypto";
import { expect, test } from "bun:test";
import { Client } from "pg";
import { canonicalDigest } from "canonical-json";
import type { JsonValue } from "../src/domain/primitives";
import { createApp } from "../src/http/app";
import { openDatabase, withTenant, type Database } from "../src/storage/database";
import { migrateEmptyDatabase } from "../src/storage/migrate";
import { projectRevision, listRunItems, readLineage } from "../src/storage/projection-store";
import { dropScratchDatabase } from "./database-fixture";

const serverUrl = process.env.OAKRIDGE_TEST_DATABASE_URL;
const integration = serverUrl ? test : test.skip;
test("failure cases require OAKRIDGE_TEST_DATABASE_URL", () => {
  expect(serverUrl).toBeTruthy();
});
const tenant = { producer: "oakridge", namespace: "failure-cases" };
const run_id = "run-failure-fixtures";
const credentials = { ingest: [{ ...tenant, token: "ingest-fixture" }], read: [{ ...tenant, token: "read-fixture" }] };
const source = await Bun.file(new URL("../fixtures/oakridge/run-slice/events.json", import.meta.url)).json() as { definition_id: string; captures: CaptureEnvelope[] };
const schemaVersion = (kind: string): string => source.captures.find((capture) => capture.source.artifact_kind === kind)!.source.artifact_schema_version;
const fixture = async (name: string): Promise<JsonValue> => Bun.file(new URL(`../fixtures/oakridge/run-slice/${name}-revision.json`, import.meta.url)).json() as Promise<JsonValue>;
interface PlanCriterion { id: string; text: string; task_ids: string[]; decision_ids: string[] }
interface PlanBody { summary: string; cohorts: { acceptance_criteria: PlanCriterion[] }[] }
interface FailureCases {
  readonly duplicate_item: { readonly id: string; readonly text: string };
  readonly reordered_criterion_ids: readonly string[];
  readonly revision_update: { readonly id: string; readonly text: string };
  readonly missing_source_ref: string;
  readonly conflicting_duplicate: { readonly revision_id: string; readonly summary: string };
  readonly repeated_delivery: { readonly event_id: string };
}
const failureCases = async (): Promise<FailureCases> => (await Bun.file(new URL(
  "../fixtures/oakridge/run-slice/events.json", import.meta.url)).json() as { failure_cases: FailureCases }).failure_cases;
const digest = (body: JsonValue) => {
  const result = canonicalDigest(body);
  if (!result.ok) throw new Error(result.error.detail);
  return result.value;
};
async function scratch(work: (db: Database) => Promise<void>): Promise<void> {
  if (!serverUrl) throw new Error("OAKRIDGE_TEST_DATABASE_URL is required");
  const name = `observation_failures_${randomBytes(6).toString("hex")}`;
  const admin = new Client({ connectionString: serverUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(serverUrl); url.pathname = `/${name}`;
    const db = openDatabase(url.href);
    try { await migrateEmptyDatabase(db); await work(db); }
    finally { await db.destroy(); await dropScratchDatabase(admin, name); }
  } finally { await admin.end(); }
}
async function ingest(db: Database, kind: string, revision: string, body: JsonValue, at: number,
  predecessor: string | null = null, key = revision): Promise<Response> {
  const decoded = decodeCapture({ format: "observation.artifact-revision/v2", source: { ...tenant,
    revision_id: `${tenant.producer}:${tenant.namespace}:${revision}`, run_id,
    unit_id: kind === "plan" ? `${run_id}/planning` : kind === "brief" ? `${run_id}/briefs/slice` : `${run_id}/implementation/slice`,
    artifact_kind: kind, artifact_schema_version: schemaVersion(kind),
    definition_id: source.definition_id,
    predecessor_id: predecessor ? `${tenant.producer}:${tenant.namespace}:${predecessor}` : null, subject_id: null },
    recorded_at: `2026-10-28T00:00:${String(at).padStart(2, "0")}.000Z`, body, body_digest: digest(body) }, key);
  if (!decoded.ok) throw new Error(decoded.error.detail);
  const result = await captureDelivery(db, decoded.value);
  if (result.status === 201) await projectRevision(db, tenant, revision);
  return Response.json(result.body, { status: result.status });
}

integration("duplicate ids, reorder, revision update, missing source and conflicting duplicate retain explicit outcomes", async () => scratch(async (db) => {
  const app = createApp({ db, credentials });
  const cases = await failureCases();
  const plan = await fixture("plan") as unknown as PlanBody;
  const firstDelivery = await ingest(db, "plan", "plan-1", plan as unknown as JsonValue, 1,
    null, cases.repeated_delivery.event_id);
  expect(firstDelivery.status).toBe(201);
  const firstAck = await firstDelivery.json();
  const original = (await listRunItems(db, tenant, run_id, { limit: 100, offset: 0 })).items
    .filter((item) => item.revision_id === "plan-1" && item.item_kind === "criterion");
  expect(original).toHaveLength(2);

  // Two criteria with one producer ID collide inside a single revision; the first remains visible.
  const duplicate = structuredClone(plan);
  duplicate.cohorts[0]!.acceptance_criteria.push({ ...duplicate.cohorts[0]!.acceptance_criteria[0]!,
    ...cases.duplicate_item });
  expect((await ingest(db, "plan", "plan-duplicate", duplicate as unknown as JsonValue, 2)).status).toBe(201);
  const duplicatePage = await listRunItems(db, tenant, run_id, { limit: 100, offset: 0 });
  expect(duplicatePage.issues.some((issue) => issue.revision_id === "plan-duplicate" && issue.kind === "identity_collision")).toBe(true);
  expect(duplicatePage.items.filter((item) => item.revision_id === "plan-duplicate" && item.item_kind === "criterion")).toHaveLength(2);

  // Reordering a successor changes JSON paths, while identified logical items keep their identity.
  const reordered = structuredClone(plan);
  reordered.cohorts[0]!.acceptance_criteria.sort((a, b) => cases.reordered_criterion_ids.indexOf(a.id)
    - cases.reordered_criterion_ids.indexOf(b.id));
  expect(reordered.cohorts[0]!.acceptance_criteria.map((criterion) => criterion.id)).toEqual([...cases.reordered_criterion_ids]);
  expect((await ingest(db, "plan", "plan-2", reordered as unknown as JsonValue, 3, "plan-1")).status).toBe(201);
  const reorderedItems = (await listRunItems(db, tenant, run_id, { limit: 100, offset: 0 })).items
    .filter((item) => item.revision_id === "plan-2" && item.item_kind === "criterion");
  expect(reorderedItems.map((item) => item.json_pointer).sort()).toEqual(original.map((item) => item.json_pointer).sort());
  expect(reorderedItems.every((item) => original.some((old) => old.logical_item_id === item.logical_item_id
    && old.occurrence_id !== item.occurrence_id))).toBe(true);
  expect(reorderedItems.every((item) => original.some((old) => old.logical_item_id === item.logical_item_id
    && old.json_pointer !== item.json_pointer))).toBe(true);

  // An edit creates a new immutable revision, and lineage identifies it as a change.
  const edited = structuredClone(reordered);
  edited.cohorts[0]!.acceptance_criteria.find((criterion) => criterion.id === cases.revision_update.id)!.text
    = cases.revision_update.text;
  expect((await ingest(db, "plan", "plan-3", edited as unknown as JsonValue, 4, "plan-2")).status).toBe(201);
  const editedItem = (await listRunItems(db, tenant, run_id, { limit: 100, offset: 0 })).items
    .find((item) => item.revision_id === "plan-3" && item.item_kind === "criterion")!;
  expect((await readLineage(db, tenant, editedItem.occurrence_id, { limit: 100, offset: 0 }))?.republication)
    .toEqual({ predecessor_revision_id: `${tenant.producer}:${tenant.namespace}:plan-2`, is_republication: false });
  const oldRevision = await app.request(`/v1/source-revisions/${tenant.producer}:${tenant.namespace}:plan-1`,
    { headers: { authorization: "Bearer read-fixture" } });
  expect((await oldRevision.json()).body).toEqual(plan);

  // The missing assessment target is retained as an unresolved producer reference.
  expect((await ingest(db, "brief", "brief-1", await fixture("brief"), 5)).status).toBe(201);
  const assessment = await fixture("assessment") as unknown as { findings: { criterion_id: string | null }[] };
  assessment.findings[1]!.criterion_id = cases.missing_source_ref;
  expect((await ingest(db, "assessment", "assessment-1", assessment as unknown as JsonValue, 6)).status).toBe(201);
  const missing = (await listRunItems(db, tenant, run_id, { limit: 100, offset: 0 })).items
    .find((item) => item.revision_id === "assessment-1" && item.item_id_or_path === "/findings/1")!;
  const lineage = await readLineage(db, tenant, missing.occurrence_id, { limit: 100, offset: 0 });
  expect(lineage?.unresolved.some((edge) => edge.unresolved_target_ref?.includes(cases.missing_source_ref))).toBe(true);
  expect(lineage?.edges.some((edge) => edge.type === "assesses" && edge.target_occurrence_id !== null)).toBe(false);

  // A repeated delivery reuses one revision. A different body under that identity is refused.
  const repeated = await ingest(db, "plan", "plan-1", plan as unknown as JsonValue, 1,
    null, cases.repeated_delivery.event_id);
  expect(repeated.status).toBe(201);
  expect(await repeated.json()).toEqual(firstAck);
  const conflictingBody = { ...plan, summary: cases.conflicting_duplicate.summary };
  const conflict = await ingest(db, "plan", cases.conflicting_duplicate.revision_id,
    conflictingBody as unknown as JsonValue, 1, null, "conflicting-delivery");
  expect(conflict.status).toBe(409);
  expect((await conflict.json()).error.code).toBe("revision_identity_conflict");
  const revisionCount = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.source_revision")
    .select("revision_id").where("revision_id", "=", "plan-1").execute());
  expect(revisionCount).toHaveLength(1);
  const preserved = await app.request(`/v1/source-revisions/${tenant.producer}:${tenant.namespace}:plan-1`,
    { headers: { authorization: "Bearer read-fixture" } });
  expect((await preserved.json()).body).toEqual(plan);
}));

integration("invalid capture versions and absent provenance are refused without storing revisions", async () => scratch(async (db) => {
  const app = createApp({ db, credentials });
  const valid = { format: "observation.artifact-revision/v2", source: { ...tenant,
    revision_id: `${tenant.producer}:${tenant.namespace}:invalid-capture`, run_id, unit_id: "unit-1",
    artifact_kind: "brief", artifact_schema_version: "schema-1", definition_id: "definition-1" },
    recorded_at: "2026-10-28T00:00:00.000Z", body: {}, body_digest: digest({}) };
  const invalid = [
    { ...valid, format: "observation.artifact-revision/" + "v1" },
    ...["definition_id", "artifact_schema_version"].flatMap((field) => [undefined, ""].map((value) =>
      ({ ...valid, source: { ...valid.source, [field]: value } }))),
  ];
  const statuses = await Promise.all(invalid.map(async (input) => (await app.request("/v1/sources/oakridge/events", {
    method: "POST", headers: { authorization: "Bearer ingest-fixture", "idempotency-key": crypto.randomUUID(),
      "content-type": "application/json" }, body: JSON.stringify({ previous: { commit_txid: "0", id: "" }, cursor: { commit_txid: "1", id: "invalid" },
      outcome: { format: "observation.source-event/v1", kind: "artifact_revision", event_kind: "revision_published", event_id: "invalid", run_id,
        definition_id: source.definition_id, artifact_schema_version: "schema-1", revision: input } }) })).status));
  expect(statuses).toEqual([400, 400, 400, 400, 400]);
  const revisions = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.source_revision").select("revision_id").execute());
  expect(revisions).toEqual([]);
}));
