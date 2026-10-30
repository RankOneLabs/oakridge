import { instructionDigest } from "../src/grading/evaluator";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolve } from "node:path";
import { expect, test } from "bun:test";
import { Client } from "pg";
import { canonicalDigest } from "../src/canonical/canonical-json";
import type { JsonValue } from "../src/domain/primitives";
import type { ExportManifest, ExportRecord } from "../src/export/manifest";
import { membershipDigest } from "../src/export/manifest";
import { createApp } from "../src/http/app";
import { openDatabase, withTenant, type Database } from "../src/storage/database";
import { migrateEmptyDatabase } from "../src/storage/migrate";
import { listRunItems, readLineage, recordHumanRelation } from "../src/storage/projection-store";
import { buildGraph } from "./dependency-graph";
import { dropScratchDatabase } from "./database-fixture";

const serverUrl = process.env.OAKRIDGE_TEST_DATABASE_URL;
const integration = serverUrl ? test : test.skip;
test("vertical slice requires OAKRIDGE_TEST_DATABASE_URL", () => {
  expect(serverUrl).toBeTruthy();
});
const tenant = { producer: "oakridge", namespace: "run-slice" };
const credentials = { ingest: [{ ...tenant, token: "ingest-fixture" }], read: [{ ...tenant, token: "read-fixture" }],
  grade: [{ ...tenant, token: "grade-fixture", reviewer_id: "operator" }] };
const fixtureRoot = new URL("../fixtures/oakridge/run-slice/", import.meta.url);

interface EventMetadata { readonly id: string; readonly commit_txid: string; readonly created_at: string;
  readonly run_id: string; readonly unit_id: string | null }
interface RevisionEventRow extends EventMetadata { readonly unit_id: string; readonly payload: { readonly kind: "revision_published";
  readonly unit: string; readonly artifact: string; readonly body: JsonValue;
  readonly by: string | null; readonly predecessor: string | null; readonly subject: string | null } }
interface LaunchEventRow extends EventMetadata { readonly payload: { readonly kind: "launched"; readonly input: JsonValue } }
interface OperatorEventRow extends EventMetadata { readonly payload: { readonly kind: "operator_decided" } }
type EventRow = RevisionEventRow | LaunchEventRow | OperatorEventRow;
const isRevision = (row: EventRow): row is RevisionEventRow => row.payload.kind === "revision_published";
const isLaunch = (row: EventRow): row is LaunchEventRow => row.payload.kind === "launched";
interface EventFixture { readonly run_id: string; readonly rows: readonly EventRow[] }
interface DecisionFixture { readonly pre_existing: { readonly id: string; readonly created_at: string;
  readonly run_id: string; readonly unit_id: string; readonly decision_id: string; readonly effect: string; readonly payload: {
    readonly unit: string; readonly review: string; readonly target: string; readonly decision: string;
    readonly payload: JsonValue } } }
const readFixture = async (file: string): Promise<JsonValue> => Bun.file(new URL(file, fixtureRoot)).json() as Promise<JsonValue>;
const digest = (value: JsonValue): string => {
  const result = canonicalDigest(value);
  if (!result.ok) throw new Error(result.error.detail);
  return result.value;
};
async function scratch(work: (db: Database) => Promise<void>): Promise<void> {
  if (!serverUrl) throw new Error("OAKRIDGE_TEST_DATABASE_URL is required");
  const admin = new Client({ connectionString: serverUrl });
  const name = `observation_slice_${randomBytes(6).toString("hex")}`;
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(serverUrl); url.pathname = `/${name}`;
    const db = openDatabase(url.href);
    try { await migrateEmptyDatabase(db); await work(db); }
    finally { await db.destroy(); await dropScratchDatabase(admin, name); }
  } finally { await admin.end(); }
}

test("checked-in event fixture preserves observed transaction order and explicit current-contract criterion IDs", async () => {
  const events = await readFixture("events.json") as unknown as EventFixture;
  const plan = await readFixture("plan-revision.json") as unknown as { cohorts: { acceptance_criteria: { id: string }[] }[] };
  const brief = await readFixture("brief-revision.json") as unknown as { acceptance_criteria: { id: string }[] };
  const assessment = await readFixture("assessment-revision.json") as unknown as { findings: { criterion_id: string | null }[] };
  expect(events.rows.map((row) => BigInt(row.commit_txid))).toEqual([...events.rows]
    .sort((a, b) => Number(BigInt(a.commit_txid) - BigInt(b.commit_txid))).map((row) => BigInt(row.commit_txid)));
  expect(events.rows.map((row) => row.payload.kind)).toEqual([
    "launched", "revision_published", "operator_decided", "revision_published", "revision_published"]);
  expect(events.rows.every((row) => row.run_id === events.run_id)).toBe(true);
  expect(events.rows.filter(isRevision).map((row) => row.payload.artifact)).toEqual(["plan", "brief", "assessment"]);
  expect(new Set(plan.cohorts[0]!.acceptance_criteria.map((item) => item.id)).size).toBeGreaterThanOrEqual(2);
  expect(brief.acceptance_criteria.map((item) => item.id)).toEqual(plan.cohorts[0]!.acceptance_criteria.map((item) => item.id));
  expect(assessment.findings[0]?.criterion_id).toBe(brief.acceptance_criteria[0]?.id);
});

test("the suite's reachable modules import no hosted grader, Langfuse, JIG or Assay package", () => {
  const here = import.meta.dir;
  const graph = buildGraph([resolve(here, "vertical-slice.test.ts"), resolve(here, "failure-cases.test.ts")]);
  const forbidden = /^(?:@langfuse\/|langfuse(?:\/|$)|@openai\/|openai(?:\/|$)|@anthropic-ai\/|anthropic(?:\/|$)|@google\/generative-ai(?:\/|$)|jig(?:\/|$)|assay(?:\/|$))/i;
  expect([...graph.values()].flatMap((node) => node.packages.filter((name) => forbidden.test(name)))).toEqual([]);
});

integration("an Oakridge revision flows through ingest, selection, lineage, independent grading, backfill, history and frozen export", async () => {
  const exportRoot = await mkdtemp(join(tmpdir(), "observation-slice-"));
  try { await scratch(async (db) => {
    const events = await readFixture("events.json") as unknown as EventFixture;
    const decision = (await readFixture("operator-decisions.json") as unknown as DecisionFixture).pre_existing;
    const app = createApp({ db, credentials, exportRoot });
    const ingestHeaders = { authorization: "Bearer ingest-fixture", "content-type": "application/json" };
    const readHeaders = { authorization: "Bearer read-fixture" };
    const gradeHeaders = { authorization: "Bearer grade-fixture", "content-type": "application/json" };
    const revisionId = (row: RevisionEventRow) => `${row.payload.unit}:${row.payload.artifact}:1`;
    let cursor = { commit_txid: "0", id: "" };
    const deliver = async (row: EventRow, outcome: JsonValue): Promise<void> => {
      const next = { commit_txid: row.commit_txid, id: row.id };
      const response = await app.request("/v1/sources/oakridge/events", { method: "POST",
        headers: ingestHeaders, body: JSON.stringify({ previous: cursor, cursor: next, outcome }) });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ cursor: next });
      cursor = next;
    };
    const ingest = async (row: RevisionEventRow): Promise<void> => {
      const body = row.payload.body;
      const revision = {
          format: "observation.artifact-revision/v1", source: { ...tenant,
            revision_id: `${tenant.producer}:${tenant.namespace}:${revisionId(row)}`,
            run_id: row.run_id, unit_id: row.unit_id, artifact_kind: row.payload.artifact,
            artifact_schema_version: "development-v1", definition_bundle: { id: "development", digest: "fixture-bundle" },
            predecessor_id: row.payload.predecessor, subject_id: row.payload.subject, by_id: row.payload.by },
          recorded_at: row.created_at, body, body_digest: digest(body),
        };
      await deliver(row, { format: "observation.source-event/v1", kind: "artifact_revision",
        event_kind: "revision_published", run_id: row.run_id, event_id: row.id,
        definition_bundle: { id: "development", digest: "fixture-bundle" },
        artifact_schema_version: "development-v1", revision } as unknown as JsonValue);
    };

    // (a-c) Ingest and select the L0 revisions, then follow the producer's unchanged criterion id.
    const [planBody, briefBody, assessmentBody] = await Promise.all([
      readFixture("plan-revision.json"), readFixture("brief-revision.json"), readFixture("assessment-revision.json")]);
    const [planRow, briefRow, assessmentRow] = events.rows.filter(isRevision);
    expect([planRow?.payload.body, briefRow?.payload.body, assessmentRow?.payload.body]).toEqual([
      planBody, briefBody, assessmentBody]);
    const launch = events.rows.find(isLaunch);
    if (!launch) throw new Error("missing launch event");
    await deliver(launch, { format: "observation.source-event/v1", kind: "run_input",
      event_kind: "launched", run_id: launch.run_id, event_id: launch.id,
      definition_bundle: { id: "development", digest: "fixture-bundle" },
      artifact_schema_version: null, input: launch.payload.input,
      input_schema_version: "development-v1" } as JsonValue);
    await ingest(planRow!);
    // The observed operator row predates capture and enters through backfill below.
    await ingest(briefRow!);
    await ingest(assessmentRow!);
    expect(cursor).toEqual({ commit_txid: assessmentRow!.commit_txid, id: assessmentRow!.id });
    const page = await listRunItems(db, tenant, events.run_id, { limit: 100, offset: 0 });
    const item = (revision: string, kind: string, id?: string) => {
      const found = page.items.find((entry) => entry.revision_id === revision && entry.item_kind === kind
        && (id === undefined || entry.producer_local_id === id));
      if (!found) throw new Error(`missing ${revision} ${kind} ${id ?? ""}`);
      return found;
    };
    const planCriterion = item(revisionId(planRow!), "criterion", "criterion-lineage");
    const briefCriterion = item(revisionId(briefRow!), "criterion", "criterion-lineage");
    const finding = page.items.find((entry) => entry.revision_id === revisionId(assessmentRow!)
      && entry.item_kind === "assessment_finding" && entry.item_id_or_path === "/findings/0");
    if (!finding) throw new Error("missing linked assessment finding");
    const legacy = item(revisionId(planRow!), "plan_wide_criterion");
    expect(legacy.item_id_or_path).toBe("/acceptance_criteria/0");
    expect(legacy.logical_item_id).toBeNull();
    for (const [row, expected] of [[planRow!, planBody], [briefRow!, briefBody], [assessmentRow!, assessmentBody]] as const) {
      const response = await app.request(`/v1/source-revisions/${encodeURIComponent(`${tenant.producer}:${tenant.namespace}:${revisionId(row)}`)}`,
        { headers: readHeaders });
      expect(response.status).toBe(200);
      expect((await response.json()).body).toEqual(expected);
    }
    const producerLineage = await readLineage(db, tenant, finding.occurrence_id, { limit: 100, offset: 0 });
    expect(producerLineage?.edges.some((edge) => edge.source_occurrence_id === finding.occurrence_id
      && edge.target_occurrence_id === briefCriterion.occurrence_id && edge.asserted_by === "producer_explicit")).toBe(true);
    expect(producerLineage?.edges.some((edge) => edge.source_occurrence_id === briefCriterion.occurrence_id
      && edge.target_occurrence_id === planCriterion.occurrence_id && edge.asserted_by === "producer_explicit")).toBe(true);
    expect((await readLineage(db, tenant, legacy.occurrence_id, { limit: 100, offset: 0 }))?.edges).toEqual([]);

    // (d) The legacy path acquires a relation only by a human assertion.
    await recordHumanRelation(db, tenant, briefCriterion.occurrence_id, legacy.occurrence_id,
      "split_from", "operator:fixture-split");
    const connected = await readLineage(db, tenant, finding.occurrence_id, { limit: 100, offset: 0 });
    expect(connected?.edges.some((edge) => edge.type === "split_from" && edge.asserted_by === "human"
      && edge.target_occurrence_id === legacy.occurrence_id)).toBe(true);
    expect((await readLineage(db, tenant, legacy.occurrence_id, { limit: 100, offset: 0 }))?.edges
      .some((edge) => edge.asserted_by === "human")).toBe(true);

    // (e) The shipped deterministic and stub-model runners grade the same pinned occurrence independently.
    const question = { question_id: "criterion-check", question_version: "1", target_item_kinds: ["criterion"],
      input_recipe: { expected: "matching evidence" }, response_kind: "boolean", allowed_values: null,
      missing_evidence_policy: "fail", abstain_semantics: "insufficient", unclear_semantics: "ambiguous",
      interpretation_caveats: "fixture check", requires_repository_snapshot: false };
    const evidence = { evidence_set_id: "slice-evidence", references: [{ ref: "fixture:plan", kind: "public",
      content: "matching evidence", digest: null }], is_incomplete: false, incompleteness_reason: null };
    const evaluator = (kind: "code" | "model" | "human") => ({ evaluator_definition_id: `slice-${kind}`, kind,
      backend_kind: "local", provider: `fixture-${kind}`, model: kind === "model" ? "pinned" : null,
      instruction_text: "fixture-prompt", prompt_digest: instructionDigest("fixture-prompt"), config_digest: "fixture-config", runtime_revision: "1",
      cost_metadata: null, seed: null, attempt_controls: kind === "model"
        ? { answer: { state: "answered", kind: "boolean", value: false } } : null });
    const identity = { subject_occurrence_id: briefCriterion.occurrence_id, evidence_set_id: evidence.evidence_set_id,
      question_id: question.question_id, question_version: question.question_version,
      config_digest: "fixture-config", attempt_label: "first" };
    const evaluate = async (kind: "code" | "model", runner: "deterministic" | "stub_model") => {
      const response = await app.request("/v1/evaluations", { method: "POST", headers: gradeHeaders,
        body: JSON.stringify({ identity: { ...identity, evaluator_definition_id: `slice-${kind}` },
          context: { question, evidence, evaluator: evaluator(kind) }, runner }) });
      expect(response.status).toBe(201);
      return await response.json() as { observation: { observation_id: string; answer_payload: JsonValue } };
    };
    const code = await evaluate("code", "deterministic");
    const model = await evaluate("model", "stub_model");
    expect(code.observation.observation_id).not.toBe(model.observation.observation_id);
    expect(code.observation.answer_payload).toMatchObject({ value: true });
    expect(model.observation.answer_payload).toMatchObject({ value: false });

    // (f) A new human grade and a pre-existing operator decision use the normalized grade store.
    const human = await app.request("/v1/grades", { method: "POST", headers: gradeHeaders,
      body: JSON.stringify({ identity: { ...identity, evaluator_definition_id: "slice-human" },
        context: { question, evidence, evaluator: evaluator("human") },
        details: { answer: { state: "answered", kind: "boolean", value: true }, reviewer_id: "operator",
          collection_mode: "in_context", model_answers_visible: false, workflow_decisions_visible: true } }) });
    expect(human.status).toBe(201);
    const preExistingOutcome = { format: "observation.source-event/v1", definition_bundle: null,
      artifact_schema_version: "development-v1", kind: "human_grade", event_kind: "operator_decided",
      run_id: decision.run_id, event_id: decision.id, decision_id: decision.decision_id,
      evaluator: { kind: "human" }, unit: decision.unit_id, review: decision.payload.review,
      decision: decision.payload.decision, target: revisionId(planRow!), feedback: decision.payload.payload,
      effect: decision.effect, decided_at: decision.created_at };
    const before = { source: "review_decision", created_at: new Date(0).toISOString(), id: "" };
    const after = { source: "review_decision", created_at: decision.created_at, id: decision.decision_id };
    const backfill = await app.request("/v1/sources/oakridge/backfill", { method: "POST", headers: ingestHeaders,
      body: JSON.stringify({ previous: before, position: after,
        counts: { review_decision: { active: 1, archived: 0 }, collaboration_thread: { active: 0, archived: 0 } },
        outcome: preExistingOutcome }) });
    expect(backfill.status).toBe(200);
    const backfilledHistory = await app.request(`/v1/items/${encodeURIComponent(planCriterion.occurrence_id)}/grades`,
      { headers: readHeaders });
    const backfilled = (await backfilledHistory.json() as { items: { evaluator: { kind: string };
      observation: { reviewer_id: string; recorded_at: string } }[] }).items.find((grade) =>
      grade.evaluator.kind === "human" && grade.observation.reviewer_id === "oakridge-operator");
    expect(new Date(backfilled!.observation.recorded_at).getTime()).toBe(new Date(decision.created_at).getTime());
    const sourceGrades = await app.request("/v1/sources/oakridge/human-grades", { headers: readHeaders });
    expect((await sourceGrades.json()).items.some((grade: { decision_id: string }) =>
      grade.decision_id === decision.decision_id)).toBe(true);

    // (g) Per-criterion history retains each evaluator's result.
    const history = await app.request(`/v1/items/${encodeURIComponent(briefCriterion.occurrence_id)}/grades`,
      { headers: readHeaders });
    expect(history.status).toBe(200);
    const grades = await history.json() as { total: number; items: { evaluator: { kind: string } }[] };
    expect(grades.total).toBe(3);
    expect(new Set(grades.items.map((grade) => grade.evaluator.kind))).toEqual(new Set(["code", "model", "human"]));

    // (h) The exporter freezes the same occurrence, source revision and evidence IDs it serializes.
    const exported = await app.request("/v1/exports/assay", { method: "POST",
      headers: { ...readHeaders, "content-type": "application/json" },
      body: JSON.stringify({ selection: { run_id: events.run_id, occurrence_ids: null } }) });
    expect(exported.status).toBe(201);
    const result = await exported.json() as { manifest: ExportManifest; files: { data: string; manifest: string } };
    const data = await readFile(result.files.data, "utf8");
    const manifest = JSON.parse(await readFile(result.files.manifest, "utf8")) as ExportManifest;
    const records = data.trim().split("\n").map((line) => JSON.parse(line) as ExportRecord);
    expect(manifest.format_version).toBe("assay-jsonl/v1");
    expect(membershipDigest(manifest.membership)).toEqual({ ok: true, value: manifest.membership_digest });
    expect(manifest.file_hashes["candidates.jsonl"]).toBe(`sha256:${createHash("sha256").update(data).digest("hex")}`);
    expect(records.some((record) => record.occurrence.occurrence_id === briefCriterion.occurrence_id)).toBe(true);
    expect(records.some((record) => record.occurrence.occurrence_id === planCriterion.occurrence_id
      && record.evaluator.kind === "human")).toBe(true);
    for (const record of records) {
      const member = manifest.membership.find((entry) => entry.candidate_id === record.candidate_id)!;
      expect(member.disposition).toBe("included");
      expect(String(member.revision_id)).toBe(record.source_revision.revision_id);
      expect(String(member.evidence_set_id)).toBe(record.evidence_set.evidence_set_id);
      expect(String(member.observation_id)).toBe(record.observation.observation_id);
      expect(record.source_revision.body_digest).toBe(digest(record.source_revision.body));
    }
    const frozen = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.export_membership")
      .select("candidate_id").where("manifest_id", "=", manifest.manifest_id).execute());
    expect(frozen).toHaveLength(manifest.membership.length);
  }); } finally { await rm(exportRoot, { recursive: true, force: true }); }
});
