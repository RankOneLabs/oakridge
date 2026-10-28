import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { canonicalDigest } from "../src/canonical/canonical-json";
import type { JsonValue } from "../src/domain/primitives";
import { createApp } from "../src/http/app";
import { openDatabase, withTenant, type Database } from "../src/storage/database";
import { migrateEmptyDatabase } from "../src/storage/migrate";
import { listRunItems, projectRevision, readLineage, recordHumanRelation } from "../src/storage/projection-store";

const serverUrl = process.env.OAKRIDGE_TEST_DATABASE_URL;
const integration = serverUrl || process.env.CI === "true" ? test : test.skip;
const tenant = { producer: "oakridge", namespace: "projection-test" };
const credentials = { ingest: [], read: [{ ...tenant, token: "read-secret" }] };

async function scratch(work: (db: Database) => Promise<void>): Promise<void> {
  if (!serverUrl) throw new Error("OAKRIDGE_TEST_DATABASE_URL is required");
  const name = `observation_projection_${randomBytes(6).toString("hex")}`;
  const admin = new Client({ connectionString: serverUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(serverUrl);
    url.pathname = `/${name}`;
    const db = openDatabase(url.href);
    try { await migrateEmptyDatabase(db); await work(db); }
    finally { await db.destroy(); await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); }
  } finally { await admin.end(); }
}
async function fixture(name: string): Promise<JsonValue> {
  return await Bun.file(new URL(`../fixtures/oakridge/${name}-revision.json`, import.meta.url)).json() as JsonValue;
}
async function insertRevision(db: Database, revision_id: string, artifact_kind: string, body: JsonValue,
  at: number, run_id = "run-1", unit_id = `run-1/implementation/alpha`): Promise<void> {
  const digest = canonicalDigest(body);
  if (!digest.ok) throw new Error(digest.error.detail);
  await withTenant(db, tenant, (trx) => trx.insertInto("observation.source_revision").values({ ...tenant,
    revision_id, run_id, unit_id, artifact_kind, artifact_schema_version: "development-v1",
    definition_bundle_id: "development", definition_bundle_digest: "bundle-sha256:test", body,
    body_digest: digest.value, recorded_at: new Date(`2026-10-28T00:00:${String(at).padStart(2, "0")}.000Z`) }).execute().then(() => undefined));
}
async function items(db: Database, run_id = "run-1") {
  return (await listRunItems(db, tenant, run_id, { limit: 200, offset: 0 })).items;
}
async function allPages<T>(load: (limit: number, offset: number) => Promise<{ items: readonly T[]; total: number }>, size: number): Promise<T[]> {
  const result: T[] = [];
  let total = 0;
  do { const page = await load(size, result.length); result.push(...page.items); total = page.total; } while (result.length < total);
  return result;
}

integration("producer lineage, human splits, unresolved links and both read pagers stay honest", async () => scratch(async (db) => {
  await insertRevision(db, "plan-1", "plan", await fixture("plan"), 1);
  await projectRevision(db, tenant, "plan-1");
  await insertRevision(db, "brief-1", "brief", await fixture("brief"), 2);
  await projectRevision(db, tenant, "brief-1");
  await insertRevision(db, "assessment-1", "assessment", await fixture("assessment"), 3);
  await projectRevision(db, tenant, "assessment-1");
  const rows = await items(db);
  const planCriterion = rows.find((row) => row.artifact_kind === "plan" && row.item_kind === "criterion")!;
  const briefCriterion = rows.find((row) => row.artifact_kind === "brief" && row.item_kind === "criterion")!;
  const planWide = rows.find((row) => row.item_kind === "plan_wide_criterion")!;
  const finding = rows.find((row) => row.artifact_kind === "assessment" && row.item_id_or_path === "/findings/0")!;
  const missing = rows.find((row) => row.artifact_kind === "assessment" && row.item_id_or_path === "/findings/1")!;
  expect(planWide.logical_item_id).toBeNull();
  expect((await readLineage(db, tenant, planWide.occurrence_id, { limit: 50, offset: 0 }))?.edges).toEqual([]);
  await recordHumanRelation(db, tenant, briefCriterion.occurrence_id, planWide.occurrence_id, "split_from", "operator:split-1");
  const lineage = await readLineage(db, tenant, finding.occurrence_id, { limit: 100, offset: 0 });
  expect(lineage?.edges.some((edge) => edge.source_occurrence_id === briefCriterion.occurrence_id
    && edge.target_occurrence_id === planCriterion.occurrence_id && edge.asserted_by === "producer_explicit")).toBe(true);
  expect(lineage?.edges.some((edge) => edge.source_occurrence_id === finding.occurrence_id
    && edge.target_occurrence_id === briefCriterion.occurrence_id && edge.type === "assesses")).toBe(true);
  expect(lineage?.edges.some((edge) => edge.type === "split_from" && edge.asserted_by === "human")).toBe(true);
  const unresolved = await readLineage(db, tenant, missing.occurrence_id, { limit: 100, offset: 0 });
  expect(unresolved?.unresolved.some((edge) => edge.unresolved_target_ref?.includes("missing"))).toBe(true);
  expect(unresolved?.edges.some((edge) => edge.unresolved_target_ref !== null)).toBe(false);
  await recordHumanRelation(db, tenant, missing.occurrence_id, briefCriterion.occurrence_id, "addresses", "operator:link-1");
  const foreignBrief = await fixture("brief") as unknown as { acceptance_criteria: { id: string; text: string; task_ids: string[]; decision_ids: string[] }[] };
  foreignBrief.acceptance_criteria[0]!.id = "foreign";
  await insertRevision(db, "brief-foreign", "brief", foreignBrief as unknown as JsonValue, 4, "run-2", "run-2/briefs/alpha");
  await projectRevision(db, tenant, "brief-foreign");
  const foreignAssessment = await fixture("assessment") as unknown as { findings: { criterion_id: string; evidence: JsonValue[] }[] };
  foreignAssessment.findings[0]!.criterion_id = "foreign";
  await insertRevision(db, "assessment-foreign", "assessment", foreignAssessment as unknown as JsonValue, 5);
  await projectRevision(db, tenant, "assessment-foreign");
  const foreignFinding = (await items(db)).find((row) => row.revision_id === "assessment-foreign" && row.item_id_or_path === "/findings/0")!;
  expect((await readLineage(db, tenant, foreignFinding.occurrence_id, { limit: 100, offset: 0 }))?.unresolved
    .some((edge) => edge.unresolved_target_ref?.includes("foreign"))).toBe(true);

  const app = createApp({ db, credentials });
  const response = await app.request(`/v1/items/${encodeURIComponent(finding.occurrence_id)}/lineage?limit=2&offset=0`,
    { headers: { authorization: "Bearer read-secret" } });
  expect(response.status).toBe(200);
  expect((await response.json()).edges).toBeArray();
  const itemResponse = await app.request(`/v1/items/${encodeURIComponent(planWide.occurrence_id)}`,
    { headers: { authorization: "Bearer read-secret" } });
  expect(itemResponse.status).toBe(200);
  const runResponse = await app.request("/v1/runs/run-1/items?limit=2&offset=0",
    { headers: { authorization: "Bearer read-secret" } });
  expect(runResponse.status).toBe(200);
  const pageIds = async (limit: number, offset: number) => {
    const page = await listRunItems(db, tenant, "run-1", { limit, offset });
    return { items: page.items.map((item) => item.occurrence_id), total: page.total };
  };
  expect(await allPages(pageIds, 2)).toEqual(await allPages(pageIds, 5));
  const lineageIds = async (limit: number, offset: number) => {
    const page = (await readLineage(db, tenant, finding.occurrence_id, { limit, offset }))!;
    return { items: page.relations.map((edge) => edge.relation_id), total: page.total };
  };
  expect(await allPages(lineageIds, 2)).toEqual(await allPages(lineageIds, 5));

  const captured = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.source_revision").selectAll().execute());
  expect(captured.every((row) => { const digest = canonicalDigest(row.body); return digest.ok && digest.value === row.body_digest; })).toBe(true);
}));

integration("replay is idempotent, reorder keeps earlier ids, and duplicate ids become issues", async () => scratch(async (db) => {
  const original = await fixture("plan") as unknown as { cohorts: { acceptance_criteria: { id: string; text: string; task_ids: string[]; decision_ids: string[] }[] }[] };
  original.cohorts[0]!.acceptance_criteria.push({ id: "crit-b", text: "B works", task_ids: [], decision_ids: [] });
  await insertRevision(db, "plan-1", "plan", original as unknown as JsonValue, 1);
  await projectRevision(db, tenant, "plan-1");
  const first = (await items(db)).filter((row) => row.revision_id === "plan-1").map((row) => row.occurrence_id).sort();
  expect((await items(db)).filter((row) => row.revision_id === "plan-1").every((row) => {
    const digest = canonicalDigest([row.producer, row.namespace, row.revision_id, row.extractor_id,
      row.extractor_version, row.item_selector, row.item_id_or_path]);
    return digest.ok && digest.value === row.occurrence_id;
  })).toBe(true);
  await projectRevision(db, tenant, "plan-1");
  expect((await items(db)).filter((row) => row.revision_id === "plan-1").map((row) => row.occurrence_id).sort()).toEqual(first);
  const reordered = structuredClone(original);
  reordered.cohorts[0]!.acceptance_criteria.reverse();
  await insertRevision(db, "plan-2", "plan", reordered as unknown as JsonValue, 2);
  await projectRevision(db, tenant, "plan-2");
  const after = await items(db);
  expect(after.filter((row) => row.revision_id === "plan-1").map((row) => row.occurrence_id).sort()).toEqual(first);
  expect(after.filter((row) => row.revision_id === "plan-2").every((row) => !first.includes(row.occurrence_id))).toBe(true);

  const duplicate = structuredClone(original);
  duplicate.cohorts[0]!.acceptance_criteria.push({ id: "crit-a", text: "Conflicting text", task_ids: [], decision_ids: [] });
  await insertRevision(db, "plan-3", "plan", duplicate as unknown as JsonValue, 3);
  await projectRevision(db, tenant, "plan-3");
  const page = await listRunItems(db, tenant, "run-1", { limit: 200, offset: 0 });
  expect(page.issues.some((issue) => issue.revision_id === "plan-3" && issue.kind === "identity_collision")).toBe(true);
  expect(page.items.filter((row) => row.revision_id === "plan-3" && row.item_kind === "criterion")).toHaveLength(2);
  expect(page.items.find((row) => row.revision_id === "plan-3" && row.producer_local_id === "crit-a")?.selected_value)
    .toMatchObject({ text: "A works" });
}));

integration("malformed and empty selectors create issues while other items continue", async () => scratch(async (db) => {
  const body = { findings: [{ id: "finding-a", description: "private secret", severity: "warning" }],
    requirements: "invalid private secret", risks: [], proposed_spec_updates: [] } as unknown as JsonValue;
  await insertRevision(db, "analysis-1", "analysis", body, 1);
  await projectRevision(db, tenant, "analysis-1");
  const page = await listRunItems(db, tenant, "run-1", { limit: 200, offset: 0 });
  expect(page.items.map((row) => row.item_kind)).toEqual(["finding"]);
  expect(page.issues.some((issue) => issue.kind === "extraction_failed" && issue.is_retriable
    && !issue.detail.includes("private secret"))).toBe(true);
  expect(page.issues.some((issue) => issue.kind === "no_matching_items")).toBe(true);
  const lineage = await readLineage(db, tenant, page.items[0]!.occurrence_id, { limit: 50, offset: 0 });
  expect(lineage?.edges).toEqual([]);
}));

integration("ambiguous prior revisions stay unresolved instead of choosing a presumed approval", async () => scratch(async (db) => {
  const plan = await fixture("plan");
  await insertRevision(db, "plan-1", "plan", plan, 1);
  await projectRevision(db, tenant, "plan-1");
  await insertRevision(db, "plan-2", "plan", plan, 2);
  await projectRevision(db, tenant, "plan-2");
  await insertRevision(db, "brief-1", "brief", await fixture("brief"), 3);
  await projectRevision(db, tenant, "brief-1");
  const briefCriterion = (await items(db)).find((row) => row.revision_id === "brief-1" && row.item_kind === "criterion")!;
  const lineage = await readLineage(db, tenant, briefCriterion.occurrence_id, { limit: 100, offset: 0 });
  expect(lineage?.unresolved.some((edge) => edge.unresolved_target_ref?.includes("crit-a"))).toBe(true);
  expect(lineage?.edges.some((edge) => edge.type === "derived_from" && edge.target_occurrence_id !== null)).toBe(false);
}));
