import { expect, test } from "bun:test";
import { sql } from "kysely";
import type { JsonValue } from "../src/domain/primitives";
import { selectRevision } from "../src/projection/extractor";
import { logicalItemId, logicalReference } from "../src/projection/relations";
import { oakridgeCatalogue, TASK_SCOPE } from "../src/producers/oakridge/catalogue";
import { readOccurrenceEvidence } from "../src/storage/captured-evidence-store";
import type { CaptureConfiguration } from "../src/grading/evidence";
import { withTenant, type Database } from "../src/storage/database";
import { registerEvaluator, registerQuestion } from "../src/storage/grading-store";
import { declareRelationInTransaction, listRelatedOccurrences, listRunItems, lockSourceCursor } from "../src/storage/projection-store";
import { oakridgeProfile } from "../src/producers/oakridge/profile";
import { OAKRIDGE_QUESTIONS } from "../src/producers/oakridge/questions";
import { createFeed, evaluator, evaluatorId, fixtureBody, integration, occurrenceIdOf, scratchDatabase, tenant, type Feed } from "./grading-fixture";

const taskId = (task_id: string, run_id = "run-1"): string => logicalItemId({ ...tenant, run_id, scope: TASK_SCOPE, producer_local_id: task_id });
const everything = { limit: 200, offset: 0 };
async function relations(db: Database) {
  return withTenant(db, tenant, (trx) => trx.selectFrom("observation.item_relation").selectAll().where("type", "=", "assesses")
    .where("source_occurrence_id", "is not", null).orderBy("evidence_ref").execute());
}
async function items(db: Database, run_id = "run-1") { return (await listRunItems(db, tenant, run_id, everything)).items; }
async function logicalItems(db: Database) {
  return withTenant(db, tenant, (trx) => trx.selectFrom("observation.logical_item").selectAll().where("scope", "=", TASK_SCOPE)
    .orderBy("logical_item_id").execute());
}

/** Tasks, one plan and its revision, a brief per cohort, an assessment per cohort, and integration. */
async function fullRun(feed: Feed, run_id = "run-1"): Promise<void> {
  const prefix = run_id === "run-1" ? "" : `${run_id}-`;
  const plan = await fixtureBody("plan") as { readonly cohorts: readonly JsonValue[] };
  const brief = await fixtureBody("brief") as { readonly [key: string]: JsonValue };
  const assessment = await fixtureBody("assessment") as { readonly [key: string]: JsonValue };
  await feed.revision({ revision_id: `${prefix}analysis-1`, artifact_kind: "analysis", run_id, body: await fixtureBody("analysis") });
  await feed.revision({ revision_id: `${prefix}tasks-1`, artifact_kind: "tasks", run_id, body: await fixtureBody("tasks") });
  await feed.revision({ revision_id: `${prefix}plan-1`, artifact_kind: "plan", run_id, body: plan as unknown as JsonValue });
  await feed.revision({ revision_id: `${prefix}plan-2`, artifact_kind: "plan", run_id, body: { ...plan, summary: "Reworded plan" } as unknown as JsonValue });
  await feed.revision({ revision_id: `${prefix}brief-alpha`, artifact_kind: "brief", run_id, unit_id: `${run_id}/briefs/alpha`, body: brief });
  await feed.revision({ revision_id: `${prefix}brief-beta`, artifact_kind: "brief", run_id, unit_id: `${run_id}/briefs/beta`, body: { ...brief, cohort_id: "beta",
    acceptance_criteria: [{ id: "T7", text: "Beta's reworded obligation", decision_ids: [] }] } });
  await feed.revision({ revision_id: `${prefix}assessment-alpha`, artifact_kind: "assessment", run_id, unit_id: `${run_id}/implementation/alpha`, body: assessment });
  await feed.revision({ revision_id: `${prefix}assessment-beta`, artifact_kind: "assessment", run_id, unit_id: `${run_id}/implementation/beta`,
    body: { ...assessment, findings: [{ task_ids: ["T7"], criterion: "Beta works", status: "met", evidence: [] }] } });
  await feed.revision({ revision_id: `${prefix}integration-1`, artifact_kind: "assessment", run_id, unit_id: `${run_id}/integration/oakridge`,
    body: { ...assessment, findings: [{ task_ids: ["T7", "T8"], criterion: "Integrated", status: "met", evidence: [] }] } });
}

test("a finding is addressed by revision and path, with no task in its identity", async () => {
  const pass = selectRevision(await fixtureBody("assessment"), "assessment-1", oakridgeCatalogue("assessment", "v1"));
  const selected = pass.items.map(({ item }) => item);
  expect(selected.map((item) => item.item_id_or_path)).toEqual(["/findings/0", "/findings/1", "/findings/2", "/findings/3"]);
  expect(selected.every((item) => item.item_scope === null && item.producer_local_id === null)).toBe(true);
  expect(selected[0]?.links).toEqual([
    { target: "logical_item", type: "assesses", target_scope: "task", target_local_id: "T7", evidence_ref: "/findings/0/task_ids/0" },
    { target: "logical_item", type: "assesses", target_scope: "task", target_local_id: "T8", evidence_ref: "/findings/0/task_ids/1" }]);
  expect(selected[2]?.links).toEqual([]);
});

test("an acceptance entry is its task's occurrence, whatever the plan's supplied task_ids say", async () => {
  const plan = await fixtureBody("plan") as { readonly cohorts: readonly { readonly acceptance_criteria: readonly object[] }[] };
  const enveloped = { ...plan, cohorts: plan.cohorts.map((cohort) => ({ ...cohort,
    acceptance_criteria: cohort.acceptance_criteria.map((entry) => ({ ...entry, task_ids: ["ignored"] })) })) };
  const pass = selectRevision(enveloped as unknown as JsonValue, "plan-1", oakridgeCatalogue("plan", "v1"));
  const entries = pass.items.map(({ item }) => item).filter((item) => item.item_kind === "acceptance_entry");
  expect(entries.map((item) => [item.item_id_or_path, item.item_scope, item.producer_local_id])).toEqual([
    ["/cohorts/0/acceptance_criteria/0", "task", "T7"], ["/cohorts/1/acceptance_criteria/0", "task", "T7"], ["/cohorts/1/acceptance_criteria/1", "task", "T8"]]);
  expect(entries.flatMap((item) => item.links).every((link) => link.target === "occurrence" && link.target_item_kind === "decision")).toBe(true);
});

test("the catalogue allocates no separate acceptance identity and reads no plan-wide list", async () => {
  for (const artifact of ["plan", "brief"]) {
    const pass = selectRevision(await fixtureBody(artifact), `${artifact}-1`, oakridgeCatalogue(artifact, "v1"));
    expect(pass.items.filter(({ item }) => /criterion/.test(item.item_kind))).toEqual([]);
    expect(pass.items.filter(({ item }) => item.item_scope?.includes("criterion"))).toEqual([]);
  }
  const versions = ["analysis", "tasks", "plan", "brief", "assessment"].flatMap((kind) => oakridgeCatalogue(kind, "v1"));
  expect(new Set(versions.map((definition) => definition.extractor_version))).toEqual(new Set(["1"]));
});

test("a malformed task_ids field is an extraction failure, never an inferred link", () => {
  const pass = selectRevision({ findings: [{ task_ids: "T7", evidence: [] }] }, "assessment-1", oakridgeCatalogue("assessment", "v1"));
  expect(pass.items).toEqual([]);
  expect(pass.issues.map((issue) => issue.kind)).toEqual(["extraction_failed"]);
});

integration("one task stays one logical item through plan and brief revisions, cohorts, assessments and integration", async () => scratchDatabase(async (db) => {
  await fullRun(createFeed(db));
  expect((await logicalItems(db)).map((item) => item.logical_item_id)).toEqual([taskId("T7"), taskId("T8")]);
  const captured = await items(db);
  const shared = captured.filter((item) => item.logical_item_id === taskId("T7"));
  expect(shared.map((item) => [item.artifact_kind, item.revision_id, item.json_pointer]).sort()).toEqual([
    ["brief", "brief-alpha", "/acceptance_criteria/0"], ["brief", "brief-beta", "/acceptance_criteria/0"],
    ["plan", "plan-1", "/cohorts/0/acceptance_criteria/0"], ["plan", "plan-1", "/cohorts/1/acceptance_criteria/0"],
    ["plan", "plan-2", "/cohorts/0/acceptance_criteria/0"], ["plan", "plan-2", "/cohorts/1/acceptance_criteria/0"],
    ["tasks", "tasks-1", "/tasks/0"]]);
  const { logical_scope, relation_type } = oakridgeProfile.composite;
  expect(logical_scope).toBe(TASK_SCOPE);
  const assessed = await listRelatedOccurrences(db, tenant, taskId("T7"), relation_type, everything);
  expect(assessed.map((item) => [item.revision_id, item.json_pointer]).sort()).toEqual([["assessment-alpha", "/findings/0"], ["assessment-alpha", "/findings/1"],
    ["assessment-beta", "/findings/0"], ["integration-1", "/findings/0"]]);
  expect(assessed.every((item) => item.logical_item_id === null)).toBe(true);
}));

integration("findings and tasks link many to many, and an empty list links nothing", async () => scratchDatabase(async (db) => {
  await fullRun(createFeed(db));
  const edges = await relations(db);
  const findingAt = async (revision: string, path: string) => (await items(db)).find((item) => item.revision_id === revision && item.json_pointer === path)!.occurrence_id;
  const multi = await findingAt("assessment-alpha", "/findings/0");
  expect(edges.filter((edge) => edge.source_occurrence_id === multi).map((edge) => edge.target_logical_item_id)).toEqual([taskId("T7"), taskId("T8")]);
  const unlinked = await findingAt("assessment-alpha", "/findings/2");
  expect(edges.filter((edge) => edge.source_occurrence_id === unlinked)).toEqual([]);
  expect(edges.every((edge) => edge.target_occurrence_id === null)).toBe(true);
  expect(edges.every((edge) => edge.asserted_by === "producer_explicit")).toBe(true);
}));

integration("an unknown task stays visible, and resolves in place when the task arrives", async () => scratchDatabase(async (db) => {
  const feed = createFeed(db);
  const assessment = await fixtureBody("assessment");
  await feed.revision({ revision_id: "assessment-1", artifact_kind: "assessment", body: assessment });
  const before = await relations(db);
  expect(before.map((edge) => edge.unresolved_target_ref)).toContain(logicalReference(TASK_SCOPE, "T404"));
  expect(before.every((edge) => edge.target_logical_item_id === null)).toBe(true);
  const occurrences = (await items(db)).map((item) => item.occurrence_id).sort();
  await feed.revision({ revision_id: "tasks-1", artifact_kind: "tasks", body: await fixtureBody("tasks") });
  const after = await relations(db);
  expect(after.map((edge) => edge.relation_id)).toEqual(before.map((edge) => edge.relation_id));
  expect(after.filter((edge) => edge.unresolved_target_ref !== null).map((edge) => edge.unresolved_target_ref)).toEqual([logicalReference(TASK_SCOPE, "T404")]);
  expect(after.filter((edge) => edge.target_logical_item_id === taskId("T7"))).toHaveLength(2);
  const after_assessment = (await items(db)).filter((item) => item.artifact_kind === "assessment").map((item) => item.occurrence_id).sort();
  expect(after_assessment).toEqual(occurrences);
}));

integration("identical task ids in two runs stay separate, and a reference never crosses runs", async () => scratchDatabase(async (db) => {
  const feed = createFeed(db);
  await fullRun(feed);
  await feed.revision({ revision_id: "other-assessment", artifact_kind: "assessment", run_id: "run-2", body: { findings: [
    { task_ids: ["T7"], evidence: [] }] } });
  const unresolved = (await relations(db)).filter((edge) => edge.evidence_ref === "/findings/0/task_ids/0" && edge.unresolved_target_ref !== null);
  expect(unresolved).toHaveLength(1);
  await feed.revision({ revision_id: "other-tasks", artifact_kind: "tasks", run_id: "run-2", body: await fixtureBody("tasks") });
  expect((await logicalItems(db)).map((item) => item.logical_item_id)).toEqual([taskId("T7"), taskId("T8"), taskId("T7", "run-2"), taskId("T8", "run-2")]);
  const other = await listRelatedOccurrences(db, tenant, taskId("T7", "run-2"), "assesses", everything);
  expect(other.map((item) => item.revision_id)).toEqual(["other-assessment"]);
  expect((await listRelatedOccurrences(db, tenant, taskId("T7"), "assesses", everything)).map((item) => item.revision_id)).not.toContain("other-assessment");
}));

integration("a finding is captured and pinned before any task exists, and a late link changes nothing about it", async () => scratchDatabase(async (db) => {
  const [relevance] = OAKRIDGE_QUESTIONS;
  await registerQuestion(db, tenant, relevance!);
  await registerEvaluator(db, tenant, evaluator("human"));
  const configuration: CaptureConfiguration = { pins: [{ ...relevance!, evaluator_definition_ids: [evaluatorId("human")] }] };
  const feed = createFeed(db, tenant, configuration);
  await feed.revision({ revision_id: "analysis-1", artifact_kind: "analysis", body: await fixtureBody("analysis") });
  const [finding] = (await items(db)).filter((item) => item.item_kind === "finding");
  const pinned = await readOccurrenceEvidence(db, tenant, occurrenceIdOf(finding!.occurrence_id));
  expect(pinned).toHaveLength(1);
  await feed.revision({ revision_id: "tasks-1", artifact_kind: "tasks", body: await fixtureBody("tasks") });
  const declaration = { run_id: "run-1", source_revision_id: "analysis-1", item_path: finding!.json_pointer, link: { target: "logical_item" as const, type: "assesses" as const,
    target_scope: TASK_SCOPE, target_local_id: "T7", evidence_ref: "declaration:tasks-1:/findings/0" } };
  const first = await withTenant(db, tenant, (trx) => declareRelationInTransaction(trx, tenant, declaration));
  const repeated = await withTenant(db, tenant, (trx) => declareRelationInTransaction(trx, tenant, declaration));
  expect(first).toEqual(repeated);
  expect((await relations(db)).filter((edge) => edge.source_occurrence_id === finding!.occurrence_id).map((edge) => edge.target_logical_item_id)).toEqual([taskId("T7")]);
  expect((await items(db)).find((item) => item.occurrence_id === finding!.occurrence_id)).toEqual(finding);
  expect(await readOccurrenceEvidence(db, tenant, occurrenceIdOf(finding!.occurrence_id))).toEqual(pinned);
  const executions = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.evaluation_execution").select("execution_id").execute());
  expect(executions).toEqual([]);
  const missing = await withTenant(db, tenant, (trx) => declareRelationInTransaction(trx, tenant, { ...declaration, item_path: "/findings/9" }));
  expect(missing).toMatchObject({ ok: false, error: { operation: "declare_relation", entity_id: "analysis-1" } });
}));

integration("a declaration racing the task's capture still resolves to the task", async () => scratchDatabase(async (db) => {
  const feed = createFeed(db);
  await feed.revision({ revision_id: "analysis-1", artifact_kind: "analysis", body: await fixtureBody("analysis") });
  const [finding] = (await items(db)).filter((item) => item.item_kind === "finding");
  let releaseDelivery = (): void => undefined;
  const deliveryMayCommit = new Promise<void>((resolve) => { releaseDelivery = resolve; });
  let markHolding = (): void => undefined;
  const holding = new Promise<void>((resolve) => { markHolding = resolve; });
  const delivery = withTenant(db, tenant, async (trx) => {
    await lockSourceCursor(trx, tenant);
    await trx.insertInto("observation.logical_item").values({ ...tenant, logical_item_id: taskId("T7"), run_id: "run-1",
      scope: TASK_SCOPE, producer_local_id: "T7" }).execute();
    markHolding();
    await deliveryMayCommit;
  });
  await holding;
  let settled = false;
  const declared = withTenant(db, tenant, (trx) => declareRelationInTransaction(trx, tenant, { run_id: "run-1", source_revision_id: "analysis-1",
    item_path: finding!.json_pointer, link: { target: "logical_item", type: "assesses", target_scope: TASK_SCOPE, target_local_id: "T7",
      evidence_ref: "declaration:race" } })).finally(() => { settled = true; });
  for (let poll = 0; poll < 200 && !settled; poll += 1) {
    const waiting = await sql<{ count: number }>`SELECT count(*)::integer AS count FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'`.execute(db);
    if (waiting.rows[0]!.count > 0) break;
    await Bun.sleep(10);
  }
  releaseDelivery();
  await delivery;
  expect((await declared).ok).toBe(true);
  expect((await relations(db)).map((edge) => [edge.target_logical_item_id, edge.unresolved_target_ref])).toEqual([[taskId("T7"), null]]);
}));

integration("an assessment's subject links its build, and integration has none", async () => scratchDatabase(async (db) => {
  const feed = createFeed(db);
  const assessment = await fixtureBody("assessment");
  await feed.revision({ revision_id: "build-1", artifact_kind: "build_result", body: await fixtureBody("build-result") });
  await feed.revision({ revision_id: "assessment-1", artifact_kind: "assessment", subject_id: "build-1", body: assessment });
  await feed.revision({ revision_id: "integration-1", artifact_kind: "assessment", body: assessment });
  const subjects = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.item_relation").selectAll()
    .where("evidence_ref", "=", "artifact_revision.subject").execute());
  expect(subjects).toMatchObject([{ type: "assesses", unresolved_target_ref: null,
    target_logical_item_id: `oakridge:${tenant.namespace}:run-1:artifact_revision/build_result:build-1` }]);
}));
