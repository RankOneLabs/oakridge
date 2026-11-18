import { CoreClient, compileDefinition } from "../../oakridge-dbos/src/core-client/client";
import { readLaunchableCatalog } from "../../oakridge-dbos/src/runtime/definition-store";
import { mapObservationEvent } from "../../oakridge-dbos/src/adapters/observation-mapping";
import { expect } from "bun:test";
import { createApp } from "../src/http/app";
import { CURRENT_SCHEMA_VERSIONS } from "../src/producers/oakridge/catalogue";
import { associateTask } from "../src/grading/task-association";
import type { CompositeRelation } from "../src/grading/composite";
import type { ItemOccurrenceId, LogicalItemId, RelationId } from "../src/domain/identity";
import { withTenant } from "../src/storage/database";
import { listRunItems } from "../src/storage/projection-store";
import { oakridgeProfile, createFeed, fixtureBody, integration, scratchDatabase, tenant } from "./grading-fixture";

integration("current extractors project three canonical requirements across all stages without tasks artifacts", async () => scratchDatabase(async (db) => {
  const core = CoreClient.start();
  if (!core.ok) throw new Error(JSON.stringify(core.error));
  const catalog = readLaunchableCatalog();
  if (!catalog.ok) throw new Error(JSON.stringify(catalog.error));
  const compiled = await compileDefinition(core.value, catalog.value.development.definition_id);
  core.value.close();
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.error));
  const feed = createFeed(db);
  const stages = { analysis: "analysis", spec: "analysis", plan: "planning", brief: "brief", assessment: "cohort", blocker: "analysis" } as const;
  let sequence = 0;
  for (const kind of ["analysis", "spec", "plan", "brief", "assessment", "blocker"] as const) {
    const stage = stages[kind];
    const outcome = mapObservationEvent({
      definition: compiled.value, namespace: tenant.namespace, stage, revision_sequence: 1, run_config: null,
      input_provenance: kind === "assessment" ? { status: "recorded", entries: [
        { input: "brief", unit: "run-1/brief", revision_id: "run-1/brief:brief:1" },
      ] } : { status: "unresolved" },
      row: { id: `event:${++sequence}`, run_id: "run-1", unit_id: `run-1/${stage}`, commit_txid: String(sequence),
        created_at: new Date("2026-11-01T00:00:00Z"), was_visible_at_subscription: false,
        payload: { kind: "revision_published", unit: `run-1/${stage}`, artifact: kind, body: await fixtureBody(`current-${kind}`) },
      },
    });
    expect(outcome.artifact_schema_version).toBe(CURRENT_SCHEMA_VERSIONS[kind]);
    await feed.send(outcome);
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
