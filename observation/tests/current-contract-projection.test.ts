import { expect } from "bun:test";
import { createApp } from "../src/http/app";
import { associateTask } from "../src/grading/task-association";
import type { CompositeRelation } from "../src/grading/composite";
import type { ItemOccurrenceId, LogicalItemId, RelationId } from "../src/domain/identity";
import { withTenant } from "../src/storage/database";
import { listRunItems } from "../src/storage/projection-store";
import { oakridgeProfile, createFeed, fixtureBody, integration, scratchDatabase, tenant } from "./grading-fixture";

integration("current extractors project three canonical requirements across all stages without tasks artifacts", async () => scratchDatabase(async (db) => {
  const feed = createFeed(db);
  const stages = { analysis: "analysis", spec: "analysis", plan: "planning", brief: "brief", assessment: "cohort", blocker: "analysis" } as const;
  for (const kind of ["analysis", "spec", "plan", "brief", "assessment", "blocker"] as const) {
    const stage = stages[kind];
    await feed.revision({ revision_id: `run-1/${stage}:${kind}:1`, unit_id: `run-1/${stage}`, stage, artifact_kind: kind,
      body: await fixtureBody(`current-${kind}`),
      input_bindings: kind === "assessment" ? [{ input: "brief", unit: "run-1/brief", revision_id: "run-1/brief:brief:1" }]
        : kind === "spec" ? [{ input: "analysis", unit: "run-1/analysis", revision_id: "run-1/analysis:analysis:1" }] : [] });
  }
  const logical = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.logical_item").selectAll().where("scope", "=", "task").orderBy("producer_local_id").execute());
  expect(logical.map((item) => item.producer_local_id)).toEqual(["R1", "R2", "R3"]);
  const items = (await listRunItems(db, tenant, "run-1", { limit: 100, offset: 0 })).items;
  expect(items.filter((item) => item.artifact_kind === "tasks")).toEqual([]);
  expect(items.filter((item) => item.item_kind === "blocker").map((item) => item.json_pointer)).toEqual([""]);
  const blocker = items.find((item) => item.item_kind === "blocker")!;
  const service = createApp({ db, profile: oakridgeProfile, credentials: {
    ingest: [{ ...tenant, token: "ingest" }], read: [{ ...tenant, token: "read" }],
  } });
  const address = `/v1/runs/run-1/items/at?source_revision_id=${encodeURIComponent(blocker.revision_id)}`;
  const response = await service.request(`${address}&item_path=`, { headers: { authorization: "Bearer read" } });
  expect([response.status, await response.json()]).toMatchObject([200, { item_path: "", item_kind: "blocker" }]);
  expect((await service.request(address, { headers: { authorization: "Bearer read" } })).status).toBe(400);
  const relations = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.item_relation").selectAll().where("source_occurrence_id", "is not", null).execute());
  const task_id = logical[0]!.logical_item_id as LogicalItemId;
  const split = items.filter((item) => item.item_kind === "allocation" && item.producer_local_id === "R1")
    .sort((left, right) => left.json_pointer.localeCompare(right.json_pointer));
  expect(split.map((item) => [item.logical_item_id, item.item_scope, item.selected_value])).toEqual([
    [task_id, "cohort/C1/allocation", { requirement_id: "R1", contribution: "C1 contribution to R1" }],
    [task_id, "cohort/C2/allocation", { requirement_id: "R1", contribution: "C2 contribution to R1" }],
  ]);
  expect(new Set(split.map((item) => item.occurrence_id)).size).toBe(2);
  const allocationIdentities = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.logical_item")
    .select("logical_item_id").where("scope", "like", "cohort/%/allocation").execute());
  expect(allocationIdentities).toEqual([]);
  const associated = associateTask({ task_id, occurrences: items.map((item) => ({ occurrence_id: item.occurrence_id as ItemOccurrenceId, logical_item_id: item.logical_item_id as LogicalItemId | null })),
    relations: relations.map((relation): CompositeRelation => ({ ...relation,
      relation_id: relation.relation_id as RelationId, source_occurrence_id: relation.source_occurrence_id as ItemOccurrenceId,
      target_occurrence_id: relation.target_occurrence_id as ItemOccurrenceId | null,
      target_logical_item_id: relation.target_logical_item_id as LogicalItemId | null,
      type: relation.type as CompositeRelation["type"], asserted_by: relation.asserted_by as CompositeRelation["asserted_by"],
    })) });
  const selected = items.filter((item) => associated.some((entry) => entry.occurrence_id === item.occurrence_id));
  expect([...new Set(selected.map((item) => item.artifact_kind))].sort()).toEqual(["analysis", "assessment", "brief", "plan", "spec"]);
  expect(selected.filter((item) => item.item_kind === "allocation").map((item) => item.item_scope).sort()).toEqual(["cohort/C1/allocation", "cohort/C2/allocation"]);
  expect(relations.filter((relation) => relation.unresolved_target_ref !== null)).toEqual([]);
}));

for (const delayed of [false, true]) integration(`spec links use the recorded analysis revision with repeated finding IDs (${delayed ? "late" : "ordered"} capture)`, async () => scratchDatabase(async (db) => {
  const feed = createFeed(db);
  const analysis = await fixtureBody("current-analysis");
  const spec = await fixtureBody("current-spec");
  const publish = async (kind: "analysis" | "spec", sequence: number) => {
    await feed.revision({ revision_id: `run-1/analysis:${kind}:${sequence}`, unit_id: "run-1/analysis", stage: "analysis",
      artifact_kind: kind, body: kind === "spec" ? spec : analysis,
      input_bindings: kind === "spec" ? [{ input: "analysis", unit: "run-1/analysis", revision_id: "run-1/analysis:analysis:2" }] : [] });
  };
  await publish("analysis", 1);
  if (!delayed) await publish("analysis", 2);
  await publish("analysis", 3);
  await publish("spec", 1);
  const targets = () => withTenant(db, tenant, (trx) => trx.selectFrom("observation.item_relation as relation")
    .innerJoin("observation.item_occurrence as source", "source.occurrence_id", "relation.source_occurrence_id")
    .leftJoin("observation.item_occurrence as target", "target.occurrence_id", "relation.target_occurrence_id")
    .select(["relation.unresolved_target_ref", "target.revision_id"])
    .where("source.artifact_kind", "=", "spec").where("relation.type", "=", "derived_from").execute());
  if (delayed) {
    expect((await targets()).every((target) => target.unresolved_target_ref !== null)).toBe(true);
    await publish("analysis", 2);
  }
  expect(await targets()).toEqual(Array.from({ length: 4 }, () => ({ unresolved_target_ref: null, revision_id: "run-1/analysis:analysis:2" })));
  await expect(feed.revision({ revision_id: "run-1/analysis:spec:1", unit_id: "run-1/analysis", stage: "analysis", artifact_kind: "spec",
    body: spec, input_bindings: [{ input: "analysis", unit: "run-1/analysis", revision_id: "run-1/analysis:analysis:1" }] })).rejects.toThrow("cursor_conflict");
}));
