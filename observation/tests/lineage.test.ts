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
