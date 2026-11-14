import { expect, test } from "bun:test";
import { logicalReference } from "../src/projection/relations";
import { declaredAnalysisLinks } from "../src/producers/oakridge/declarations";
import { TASK_SCOPE } from "../src/producers/oakridge/catalogue";
import { startsReconciliation } from "../src/http/sources";
import type { SourceEventOutcome } from "../src/ingest/cursor";
import { readRelationDeclarations, readUnmappedSourceEvents } from "../src/storage/capture-store";
import { withTenant, type Database, type TenantScope } from "../src/storage/database";
import { listRunItems } from "../src/storage/projection-store";
import { createFeed, fixtureBody, integration, scratchDatabase, tenant, type Feed } from "./grading-fixture";

const provenance = { format: "observation.source-event/v1", definition_id: "definition-1", artifact_schema_version: null } as const;
const everything = { limit: 200, offset: 0 };
interface EntryFields { readonly source_revision_id: string; readonly item_path: string; readonly task_ids: readonly string[] }
let sequence = 0;
const declared = (entries: readonly EntryFields[], run_id = "run-1", tasks_revision_id = "tasks-1"): SourceEventOutcome => ({ ...provenance,
  kind: "relation_declaration", event_kind: "analysis_links_declared", run_id, event_id: `declaration:${++sequence}`,
  declaration: { run_id, tasks_revision_id, entries: entries.map((entry) => ({ ...entry, task_ids: [...entry.task_ids] })) } });
const edges = (db: Database, scope: TenantScope = tenant) => withTenant(db, scope, (trx) => trx.selectFrom("observation.item_relation").selectAll()
  .where("producer", "=", scope.producer).where("namespace", "=", scope.namespace).where("evidence_ref", "like", "analysis_link_declaration:%").orderBy("evidence_ref").execute());
async function capturedAnalysis(feed: Feed, run_id = "run-1", revision_id = "analysis-1"): Promise<void> {
  await feed.revision({ revision_id, artifact_kind: "analysis", run_id, body: await fixtureBody("analysis") });
}

test("a declaration is the explicit entries, and each task id one edge; nothing else is read", () => {
  const body = { run_id: "run-1", tasks_revision_id: "tasks-1", entries: [{ source_revision_id: "analysis-1", item_path: "/findings/0", task_ids: ["T7", "T8"] }],
    requirement_ids: ["R1"], feedback: "T9 should link" };
  const decoded = declaredAnalysisLinks(body, "run-1");
  expect(decoded).toEqual({ ok: true, value: ["T7", "T8"].map((target_local_id) => ({ run_id: "run-1", source_revision_id: "analysis-1", item_path: "/findings/0",
    link: { target: "logical_item", type: "assesses", target_scope: TASK_SCOPE, target_local_id, evidence_ref: `analysis_link_declaration:tasks-1:${target_local_id}` } })) });
});
for (const [name, body] of [["no entries list", { run_id: "run-1", tasks_revision_id: "tasks-1" }], ["no tasks revision", { run_id: "run-1", entries: [] }],
  ["a blank task id", { run_id: "run-1", tasks_revision_id: "tasks-1", entries: [{ source_revision_id: "a", item_path: "/findings/0", task_ids: [""] }] }],
  ["another run", { run_id: "run-2", tasks_revision_id: "tasks-1", entries: [] }]] as const)
  test(`a declaration with ${name} decodes to nothing`, () => { expect(declaredAnalysisLinks(body as never, "run-1").ok).toBe(false); });
test("a declaration never starts a reconciliation, so a link cannot admit, retry or send anything", () => {
  expect(startsReconciliation(declared([]))).toBe(false);
});

integration("a late link adds only an edge: the item, its neighbours and every grading row stay as captured", async () => scratchDatabase(async (db) => {
  const feed = createFeed(db);
  await capturedAnalysis(feed);
  await feed.revision({ revision_id: "tasks-1", artifact_kind: "tasks", body: await fixtureBody("tasks") });
  const items = async () => (await listRunItems(db, tenant, "run-1", everything)).items;
  const before = await items();
  await feed.send(declared([{ source_revision_id: "analysis-1", item_path: "/findings/0", task_ids: ["T7", "T404"] }]));
  expect(await items()).toEqual(before);
  const linked = await edges(db);
  expect(linked.map((edge) => [edge.target_logical_item_id !== null, edge.unresolved_target_ref])).toEqual([[false, logicalReference(TASK_SCOPE, "T404")], [true, null]]);
  expect(linked.every((edge) => edge.asserted_by === "producer_explicit" && edge.type === "assesses")).toBe(true);
  const [stored] = await readRelationDeclarations(db, tenant, "run-1");
  expect(stored?.projection).toEqual({ relation_ids: ["T7", "T404"].map((task) => linked.find((edge) => edge.evidence_ref.endsWith(`:${task}`))!.relation_id), unresolved_sources: [] });
  expect((await readUnmappedSourceEvents(db, tenant, { limit: 200, offset: 0 })).items).toEqual([]);
}));

integration("a repeated statement is one relation, and a replay keeps its first identity", async () => scratchDatabase(async (db) => {
  const feed = createFeed(db);
  await capturedAnalysis(feed);
  const entries = [{ source_revision_id: "analysis-1", item_path: "/findings/0", task_ids: ["T7"] }];
  await feed.send(declared(entries));
  const first = await edges(db);
  await feed.send(declared(entries));
  expect(await edges(db)).toEqual(first);
  await feed.send(declared(entries, "run-1", "tasks-2"));
  expect((await edges(db)).map((edge) => edge.evidence_ref)).toEqual(["analysis_link_declaration:tasks-1:T7", "analysis_link_declaration:tasks-2:T7"]);
}));

integration("an unknown target stays visible and resolves in place when the task arrives", async () => scratchDatabase(async (db) => {
  const feed = createFeed(db);
  await capturedAnalysis(feed);
  await feed.send(declared([{ source_revision_id: "analysis-1", item_path: "/findings/0", task_ids: ["T7"] }]));
  const [before] = await edges(db);
  expect(before).toMatchObject({ unresolved_target_ref: logicalReference(TASK_SCOPE, "T7"), target_logical_item_id: null });
  await feed.revision({ revision_id: "tasks-1", artifact_kind: "tasks", body: await fixtureBody("tasks") });
  const [after] = await edges(db);
  expect(after).toMatchObject({ relation_id: before!.relation_id, unresolved_target_ref: null, target_logical_item_id: `oakridge:${tenant.namespace}:run-1:task:T7` });
}));

integration("a source held by another run, or by no one, projects no edge and stays visible with the cursor advanced", async () => scratchDatabase(async (db) => {
  const feed = createFeed(db);
  await capturedAnalysis(feed, "run-2", "analysis-2");
  const entries = [{ source_revision_id: "analysis-2", item_path: "/findings/0", task_ids: ["T7"] },
    { source_revision_id: "analysis-absent", item_path: "/findings/0", task_ids: ["T7"] }];
  const cursor = await feed.send(declared(entries));
  expect(await edges(db)).toEqual([]);
  const [stored] = await readRelationDeclarations(db, tenant, "run-1");
  expect(stored?.projection.unresolved_sources.map((source) => source.source_revision_id)).toEqual(["analysis-2", "analysis-absent"]);
  expect(stored?.projection.relation_ids).toEqual([]);
  expect((await withTenant(db, tenant, (trx) => trx.selectFrom("observation.source_event_cursor").select("event_id").executeTakeFirstOrThrow())).event_id).toBe(cursor.id);
}));

integration("the same address in another tenant is another item, and a read sees only its own tenant's declarations", async () => scratchDatabase(async (db) => {
  const other: TenantScope = { producer: "oakridge", namespace: "other-tenant" };
  await capturedAnalysis(createFeed(db));
  const foreign = createFeed(db, other);
  await capturedAnalysis(foreign);
  await foreign.send(declared([{ source_revision_id: "analysis-1", item_path: "/findings/0", task_ids: ["T7"] }]));
  expect(await edges(db)).toEqual([]);
  expect(await edges(db, other)).toHaveLength(1);
  expect(await readRelationDeclarations(db, tenant, "run-1")).toEqual([]);
  expect(await readRelationDeclarations(db, other, "run-1")).toHaveLength(1);
}));

integration("a declaration the profile cannot read is unmapped, visible, and does not stop the feed", async () => scratchDatabase(async (db) => {
  const feed = createFeed(db);
  await capturedAnalysis(feed);
  await feed.send({ ...provenance, kind: "relation_declaration", event_kind: "analysis_links_declared", run_id: "run-1", event_id: "malformed",
    declaration: { run_id: "run-1", entries: "T7" } });
  expect(((await readUnmappedSourceEvents(db, tenant, { limit: 200, offset: 0 })).items).map((outcome) => [outcome.event_id, outcome.kind])).toEqual([["malformed", "unmapped"]]);
  expect(await edges(db)).toEqual([]);
  await feed.send(declared([{ source_revision_id: "analysis-1", item_path: "/findings/0", task_ids: ["T7"] }]));
  expect(await edges(db)).toHaveLength(1);
}));

integration("recorded brief targets never substitute later revisions and resolve when the exact capture arrives", async () => scratchDatabase(async (db) => {
  const feed = createFeed(db);
  const brief = (description: string) => ({ cohort_id: "alpha", decisions_made: [], approaches_rejected: [], build_items: [
    { id: "B1", description, task_ids: ["T1", "T2"], decision_ids: [], verification: "test" }
  ] });
  const finding = { findings: [{ subjects: [{ kind: "build_item", id: "B1", cohort_id: "alpha" }], evidence: [] }] };
  await feed.revision({ revision_id: "later-brief", artifact_kind: "brief", body: brief("Later instructions") });
  await feed.revision({ revision_id: "assessment", artifact_kind: "assessment", body: finding, brief_revision_ids: ["recorded-brief"] });
  await feed.revision({ revision_id: "unresolved-assessment", artifact_kind: "assessment", body: finding, brief_revision_ids: null });
  const relations = () => withTenant(db, tenant, (trx) => trx.selectFrom("observation.item_relation as edge")
    .innerJoin("observation.item_occurrence as item", (join) => join.onRef("item.producer", "=", "edge.producer")
      .onRef("item.namespace", "=", "edge.namespace").onRef("item.occurrence_id", "=", "edge.source_occurrence_id"))
    .select(["item.revision_id", "edge.target_occurrence_id", "edge.unresolved_target_ref"])
    .where("edge.producer", "=", tenant.producer).where("edge.namespace", "=", tenant.namespace).where("edge.type", "=", "assesses").orderBy("item.revision_id").execute());
  expect((await relations()).every((edge) => edge.unresolved_target_ref !== null)).toBe(true);
  await feed.revision({ revision_id: "recorded-brief", artifact_kind: "brief", body: brief("Original instructions") });
  const resolved = await relations();
  expect(resolved[0]?.unresolved_target_ref).toBeNull();
  expect(resolved[1]?.unresolved_target_ref).not.toBeNull();
  const target = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.item_occurrence").select("revision_id")
    .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace).where("occurrence_id", "=", resolved[0]!.target_occurrence_id!).executeTakeFirstOrThrow());
  expect(target.revision_id).toBe("recorded-brief");
}));

integration("late build-item and task resolution pins each newly reached subject once under the current configuration", async () => scratchDatabase(async (db) => {
  const { planRegistration, parseGradingDefinitions } = await import("../src/grading/configuration");
  const { oakridgeGradingRegistry } = await import("./grading-fixture");
  const { readOccurrenceEvidence } = await import("../src/storage/captured-evidence-store");
  const raw = await Bun.file(new URL("./fixtures/grading-definitions.json", import.meta.url)).json();
  const parsed = parseGradingDefinitions(raw, oakridgeGradingRegistry);
  if (!parsed.ok) throw new Error(parsed.error.detail);
  const original = parsed.value.filter((d) => d.id === "assessment_finding.correctness").map((d) => ({ ...d, evaluators: [] }));
  const first = planRegistration(original, oakridgeGradingRegistry);
  const second = planRegistration(original.map((d) => ({ ...d, question: { ...d.question, text: "Changed question" } })), oakridgeGradingRegistry);
  if (!first.ok || !second.ok) throw new Error("registration failed");
  const { registerDefinitions } = await import("../src/storage/grading-store");
  await registerDefinitions(db, tenant, first.value);
  await registerDefinitions(db, tenant, second.value);
  const feed = createFeed(db, tenant, first.value.capture);
  await feed.revision({ revision_id: "tasks-1", artifact_kind: "tasks", body: { tasks: [{ id: "T1", description: "One", requirement_ids: [] }] } });
  await feed.revision({ revision_id: "assessment", artifact_kind: "assessment", brief_revision_ids: ["brief"], body: { findings: [{ subjects: [{ kind: "build_item", id: "B1" }], evidence: [] }] } });
  const occurrence = (await listRunItems(db, tenant, "run-1", everything)).items.find((item) => item.item_kind === "assessment_finding")!;
  expect(await readOccurrenceEvidence(db, tenant, occurrence.occurrence_id as import("../src/domain/identity").ItemOccurrenceId)).toEqual([]);
  await feed.revision({ revision_id: "brief", artifact_kind: "brief", body: { cohort_id: "alpha", decisions_made: [], approaches_rejected: [], build_items: [{ id: "B1", description: "Both tasks", task_ids: ["T1", "T2"], decision_ids: [], verification: "test" }] } }, second.value.capture);
  const read = () => readOccurrenceEvidence(db, tenant, occurrence.occurrence_id as import("../src/domain/identity").ItemOccurrenceId);
  expect((await read()).map((set) => [set.task_id?.split(":").at(-1), set.question_version])).toEqual([["T1", second.value.questions[0]!.question_version]]);
  await feed.revision({ revision_id: "tasks-2", artifact_kind: "tasks", body: { tasks: [{ id: "T2", description: "Two", requirement_ids: [] }] } });
  expect((await read()).map((set) => [set.task_id?.split(":").at(-1), set.question_version])).toEqual([["T1", second.value.questions[0]!.question_version], ["T2", first.value.questions[0]!.question_version]]);
}));
