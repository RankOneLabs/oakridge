import { deliverSourceEvent } from "../src/storage/capture-store";
import { NO_CAPTURE_PINS } from "../src/grading/evidence";
import { expect } from "bun:test";
import { CURRENT_SCHEMA_VERSIONS, currentDefinitions } from "../src/producers/oakridge/catalogue";
import { associateTask } from "../src/grading/task-association";
import type { CompositeRelation } from "../src/grading/composite";
import type { ItemOccurrenceId, LogicalItemId, RelationId } from "../src/domain/identity";
import { withTenant } from "../src/storage/database";
import { listRunItems } from "../src/storage/projection-store";
import { oakridgeProfile, fixtureBody, integration, revisionOutcome, scratchDatabase, tenant } from "./grading-fixture";

integration("current extractors project three canonical requirements across all stages without tasks artifacts", async () => scratchDatabase(async (db) => {
  // Exercise the prepared current profile explicitly: live dispatch of colliding
  // fingerprints is deliberately blocked until the adapter publishes new versions.
  let cursor = { commit_txid: "0", id: "" };
  let sequence = 0;
  for (const kind of ["analysis", "spec", "plan", "brief", "assessment"] as const) {
    const outcome = revisionOutcome({ revision_id: kind, artifact_kind: kind, body: await fixtureBody(`current-${kind}`),
      ...(kind === "assessment" ? { brief_revision_ids: ["brief"], subject_id: "build" } : {}) });
    if (outcome.kind !== "artifact_revision") throw new Error("expected revision");
    const currentOutcome = { ...outcome, artifact_schema_version: CURRENT_SCHEMA_VERSIONS[kind],
      revision: { ...outcome.revision, source: { ...outcome.revision.source, artifact_schema_version: CURRENT_SCHEMA_VERSIONS[kind] } } };
    const next = { commit_txid: String(++sequence), id: outcome.event_id };
    const result = await deliverSourceEvent(db, tenant, { previous: cursor, cursor: next, outcome: currentOutcome }, {
      configuration: NO_CAPTURE_PINS, extraction: { ...oakridgeProfile.extraction,
        definitions: (kind, version) => currentDefinitions(version).filter((definition) => definition.artifact_kind === kind) },
    });
    expect(result.status).toBe(200);
    cursor = next;
  }
  const logical = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.logical_item").selectAll().where("scope", "=", "task").orderBy("producer_local_id").execute());
  expect(logical.map((item) => item.producer_local_id)).toEqual(["R1", "R2", "R3"]);
  const items = (await listRunItems(db, tenant, "run-1", { limit: 100, offset: 0 })).items;
  expect(items.filter((item) => item.artifact_kind === "tasks")).toEqual([]);
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
