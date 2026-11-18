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

async function currentDefinition() {
  const core = CoreClient.start();
  if (!core.ok) throw new Error(JSON.stringify(core.error));
  const catalog = readLaunchableCatalog();
  if (!catalog.ok) throw new Error(JSON.stringify(catalog.error));
  const compiled = await compileDefinition(core.value, catalog.value.development.definition_id);
  core.value.close();
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.error));
  return compiled.value;
}

integration("current extractors project three canonical requirements across all stages without tasks artifacts", async () => scratchDatabase(async (db) => {
  const definition = await currentDefinition();
  const feed = createFeed(db);
  const stages = { analysis: "analysis", spec: "analysis", plan: "planning", brief: "brief", assessment: "cohort", blocker: "analysis" } as const;
  let sequence = 0;
  for (const kind of ["analysis", "spec", "plan", "brief", "assessment", "blocker"] as const) {
    const stage = stages[kind];
    const outcome = mapObservationEvent({
      definition, namespace: tenant.namespace, stage, revision_sequence: 1, run_config: null,
      analysis_revision_id: kind === "spec" ? "run-1/analysis:analysis:1" : null,
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
  const definition = await currentDefinition();
  const feed = createFeed(db);
  const analysis = await fixtureBody("current-analysis");
  const spec = await fixtureBody("current-spec");
  const publish = async (kind: "analysis" | "spec", sequence: number) => {
    const outcome = mapObservationEvent({ definition, namespace: tenant.namespace, stage: "analysis", revision_sequence: sequence,
      run_config: null, analysis_revision_id: kind === "spec" ? "run-1/analysis:analysis:2" : null,
      row: { id: `${kind}:${sequence}`, run_id: "run-1", unit_id: "run-1/analysis", commit_txid: String(sequence),
        created_at: new Date(`2026-11-01T00:00:0${kind === "spec" ? 4 : sequence}Z`), was_visible_at_subscription: false,
        payload: { kind: "revision_published", unit: "run-1/analysis", artifact: kind, body: kind === "spec" ? spec : analysis },
      } });
    await feed.send(outcome);
    return outcome;
  };
  await publish("analysis", 1);
  if (!delayed) await publish("analysis", 2);
  await publish("analysis", 3);
  const specification = await publish("spec", 1);
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
  if (specification.kind !== "artifact_revision") throw new Error("expected mapped specification");
  await expect(feed.send({ ...specification, event_id: "spec:conflicting-provenance", revision: { ...specification.revision,
    source: { ...specification.revision.source, analysis_revision_ids: [`oakridge:${tenant.namespace}:run-1/analysis:analysis:1`] } } }))
    .rejects.toThrow("cursor_conflict");
}));
