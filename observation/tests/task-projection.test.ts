import { expect } from "bun:test";
import { listRunItems } from "../src/storage/projection-store";
import { withTenant } from "../src/storage/database";
import { createFeed, integration, scratchDatabase, tenant } from "./grading-fixture";

const scope = { limit: 100, offset: 0 };
const spec = { requirements: [{ id: "R1", text: "Handle the case", acceptance_conditions: ["Pass"], source_refs: [], analysis_finding_ids: [] }] };
const assessment = { item_assessments: [{ subject: { kind: "requirement", id: "R1" }, status: "met", observation: "Verified", evidence: [] }],
  additional_findings: [], proposals: [], verifications: [] };

integration("an explicit logical reference resolves in place only when its own run captures the requirement", async () => scratchDatabase(async (db) => {
  const feed = createFeed(db);
  await feed.revision({ revision_id: "assessment", artifact_kind: "assessment", stage: "integration", body: assessment });
  const relation = () => withTenant(db, tenant, (trx) => trx.selectFrom("observation.item_relation")
    .selectAll().where("type", "=", "assesses").executeTakeFirstOrThrow());
  const before = await relation();
  expect(before.unresolved_target_ref).toBe("logical_item:task:requirement:R1");
  await feed.revision({ revision_id: "other-spec", run_id: "run-2", artifact_kind: "spec", body: spec });
  expect((await relation()).unresolved_target_ref).toBe(before.unresolved_target_ref);
  await feed.revision({ revision_id: "spec", artifact_kind: "spec", body: spec });
  const after = await relation();
  expect(after).toMatchObject({ relation_id: before.relation_id, unresolved_target_ref: null,
    target_logical_item_id: "oakridge:grading-test:run-1:task:requirement:R1" });
  expect((await listRunItems(db, tenant, "run-2", scope)).items[0]?.logical_item_id).toBe("oakridge:grading-test:run-2:task:requirement:R1");
}));

integration("bound occurrence links await the exact brief revision and ignore a matching build item in another revision", async () => scratchDatabase(async (db) => {
  const feed = createFeed(db);
  const brief = { cohort_id: "cohort", repository_key: "oakridge", build_items: [{ id: "B1", requirement_ids: ["R1"], instructions: "Build", verification: ["Test"] }],
    technical_decisions: [] };
  await feed.revision({ revision_id: "spec", artifact_kind: "spec", body: spec });
  await feed.revision({ revision_id: "brief-new", artifact_kind: "brief", body: brief });
  await feed.revision({ revision_id: "assessment", artifact_kind: "assessment",
    input_bindings: [{ input: "assignment", unit: "brief", revision_id: "brief-bound" }],
    body: { ...assessment, item_assessments: [{ ...assessment.item_assessments[0]!, subject: { kind: "build_item", id: "B1" } }] } });
  const target = () => withTenant(db, tenant, (trx) => trx.selectFrom("observation.item_relation as edge")
    .leftJoin("observation.item_occurrence as target", "target.occurrence_id", "edge.target_occurrence_id")
    .select(["edge.relation_id", "edge.unresolved_target_ref", "target.revision_id"])
    .where("edge.type", "=", "assesses").executeTakeFirstOrThrow());
  const pending = await target();
  expect(pending.unresolved_target_ref).not.toBeNull();
  await feed.revision({ revision_id: "brief-bound", artifact_kind: "brief", body: brief });
  expect(await target()).toEqual({ relation_id: pending.relation_id, unresolved_target_ref: null, revision_id: "brief-bound" });
}));
