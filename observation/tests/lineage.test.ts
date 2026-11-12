import type { LogicalItemId } from "../src/domain/identity";
import { withTenant } from "../src/storage/database";
import { listRunItems } from "../src/storage/projection-store";
import { expect } from "bun:test";
import { createApp } from "../src/http/app";
import { oakridgeProfile, createFeed, fixtureBody, integration, scratchDatabase, tenant } from "./grading-fixture";
import { readLineage } from "../src/storage/projection-store";

const credentials = { ingest: [], read: [{ ...tenant, token: "read" }], grade: [{ ...tenant, token: "grade", reviewer_id: "operator" }] };
const read = { authorization: "Bearer read" };

integration("items, lineage and grades read target records, paginated and tenant-scoped", async () => scratchDatabase(async (db) => {
  const app = createApp({ db, credentials, profile: oakridgeProfile });
  const feed = createFeed(db);
  await feed.revision({ revision_id: "analysis-1", artifact_kind: "analysis", body: await fixtureBody("analysis") });
  const listed = await (await app.request("/v1/runs/run-1/items?limit=2", { headers: read })).json() as
    { readonly items: readonly { readonly occurrence_id: string }[]; readonly total: number; readonly limit: number };
  expect({ count: listed.items.length, total: listed.total, limit: listed.limit }).toEqual({ count: 2, total: 4, limit: 2 });
  const id = encodeURIComponent(listed.items[0]!.occurrence_id);
  expect((await app.request(`/v1/items/${id}`, { headers: read })).status).toBe(200);
  expect((await app.request(`/v1/items/${id}/lineage`, { headers: read })).status).toBe(200);
  expect(await (await app.request(`/v1/items/${id}/grades`, { headers: read })).json()).toEqual({ items: [], total: 0, limit: 50, offset: 0 });
  expect((await app.request(`/v1/items/${id}/grades?limit=0`, { headers: read })).status).toBe(400);
  expect((await app.request("/v1/items/missing/grades", { headers: read })).status).toBe(404);
  expect((await app.request(`/v1/items/${id}`)).status).toBe(403);
  const other = createApp({ db, credentials: { ingest: [], read: [{ ...tenant, namespace: "other", token: "other-read" }] }, profile: oakridgeProfile });
  expect((await other.request(`/v1/items/${id}`, { headers: { authorization: "Bearer other-read" } })).status).toBe(404);
}));

integration("a task's lineage follows its relations, and an unresolved link stays listed as unresolved", async () => scratchDatabase(async (db) => {
  const feed = createFeed(db);
  await feed.revision({ revision_id: "tasks-1", artifact_kind: "tasks", body: await fixtureBody("tasks") });
  await feed.revision({ revision_id: "assessment-1", artifact_kind: "assessment", body: await fixtureBody("assessment") });
  const app = createApp({ db, credentials, profile: oakridgeProfile });
  const page = await (await app.request("/v1/runs/run-1/items", { headers: read })).json() as
    { readonly items: readonly { readonly occurrence_id: string; readonly revision_id: string; readonly json_pointer: string }[] };
  const unknownReference = page.items.find((item) => item.revision_id === "assessment-1" && item.json_pointer === "/findings/3")!;
  const lineage = await readLineage(db, tenant, unknownReference.occurrence_id, { limit: 50, offset: 0 });
  expect(lineage?.unresolved.map((relation) => relation.unresolved_target_ref)).toEqual(["logical_item:task:T404"]);
  const task = page.items.find((item) => item.revision_id === "tasks-1" && item.json_pointer === "/tasks/0")!;
  const shared = await readLineage(db, tenant, task.occurrence_id, { limit: 50, offset: 0 });
  expect(shared?.edges.filter((relation) => relation.type === "assesses").map((relation) => relation.evidence_ref).sort())
    .toEqual(["/findings/0/task_ids/0", "/findings/0/task_ids/1", "/findings/1/task_ids/0"]);
}));

integration("a republished revision reports its predecessor", async () => scratchDatabase(async (db) => {
  const feed = createFeed(db);
  const body = await fixtureBody("analysis");
  await feed.revision({ revision_id: "analysis-1", artifact_kind: "analysis", body });
  await feed.revision({ revision_id: "analysis-2", artifact_kind: "analysis", body, predecessor_id: "analysis-1" });
  const app = createApp({ db, credentials, profile: oakridgeProfile });
  const page = await (await app.request("/v1/runs/run-1/items", { headers: read })).json() as
    { readonly items: readonly { readonly occurrence_id: string; readonly revision_id: string }[] };
  const later = page.items.find((item) => item.revision_id === "analysis-2")!;
  expect((await readLineage(db, tenant, later.occurrence_id, { limit: 50, offset: 0 }))?.republication)
    .toEqual({ predecessor_revision_id: `oakridge:${tenant.namespace}:analysis-1`, is_republication: true });
}));

integration("task lineage returns each associated contribution once with its association provenance", async () => scratchDatabase(async (db) => {
  const feed = createFeed(db);
  await feed.revision({ revision_id: "tasks-1", artifact_kind: "tasks", body: await fixtureBody("tasks") });
  await feed.revision({ revision_id: "assessment-1", artifact_kind: "assessment", body: { findings: [
    { task_ids: ["T7", "T7"], criterion: "shared", status: "met", evidence: [] },
    { task_ids: ["T8"], criterion: "other task", status: "met", evidence: [] },
    { task_ids: [], criterion: "successor", status: "met", evidence: [] }
  ] } });
  const captured = await listRunItems(db, tenant, "run-1", { limit: 200, offset: 0 });
  const first = captured.items.find((item) => item.revision_id === "assessment-1" && item.json_pointer === "/findings/0");
  const successor = captured.items.find((item) => item.revision_id === "assessment-1" && item.json_pointer === "/findings/2");
  const task = captured.items.find((item) => item.revision_id === "tasks-1" && item.json_pointer === "/tasks/0");
  if (!first || !successor || !task?.logical_item_id) throw new Error("captured fixture incomplete");
  await withTenant(db, tenant, (trx) => trx.insertInto("observation.item_relation").values({ ...tenant, relation_id: "fixture-successor",
    source_occurrence_id: successor.occurrence_id, source_logical_item_id: null, target_occurrence_id: first.occurrence_id,
    target_logical_item_id: null, unresolved_target_ref: null, type: "supersedes", asserted_by: "human", evidence_ref: "fixture-successor",
    algorithm: null, algorithm_version: null }).execute());
  const scoped = await readLineage(db, tenant, successor.occurrence_id, { limit: 200, offset: 0 }, task.logical_item_id as LogicalItemId);
  expect(scoped?.edges.some((edge) => edge.relation_id === "fixture-successor")).toBe(true);
  const app = createApp({ db, credentials, profile: oakridgeProfile });
  const response = await app.request("/v1/runs/run-1/logical-items/T7/lineage", { headers: read });
  const lineage = await response.json() as import("../src/grading/composite").LogicalItemLineage;
  const contributions = lineage.items.filter((entry) => entry.kind === "contribution");
  expect(contributions.map((entry) => entry.item.item_path)).toEqual(["/findings/0", "/findings/2"]);
  expect(contributions[1]?.provenance.hops.map((hop) => hop.type)).toEqual(["assesses", "supersedes"]);
  expect(contributions[0]?.provenance).toMatchObject({ kind: "relation", hops: [{ type: "assesses", asserted_by: "producer_explicit" }] });
}));
