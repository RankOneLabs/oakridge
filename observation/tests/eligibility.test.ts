import { expect, test } from "bun:test";
import { sql, type QueryId } from "kysely";
import { canonicalDigest } from "canonical-json";
import type { ItemOccurrenceId } from "../src/domain/identity";
import { eligibilityExclusionCounts, exclusionReason, provenanceEligibility, type EligibilityDecision } from "../src/grading/eligibility";
import { recordEligibility, readEligibility } from "../src/storage/eligibility-store";
import { registerGradingContext } from "../src/storage/grading-store";
import { withTenant } from "../src/storage/database";
import { oakridgeQuestions } from "../src/grading/catalogue/oakridge-questions";
import { loadRunCapture } from "../src/storage/run-capture-store";
import { tenant, question, evidence, evaluator, scratchGrading, captureProjectedFixture, pilotExpectations } from "./grading-fixture";

const integration = process.env.OAKRIDGE_TEST_DATABASE_URL ? test : test.skip;
integration("four exclusion causes persist as distinct typed eligibility rows", async () => scratchGrading(async (db, first) => {
  expect((await registerGradingContext(db, tenant, { question, evidence, evaluator: evaluator("code") })).ok).toBe(true);
  const ids = [first, ...[2, 3, 4].map((index) => {
    const digest = canonicalDigest(["eligibility-fixture", index]);
    if (!digest.ok) throw new Error(digest.error.detail);
    return digest.value as unknown as ItemOccurrenceId;
  })];
  await withTenant(db, tenant, async (trx) => {
    for (let index = 1; index < ids.length; index++) await sql`INSERT INTO observation.item_occurrence
      (producer, namespace, occurrence_id, revision_id, run_id, artifact_kind, schema_version, extractor_id,
       extractor_version, item_kind, item_selector, item_id_or_path, selected_value)
      VALUES (${tenant.producer}, ${tenant.namespace}, ${ids[index]}, 'rev-1', 'run-1', 'brief', '1',
        'fixture', '1', 'cohort_criterion', '/criterion', ${`criterion-${index + 1}`}, '{}'::jsonb)`.execute(trx);
  });
  const decisions: readonly EligibilityDecision[] = [
    { tag: "missing_evidence", payload: { kind: "uncited" } },
    { tag: "invalid_reference", payload: { kind: "dangling_citation", evidence_refs: ["task:absent"] } },
    { tag: "invalid_reference", payload: { kind: "unlinked" } },
    { tag: "missing_evidence", payload: { kind: "unevidenced" } },
  ];
  for (let index = 0; index < ids.length; index++) {
    const result = await recordEligibility(db, tenant, { ...decisions[index]!, producer: tenant.producer,
      namespace: tenant.namespace, subject_occurrence_id: ids[index]!, question_id: question.question_id,
      question_version: question.question_version });
    expect(result.ok).toBe(true);
  }
  const rows = await readEligibility(db, tenant, { run_id: "run-1", question_id: question.question_id, question_version: question.question_version, limit: 200, offset: 0 });
  expect(rows.items.map((row) => exclusionReason(row)?.kind).sort()).toEqual([...["uncited", "dangling_citation", "unlinked", "unevidenced"] as const].sort());
  expect(eligibilityExclusionCounts(rows.items)).toEqual({ uncited: 1, dangling_citation: 1, unlinked: 1,
    unevidenced: 1, skipped_budget: 0 });
}));

integration("a run capture transfers only relations sourced in that run", async () => scratchGrading(async (db) => {
  const body = { cohorts: [{ id: "cohort", decisions: [{ id: "decision", text: "source" }],
    acceptance_criteria: [{ id: "criterion", text: "Works", task_ids: [], decision_ids: ["decision"] }] }],
    acceptance_criteria: [], risks: [] };
  await captureProjectedFixture(db, { revision_id: "own-plan", artifact_kind: "plan", body });
  await captureProjectedFixture(db, { revision_id: "unrelated-plan", run_id: "unrelated-run", artifact_kind: "plan", body });
  const relation_queries = new Set<QueryId>();
  const relation_row_counts: number[] = [];
  const observed = db.withPlugin({
    transformQuery({ node, queryId }) {
      if (JSON.stringify(node).includes('"name":"item_relation"')) relation_queries.add(queryId);
      return node;
    },
    async transformResult({ result, queryId }) {
      if (relation_queries.has(queryId)) relation_row_counts.push(result.rows.length);
      return result;
    },
  });
  for (const [run_id, revision_id] of [["run-1", "own-plan"], ["unrelated-run", "unrelated-plan"]] as const) {
    const capture = await loadRunCapture(observed, tenant, run_id);
    if (!capture.ok) throw new Error(capture.error.detail);
    expect(capture.value.find((revision) => revision.revision_id === revision_id)?.items
      .find((item) => item.item_kind === "criterion")?.links).toHaveLength(1);
  }
  expect(relation_row_counts).toEqual([1, 1]);
}));

const expected = { definition_id: "a".repeat(64), artifact_schema_version: "schema-pinned" };
test("equal definition and artifact schema are supported", () => {
  expect(provenanceEligibility(expected, expected)).toEqual({ tag: "eligible" });
});
test("a different definition is explicitly inapplicable", () => {
  expect(provenanceEligibility(expected, { ...expected, definition_id: "old-definition" })).toEqual({
    tag: "inapplicable", payload: { reason: `Unsupported provenance: definition_id: recorded="old-definition", pinned="${expected.definition_id}"` } });
});
test("a different artifact schema is explicitly inapplicable", () => {
  expect(provenanceEligibility(expected, { ...expected, artifact_schema_version: "old-schema" })).toEqual({
    tag: "inapplicable", payload: { reason: 'Unsupported provenance: artifact_schema_version: recorded="old-schema", pinned="schema-pinned"' } });
});
for (const key of ["definition_id", "artifact_schema_version"] as const) {
  test(`absent recorded ${key} is explicitly inapplicable`, () => {
    expect(provenanceEligibility(expected, { ...expected, [key]: null })).toEqual({
      tag: "inapplicable", payload: { reason: `Unsupported provenance: ${key}: recorded=null, pinned=${JSON.stringify(expected[key])}` } });
  });
}
test("a well-formed different 64-hex definition is unsupported", () => {
  const recorded = "b".repeat(64);
  expect(provenanceEligibility(expected, { ...expected, definition_id: recorded })).toEqual({
    tag: "inapplicable", payload: { reason: `Unsupported provenance: definition_id: recorded="${recorded}", pinned="${expected.definition_id}"` } });
});

integration("supported captures derive distinct exclusions and refresh a cached exclusion without moving an eligible pin", async () => scratchGrading(async (db) => {
  const plan = await captureProjectedFixture(db, { revision_id: "plan-eligibility", artifact_kind: "plan", body: {
    cohorts: [{ id: "cohort", decisions: [{ id: "decision", text: "source" }], acceptance_criteria: [
      { id: "uncited", text: "no source", task_ids: [], decision_ids: [] },
      { id: "dangling", text: "bad source", task_ids: [], decision_ids: ["absent"] },
      { id: "supported", text: "has source", task_ids: [], decision_ids: ["decision"] },
    ] }], acceptance_criteria: [], risks: [],
  } });
  const brief = await captureProjectedFixture(db, { revision_id: "brief-eligibility", artifact_kind: "brief", body: {
    cohort_id: "cohort", decisions_made: [], approaches_rejected: [],
    acceptance_criteria: [{ id: "unlinked", text: "no plan link" }],
  }, recorded_at: "2026-11-01T01:00:00Z" });
  const analysis = await captureProjectedFixture(db, { revision_id: "analysis-eligibility", artifact_kind: "analysis", body: {
    findings: [{ id: "finding", description: "needs excerpt", severity: "info" }], requirements: [], proposed_spec_updates: [], risks: [],
  } });
  const catalogue = oakridgeQuestions(pilotExpectations);
  for (const id of ["analysis.finding_relevance", "plan.criterion_traceability", "brief.source_fidelity", "assessment.coverage"] as const) {
    const selected = catalogue[id].definition;
    expect((await registerGradingContext(db, tenant, { question: selected, evidence, evaluator: evaluator("code") })).ok).toBe(true);
    const [first, concurrent] = await Promise.all([readEligibility(db, tenant, { run_id: "run-1", question_id: id, question_version: "v1", limit: 200, offset: 0 }), readEligibility(db, tenant, { run_id: "run-1", question_id: id, question_version: "v1", limit: 200, offset: 0 })]);
    expect(concurrent).toEqual(first);
    expect(await readEligibility(db, tenant, { run_id: "run-1", question_id: id, question_version: "v1", limit: 200, offset: 0 })).toEqual(first);
  }
  const rows = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.evaluation_eligibility").selectAll().execute());
  expect(rows).toHaveLength(6);
  const occurrenceOf = (id: string) => [...plan, ...brief].find((item) => item.item_kind === "criterion" && item.producer_local_id === id)!.occurrence_id;
  expect(rows.find((row) => row.subject_occurrence_id === occurrenceOf("uncited"))).toMatchObject({ tag: "missing_evidence", payload: { kind: "uncited" } });
  expect(rows.find((row) => row.subject_occurrence_id === occurrenceOf("dangling"))).toMatchObject({ tag: "invalid_reference", payload: { kind: "dangling_citation" } });
  expect(rows.find((row) => row.subject_occurrence_id === occurrenceOf("unlinked"))).toMatchObject({ tag: "invalid_reference", payload: { kind: "unlinked" } });
  expect(rows.find((row) => row.subject_occurrence_id === occurrenceOf("supported"))).toMatchObject({ tag: "eligible" });
  expect(rows.find((row) => row.subject_occurrence_id === analysis.find((item) => item.item_kind === "finding")!.occurrence_id))
    .toMatchObject({ tag: "missing_evidence", payload: { kind: "missing_source" } });
  expect(rows.find((row) => row.question_id === "assessment.coverage"))
    .toMatchObject({ tag: "missing_evidence", payload: { kind: "unevidenced" } });
  expect((await recordEligibility(db, tenant, { ...tenant, subject_occurrence_id: occurrenceOf("uncited") as ItemOccurrenceId,
    question_id: catalogue["plan.criterion_traceability"].definition.question_id, question_version: "v1",
    tag: "eligible", payload: { evidence_set_id: "later-evidence" } })).ok).toBe(true);
  // The row is a cache of a derived value, so it refreshes; an eligible row still never moves,
  // because an assignment or execution pins the evidence set it names.
  // A cached exclusion refreshes, so one recorded before its evidence arrived does not outlive
  // the capture that settles it.
  const tagOf = (occurrence_id: string) => withTenant(db, tenant, (trx) =>
    trx.selectFrom("observation.evaluation_eligibility").select(["tag"])
      .where("subject_occurrence_id", "=", occurrence_id)
      .where("question_id", "=", "plan.criterion_traceability").executeTakeFirstOrThrow());
  expect((await recordEligibility(db, tenant, { ...tenant, subject_occurrence_id: occurrenceOf("dangling") as ItemOccurrenceId,
    question_id: catalogue["plan.criterion_traceability"].definition.question_id, question_version: "v1",
    tag: "missing_evidence", payload: { kind: "uncited" } })).ok).toBe(true);
  expect(await tagOf(occurrenceOf("dangling"))).toEqual({ tag: "missing_evidence" });
  // The eligible row recorded just above never moves: work pins the evidence set it names.
  expect((await recordEligibility(db, tenant, { ...tenant, subject_occurrence_id: occurrenceOf("uncited") as ItemOccurrenceId,
    question_id: catalogue["plan.criterion_traceability"].definition.question_id, question_version: "v1",
    tag: "invalid_reference", payload: { kind: "unlinked" } })).ok).toBe(true);
  expect(await tagOf(occurrenceOf("uncited"))).toEqual({ tag: "eligible" });
  const capture = await loadRunCapture(db, tenant, "run-1");
  expect(capture.ok && capture.value.every((revision) => revision.definition_id === "definition-1" && revision.artifact_schema_version === "1")).toBe(true);
}));

integration("an unsupported pilot capture records one inapplicable decision without reading its old body", async () => scratchGrading(async (db) => {
  await captureProjectedFixture(db, { revision_id: "old-plan", artifact_kind: "plan", body: {
    cohorts: [{ id: "cohort", decisions: [], acceptance_criteria: [{ id: "old", text: "old", task_ids: [], decision_ids: [] }] }],
    acceptance_criteria: [], risks: [],
  } });
  await withTenant(db, tenant, (trx) => sql`UPDATE observation.source_revision SET definition_id = 'old-definition',
    body = '{"obsolete_layout":true}'::jsonb WHERE revision_id = 'old-plan'`.execute(trx));
  const selected = oakridgeQuestions(pilotExpectations)["plan.criterion_traceability"].definition;
  expect((await registerGradingContext(db, tenant, { question: selected, evidence, evaluator: evaluator("code") })).ok).toBe(true);
  const guarded = db.withPlugin({ transformQuery: ({ node }) => {
    if (JSON.stringify(node).includes('"name":"body"')) throw new Error("unsupported capture body was read");
    return node;
  }, transformResult: async ({ result }) => result });
  const first = await readEligibility(guarded, tenant, { run_id: "run-1", question_id: selected.question_id, question_version: selected.question_version, limit: 200, offset: 0 });
  expect(first.items).toHaveLength(1);
  expect(first.items[0]).toMatchObject({ tag: "inapplicable", payload: {
    reason: 'Unsupported provenance: definition_id: recorded="old-definition", pinned="definition-1"' } });
  expect(await readEligibility(guarded, tenant, { run_id: "run-1", question_id: selected.question_id, question_version: selected.question_version, limit: 200, offset: 0 })).toEqual(first);
  expect(await withTenant(db, tenant, (trx) => trx.selectFrom("observation.evaluation_eligibility").selectAll().execute())).toHaveLength(1);
}));

integration("eligibility pages bound derivation and reads by run, revision and question in stable order", async () => scratchGrading(async (db) => {
  const { createApp } = await import("../src/http/app");
  const selected = oakridgeQuestions(pilotExpectations)["plan.criterion_traceability"].definition;
  expect((await registerGradingContext(db, tenant, { question: selected, evidence, evaluator: evaluator("code") })).ok).toBe(true);
  const body = { cohorts: [{ id: "cohort", decisions: [{ id: "decision", text: "source" }],
    acceptance_criteria: [0, 1, 2, 3, 4].map((index) => ({ id: `criterion-${index}`, text: "Works", task_ids: [], decision_ids: ["decision"] })) }],
    acceptance_criteria: [], risks: [] };
  const captured = await captureProjectedFixture(db, { revision_id: "page-plan", artifact_kind: "plan", body });
  await captureProjectedFixture(db, { run_id: "other-run", revision_id: "other-page-plan", artifact_kind: "plan", body });
  const app = createApp({ db, credentials: { ingest: [], read: [{ ...tenant, token: "read" }] } });
  const path = `/v1/evaluation-eligibility?run_id=run-1&question_id=${selected.question_id}&question_version=${selected.question_version}`;
  const get = (url: string) => app.request(url, { headers: { authorization: "Bearer read" } });
  const first = await (await get(`${path}&limit=3&offset=0`)).json();
  expect(first.items).toHaveLength(3);
  expect(first.total).toBe(5);
  const derived = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.evaluation_eligibility").selectAll().execute());
  expect(derived).toHaveLength(3);
  const second = await (await get(`${path}&limit=3&offset=3`)).json();
  expect(second.items).toHaveLength(2);
  expect(second.total).toBe(5);
  const ids = [...first.items, ...second.items].map((row: { subject_occurrence_id: string }) => row.subject_occurrence_id);
  expect(new Set(ids).size).toBe(5);
  expect(ids).toEqual(captured.filter((item) => item.item_kind === "criterion").map((item) => item.occurrence_id).sort());
  expect((await (await get(`${path}&limit=3&offset=0`)).json()).items).toEqual(first.items);
  await captureProjectedFixture(db, { revision_id: "page-successor", artifact_kind: "plan", body: {
    ...body, cohorts: [{ ...body.cohorts[0]!, acceptance_criteria: [body.cohorts[0]!.acceptance_criteria[0]!] }],
  }, recorded_at: "2026-11-01T01:00:00Z", predecessor_id: "page-plan" });
  expect((await (await get(`${path}&revision_id=page-plan`)).json()).total).toBe(5);
  const successor = await (await get(`${path}&revision_id=page-successor`)).json();
  expect(successor.total).toBe(1);
  expect(ids).not.toContain(successor.items[0].subject_occurrence_id);
  expect((await get(path.replace("run_id=run-1&", ""))).status).toBe(400);
  for (const pagination of ["limit=0", "limit=201", "limit=1.5", "offset=-1", "offset=1.5", "offset=9007199254740992"]) {
    const response = await get(`${path}&${pagination}`);
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("invalid_pagination");
  }
  expect((await (await get(path.replace("run-1", "unknown-run"))).json())).toMatchObject({ items: [], total: 0 });
}));

integration("a criterion read before its assessment was captured becomes eligible once it arrives", async () => scratchGrading(async (db) => {
  const brief = await captureProjectedFixture(db, { revision_id: "brief-late", artifact_kind: "brief", body: {
    cohort_id: "cohort", decisions_made: [], approaches_rejected: [],
    acceptance_criteria: [{ id: "criterion", text: "Works" }],
  }, recorded_at: "2026-11-01T01:00:00Z" });
  const question = oakridgeQuestions(pilotExpectations)["assessment.coverage"].definition;
  expect((await registerGradingContext(db, tenant, { question, evidence, evaluator: evaluator("code") })).ok).toBe(true);
  const selection = { run_id: "run-1", question_id: "assessment.coverage", question_version: "v1", limit: 200, offset: 0 };
  // The read happens first, while no assessment covers the brief yet.
  const early = await readEligibility(db, tenant, selection);
  expect(early.items.map((row) => row.tag)).toEqual(["missing_evidence"]);
  const subject = brief.find((item) => item.item_kind === "criterion")!.occurrence_id;
  await captureProjectedFixture(db, { revision_id: "assessment-late", artifact_kind: "assessment",
    body: { head_sha: "reviewed-commit", findings: [{ criterion_id: "criterion", evidence: [] }] },
    recorded_at: "2026-11-01T02:00:00Z" });
  // The early read must not have frozen the exclusion.
  const settled = await readEligibility(db, tenant, selection);
  expect(settled.items.find((row) => row.subject_occurrence_id === subject)?.tag).toBe("eligible");
}));
